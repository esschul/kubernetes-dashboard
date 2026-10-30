'use strict';
/* exported escapeHtml, getStatusLabel, getImageTag, formatRelativeTime, getAgePillClass, formatDuration, isFailingStatus, getPipelineBranchType, getPipelineStatusClass, getPipelineStatusLabel, parseLogLine, logLineMatchesFilter, getLocalDateKey, isDependabotPr, isIacPr, getTrelloCardFromBranch, groupTrelloCards */

function getTrelloCardFromBranch(branch) {
    const match = /^(.+)_([A-Za-z0-9]{8})$/.exec(branch || '');
    return match ? { id: match[2], slug: match[1], url: `https://trello.com/c/${match[2]}` } : null;
}

const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot[bot]', 'dependabot']);
function isDependabotPr(pr) { return DEPENDABOT_LOGINS.has(pr.author?.login); }

// GitHub GraphQL returns 'iac-tfupdate[bot]', REST returns 'app/iac-tfupdate'
const IAC_BOT_LOGINS = new Set(['iac-tfupdate[bot]', 'app/iac-tfupdate', 'iac-tfupdate']);
function isIacPr(pr) { return IAC_BOT_LOGINS.has(pr.author?.login); }

function getLocalDateKey(value) {
    const d = value ? new Date(value) : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function escapeHtml(str) {
    if (!str) { return ''; }
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getStatusLabel(status) {
    const labels = {
        healthy: 'Healthy',
        progressing: 'Progressing',
        'crash-loop': 'CrashLoopBackOff',
        error: 'Error',
        failed: 'Failed',
        unavailable: 'Unavailable',
        'scaled-down': 'Scaled down',
    };
    return labels[status] || status;
}

function getImageTag(image) {
    if (!image) { return null; }
    const parts = image.split(':');
    const tag = parts.length >= 2 ? parts[parts.length - 1] : null;
    if (!tag) { return null; }
    if (/^[0-9a-f]{12,}$/i.test(tag)) { return tag.slice(0, 8); }
    return tag;
}

function formatRelativeTime(isoString) {
    const now = Date.now();
    const then = new Date(isoString).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) { return 'just now'; }
    if (diffMin < 60) { return `${diffMin}m ago`; }
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) { return `${diffH}h ago`; }
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
}

function getAgePillClass(isoString) {
    if (!isoString) { return 'age-pill is-none'; }
    const diffH = (Date.now() - new Date(isoString).getTime()) / 3_600_000;
    if (diffH < 1) { return 'age-pill is-fresh'; }
    if (diffH < 24) { return 'age-pill is-notice'; }
    if (diffH < 72) { return 'age-pill is-warning'; }
    return 'age-pill is-critical';
}

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) { return `${seconds}s`; }
    return `${minutes}m ${seconds}s`;
}

function isFailingStatus(status) {
    return ['error', 'crash-loop', 'failed', 'unavailable'].includes(status);
}

function getPipelineBranchType(run) {
    const branch = run.sourceBranch || '';
    if (/^PR #\d+$/.test(branch)) { return 'branch'; }
    if (branch === 'master' || branch === 'main') { return 'master'; }
    if (run.trigger === 'Batched CI' || run.trigger === 'Commit') {
        return (branch && branch !== 'master' && branch !== 'main') ? 'branch' : 'master';
    }
    if (branch && branch !== 'master' && branch !== 'main') { return 'branch'; }
    return 'master';
}

function getPipelineStatusClass(run) {
    if (run.status === 'inProgress' || run.status === 'notStarted') { return 'is-progressing'; }
    if (run.result === 'succeeded') { return 'is-healthy'; }
    if (run.result === 'failed') { return 'is-failed'; }
    if (run.result === 'canceled') { return 'is-scaled-down'; }
    if (run.result === 'partiallySucceeded') { return 'is-progressing'; }
    return 'is-none';
}

function getPipelineStatusLabel(run) {
    if (run.status === 'inProgress') { return 'Running'; }
    if (run.status === 'notStarted') { return 'Queued'; }
    if (run.status === 'cancelling') { return 'Cancelling'; }
    if (run.result === 'succeeded') { return 'Succeeded'; }
    if (run.result === 'failed') { return 'Failed'; }
    if (run.result === 'canceled') { return 'Canceled'; }
    if (run.result === 'partiallySucceeded') { return 'Partial'; }
    return run.status || '—';
}

function parseLogLine(raw) {
    const prefixMatch = raw.match(/^\[[\w/-]+\]\s*/);
    const prefix = prefixMatch ? prefixMatch[0] : '';
    const stripped = raw.slice(prefix.length);
    const m = stripped.match(/^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[^Z]*Z)\s([\s\S]*)$/);
    if (m) {
        const localTs = new Date(m[1]).toLocaleTimeString('no', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        return { ts: localTs, msg: prefix + m[3], raw };
    }
    return { ts: '', msg: raw, raw };
}

function logLineMatchesFilter(raw, filter) {
    const needle = String(filter || '').trim().toLowerCase();
    if (!needle) { return true; }
    const { ts, msg } = parseLogLine(String(raw || ''));
    return `${raw || ''}\n${ts} ${msg}`.toLowerCase().includes(needle);
}

function groupTrelloCards({ lists, cards }, { open = [], merged = [] }, { hiddenListIds = new Set(), commentLinks = () => [] } = {}) {
    const byUrl = new Map();
    const byCard = new Map();
    for (const [pr, isMerged] of [...open.map((p) => [p, false]), ...merged.map((p) => [p, true])]) {
        const entry = { pr, merged: isMerged };
        byUrl.set(pr.url, entry);
        const card = getTrelloCardFromBranch(pr.headRefName);
        if (!card) { continue; }
        if (!byCard.has(card.id)) { byCard.set(card.id, new Set()); }
        byCard.get(card.id).add(pr.url);
    }
    const shortLinkOf = (card) => /trello\.com\/c\/([A-Za-z0-9]+)/.exec(card.shortUrl || '')?.[1];
    return [...lists].reverse().filter((list) => !hiddenListIds.has(list.id)).map((list) => ({
        list,
        groups: cards.filter((card) => card.idList === list.id).map((card) => {
            const urls = new Set(byCard.get(shortLinkOf(card)) || []);
            const linked = [];
            for (const link of commentLinks(card)) {
                if (byUrl.has(link.url)) { urls.add(link.url); } else { linked.push(link); }
            }
            const entries = [...urls].map((url) => byUrl.get(url));
            return {
                card,
                open: entries.filter((e) => !e.merged).map((e) => e.pr).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
                merged: entries.filter((e) => e.merged).map((e) => e.pr).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt))),
                linked,
            };
        }),
    }));
}

if (typeof module !== 'undefined') {
    module.exports = {
        escapeHtml,
        getStatusLabel,
        getImageTag,
        formatRelativeTime,
        getAgePillClass,
        formatDuration,
        isFailingStatus,
        getPipelineBranchType,
        getPipelineStatusClass,
        getPipelineStatusLabel,
        parseLogLine,
        logLineMatchesFilter,
        isDependabotPr,
        isIacPr,
        getLocalDateKey,
        getTrelloCardFromBranch,
        groupTrelloCards,
    };
}
