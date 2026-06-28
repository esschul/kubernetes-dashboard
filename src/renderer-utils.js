'use strict';
/* exported escapeHtml, getStatusLabel, getImageTag, formatRelativeTime, getAgePillClass, formatDuration, isFailingStatus, getPipelineBranchType, getPipelineStatusClass, getPipelineStatusLabel, parseLogLine, logLineMatchesFilter */

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
    };
}
