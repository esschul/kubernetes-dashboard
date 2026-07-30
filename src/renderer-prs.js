'use strict';
/* exported latestPrData, prRefreshInProgress, isDependabotPr, fetchAvatar, refreshPullRequests, renderPrView */

let prRefreshInProgress = false;
let activePrTab = 'open';
let activePrFilter = 'all';
let latestPrData = null;
const seenPrKeys = new Set();
const approvedPrKeys = new Set();
const avatarCache = new Map();

const DEPENDABOT_LOGIN = 'app/dependabot';

const BOT_AVATAR_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="pr-avatar-bot-icon"><rect x="3" y="8" width="18" height="13" rx="3" stroke="currentColor" stroke-width="1.5"/><path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="9" cy="14" r="1.5" fill="currentColor"/><circle cx="15" cy="14" r="1.5" fill="currentColor"/><path d="M8 18h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12 3v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function isDependabotPr(pr) { return pr.author?.login === DEPENDABOT_LOGIN; }

const MANIFEST_FILES = [
    // npm
    { manifest: 'package.json', locks: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] },
    // Python
    { manifest: 'requirements.txt', locks: ['poetry.lock', 'Pipfile.lock'] },
    { manifest: 'pyproject.toml', locks: ['poetry.lock', 'Pipfile.lock'] },
    { manifest: 'Pipfile', locks: ['Pipfile.lock'] },
    // PHP
    { manifest: 'composer.json', locks: ['composer.lock'] },
    // Gradle
    { manifest: 'build.gradle', locks: ['gradle.lockfile'] },
    { manifest: 'build.gradle.kts', locks: ['gradle.lockfile'] },
];

function analyzeDependabotPr(pr) {
    const warnings = [];
    const title = pr.title || '';
    const files = (pr.files || []).map((f) => (typeof f === 'string' ? f : f.path || f.filename || ''));

    // Detect major version bump from title: "Bump X from A to B"
    const bumpMatch = title.match(/bump .+ from (\d+)\.\S+ to (\d+)\./i);
    if (bumpMatch) {
        const fromMajor = parseInt(bumpMatch[1], 10);
        const toMajor = parseInt(bumpMatch[2], 10);
        if (toMajor > fromMajor) { warnings.push({ type: 'major', label: 'Major bump', level: 'danger' }); }
    }

    // Detect new dependency (no "from X to Y" in title)
    const isUpdate = /\bfrom\s+\S+\s+to\s+/i.test(title);
    if (!isUpdate && /\badd\b|\bnew\b/i.test(title)) {
        warnings.push({ type: 'new-dep', label: 'New dep', level: 'warning' });
    }

    // Detect missing lock file
    for (const { manifest, locks } of MANIFEST_FILES) {
        const hasManifest = files.some((f) => f === manifest || f.endsWith(`/${manifest}`));
        if (hasManifest) {
            const hasLock = locks.some((lock) => files.some((f) => f === lock || f.endsWith(`/${lock}`)));
            if (!hasLock) {
                warnings.push({ type: 'no-lock', label: 'No lock file', level: 'warning' });
                break;
            }
        }
    }

    return warnings;
}

function getLocalDateKey(value) {
    const date = value ? new Date(value) : new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function fetchAvatar(login) {
    if (avatarCache.has(login)) { return avatarCache.get(login); }
    try {
        const data = await window.kubeDashboard.fetchGithubUser(login);
        const url = data?.avatar_url || null;
        avatarCache.set(login, url);
        return url;
    } catch {
        avatarCache.set(login, null);
        return null;
    }
}

function notifyNewPrs(pullRequests) {
    const config = loadConfig();
    if (!config.notificationsEnabled) { return; }
    const isFirstFetch = seenPrKeys.size === 0;
    for (const pr of pullRequests) {
        if (isDependabotPr(pr)) { continue; }
        const key = `${pr.repository}/${pr.number}`;
        if (!seenPrKeys.has(key)) {
            seenPrKeys.add(key);
            if (!isFirstFetch) {
                new Notification(`New PR: ${pr.repository}`, {
                    body: `#${pr.number} ${pr.title}`,
                    silent: false,
                });
            }
        }
    }
}

document.getElementById('prTabSwitcher').addEventListener('click', (e) => {
    const btn = e.target.closest('.env-btn[data-pr-tab]');
    if (!btn) { return; }
    activePrTab = btn.dataset.prTab;
    document.querySelectorAll('.env-btn[data-pr-tab]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.prTab === activePrTab);
    });
    activePrFilter = 'all';
    document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.prFilter === 'all');
    });
    if (latestPrData) { renderPrView(latestPrData); }
});

document.getElementById('prFilterBar').addEventListener('click', (e) => {
    if (e.target.closest('#prFilterExpand')) {
        document.getElementById('prFilterBar').classList.toggle('filter-bar-expanded');
        e.stopPropagation();
        return;
    }
    const chip = e.target.closest('.filter-chip[data-pr-filter]');
    if (!chip) { return; }
    activePrFilter = chip.dataset.prFilter;
    document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.prFilter === activePrFilter);
    });
    document.getElementById('prFilterBar').classList.remove('filter-bar-expanded');
    if (latestPrData) { renderPrView(latestPrData); }
});

function renderMarkdown(text) {
    if (!text) { return ''; }
    // Extract real <a> tags before escaping, replace with placeholders
    const links = [];
    const withoutLinks = text
        .replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, label) => {
            const i = links.length;
            links.push({ url, label: label.replace(/<[^>]+>/g, '') });
            return `\x00link${i}\x00`;
        })
        // strip remaining <a> tags (relative hrefs etc), keep their text
        .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1')
        // strip <details>/<summary> tags, keep their text
        .replace(/<\/?details[^>]*>/gi, '')
        .replace(/<summary>([\s\S]*?)<\/summary>/gi, '\n**$1**\n');

    const escaped = withoutLinks
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return escaped
        // restore real HTML links
        .replace(/\x00link(\d+)\x00/g, (_, i) => {
            const { url, label } = links[Number(i)];
            return `<a href="${url}" class="pr-comment-link" data-url="${url}">${escapeHtml(label)}</a>`;
        })
        // markdown links [text](url)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, t, u) => `<a href="${u}" class="pr-comment-link" data-url="${u}">${t}</a>`)
        // bare URLs
        .replace(/(?<![="'(])(https?:\/\/[^\s<>"')\]]+)/g, (u) => `<a href="${u}" class="pr-comment-link" data-url="${u}">${u}</a>`)
        // headings ## / ###
        .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>')
        // bold **text**
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // inline code `code`
        .replace(/`([^`]+)`/g, '<code class="pr-comment-code">$1</code>')
        // markdown table separator rows (|----|) → skip
        .replace(/^\|[-| :]+\|$/gm, '')
        // markdown table rows → grid cells
        .replace(/^\|(.*)\|$/gm, (_, row) => {
            const cells = row.split('|').map((c) => c.trim());
            return `<span class="pr-comment-table-row">${cells.map((c) => `<span class="pr-comment-table-cell">${c}</span>`).join('')}</span>`;
        })
        // newlines
        .replace(/\n/g, '<br>')
        // remove <br> immediately before/after table rows
        .replace(/(<br>)+(<span class="pr-comment-table-row")/g, '$2')
        .replace(/(<\/span>)(<br>)+/g, '$1')
        // collapse multiple consecutive <br> into two max
        .replace(/(<br>){3,}/g, '<br><br>');
}

function renderCommentsList(comments) {
    if (comments.length === 0) { return '<p class="pr-comments-empty">No comments yet.</p>'; }
    return comments.map((c) => {
        const date = c.createdAt ? new Date(c.createdAt).toLocaleString('no', { dateStyle: 'short', timeStyle: 'short' }) : '';
        const author = c.author?.login || c.author?.name || 'unknown';
        const typeLabel = c.type === 'review' ? ' · review' : '';
        return `<div class="pr-comment">
            <div class="pr-comment-header"><span class="pr-comment-author">${escapeHtml(author)}${typeLabel}</span><span class="pr-comment-date">${escapeHtml(date)}</span></div>
            <div class="pr-comment-body">${renderMarkdown(c.body || '')}</div>
        </div>`;
    }).join('');
}

async function showPrCommentsModal(prKey) {
    const allPrs = [...(latestPrData?.pullRequests || []), ...(latestPrData?.dependabotPullRequests || [])];
    const pr = allPrs.find((p) => `${p.repository}/${p.number}` === prKey);
    if (!pr) { return; }

    const comments = [
        ...(pr.comments || []).map((c) => ({ ...c, type: 'comment' })),
        ...(pr.reviews || []).filter((r) => String(r.body || '').trim()).map((r) => ({ ...r, createdAt: r.submittedAt || r.createdAt, type: 'review' })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    let modal = document.getElementById('prCommentsModal');
    if (!modal) {
        modal = document.createElement('dialog');
        modal.id = 'prCommentsModal';
        modal.className = 'pr-comments-modal';
        modal.innerHTML = '<div class="pr-comments-inner"><button class="pr-comments-close" id="prCommentsClose">✕</button><h3 class="pr-comments-title" id="prCommentsTitle"></h3><div class="pr-comments-list" id="prCommentsList"></div></div>';
        document.body.appendChild(modal);
        modal.addEventListener('click', (e) => {
            const link = e.target.closest('.pr-comment-link[data-url]');
            if (link) { e.preventDefault(); window.kubeDashboard.openExternal(link.dataset.url); }
        });
        document.getElementById('prCommentsClose').addEventListener('click', () => modal.close());
    }

    document.getElementById('prCommentsTitle').textContent = `#${pr.number} ${pr.title} — ${comments.length} comment${comments.length !== 1 ? 's' : ''}`;
    const list = document.getElementById('prCommentsList');

    const commitPlaceholder = pr.headRefOid
        ? `<div class="pr-comment pr-comment--commit pr-comment--loading"><div class="pr-comment-header"><span class="pr-comment-author">Commit message</span></div><div class="pr-comment-body">Loading…</div></div>`
        : '';
    list.innerHTML = commitPlaceholder + renderCommentsList(comments);
    modal.showModal();

    if (pr.headRefOid) {
        try {
            const commit = await window.kubeDashboard.fetchCommitMessage(pr.repository, pr.headRefOid);
            const commitEl = list.querySelector('.pr-comment--commit');
            if (commitEl) {
                const date = commit.date ? new Date(commit.date).toLocaleString('no', { dateStyle: 'short', timeStyle: 'short' }) : '';
                commitEl.classList.remove('pr-comment--loading');
                commitEl.innerHTML = `<div class="pr-comment-header"><span class="pr-comment-author">Commit · ${escapeHtml(commit.author || '')}</span><span class="pr-comment-date">${escapeHtml(date)}</span></div><div class="pr-comment-body">${renderMarkdown(commit.message || '')}</div>`;
            }
        } catch {
            const commitEl = list.querySelector('.pr-comment--commit');
            if (commitEl) { commitEl.remove(); }
        }
    }
}

document.getElementById('prList').addEventListener('click', (e) => {
    const commentsPill = e.target.closest('.pr-comments-pill');
    if (commentsPill) {
        e.stopPropagation();
        showPrCommentsModal(commentsPill.dataset.prKey);
        return;
    }
    const copyBtn = e.target.closest('.copy-errors-btn');
    if (copyBtn) {
        e.stopPropagation();
        const errDiv = copyBtn.closest('.pipeline-errors');
        const card = copyBtn.closest('.pr-card');
        const errors = errDiv?.dataset.errors ? JSON.parse(errDiv.dataset.errors) : [];
        const prUrl = card?.dataset.url || '';
        const prTitle = card?.querySelector('h3')?.textContent || '';
        const prMeta = card?.querySelector('.pr-meta')?.textContent || '';
        const header = [prTitle, prMeta, prUrl].filter(Boolean).join('\n');
        navigator.clipboard.writeText([header, ...errors].filter(Boolean).join('\n'));
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        return;
    }
    if (e.target.closest('.pipeline-errors')) { e.stopPropagation(); return; }
    const link = e.target.closest('.pr-pipeline-link[data-url]');
    if (link) {
        e.stopPropagation();
        window.kubeDashboard.openExternal(link.dataset.url);
        return;
    }
    const approveBtn = e.target.closest('.pr-approve-btn');
    if (approveBtn) {
        e.stopPropagation();
        const row = approveBtn.closest('.pr-actions-row');
        const prNumber = Number(row.dataset.prNumber);
        const repoFullName = row.dataset.prRepo;
        approveBtn.disabled = true;
        approveBtn.textContent = 'Approving…';
        window.kubeDashboard.approvePr({ repoFullName, prNumber }).then((res) => {
            if (res.ok) {
                approvedPrKeys.add(`${repoFullName}/${prNumber}`);
                row.innerHTML = `
                    <select class="pr-merge-method-select">
                        <option value="squash" selected>Squash</option>
                        <option value="merge">Merge</option>
                        <option value="rebase">Rebase</option>
                    </select>
                    <button class="pr-action-btn pr-merge-btn">Merge</button>`;
            } else {
                approveBtn.disabled = false;
                approveBtn.textContent = 'Approve';
                approveBtn.title = res.error || 'Failed to approve';
            }
        });
        return;
    }
    if (e.target.closest('.pr-merge-method-select')) { e.stopPropagation(); return; }
    const mergeBtn = e.target.closest('.pr-merge-btn');
    if (mergeBtn) {
        e.stopPropagation();
        const row = mergeBtn.closest('.pr-actions-row');
        const prNumber = Number(row.dataset.prNumber);
        const repoFullName = row.dataset.prRepo;
        const method = row.querySelector('.pr-merge-method-select')?.value || 'squash';
        mergeBtn.disabled = true;
        mergeBtn.textContent = 'Merging…';
        window.kubeDashboard.mergePr({ repoFullName, prNumber, method }).then((res) => {
            if (res.ok) {
                row.innerHTML = '<span class="pr-action-done">Merged ✓</span>';
            } else {
                mergeBtn.disabled = false;
                mergeBtn.textContent = 'Merge';
                mergeBtn.title = res.error || 'Failed to merge';
            }
        });
        return;
    }
    const card = e.target.closest('.pr-card[data-url]');
    if (card) { window.kubeDashboard.openExternal(card.dataset.url); }
});

async function refreshPullRequests(force = false) {
    if (prRefreshInProgress) { return; }
    if (latestPrData && !force) { renderPrView(latestPrData); return; }

    const config = loadConfig();
    const prTopic = config.githubTopic || config.namespace;
    if (!config.githubOrg || !prTopic) {
        document.getElementById('prList').innerHTML = '<p class="empty-state">Set GitHub org and namespace in Settings to load pull requests.</p>';
        document.getElementById('prStatusPanel').textContent = 'Not configured';
        return;
    }

    prRefreshInProgress = true;
    document.getElementById('prStatusPanel').textContent = 'Loading…';

    try {
        const data = await window.kubeDashboard.fetchPullRequests({
            org: config.githubOrg,
            topic: prTopic,
            watchedRepos: config.githubWatchedRepos || [],
            namespace: config.namespace,
        });
        notifyNewPrs(data.pullRequests);
        latestPrData = data;
        renderPrView(data);
        if (document.getElementById('feedView') && !document.getElementById('feedView').classList.contains('hidden')) {
            feedEvents = buildFeedEvents();
            renderFeed(document.getElementById('feedSearch')?.value);
        }
        document.getElementById('prStatusPanel').textContent = `${data.repositories.length} repo${data.repositories.length !== 1 ? 's' : ''}`;
        setLastUpdated();
        updatePrNavCount(data);
    } catch (err) {
        document.getElementById('prList').innerHTML = `<div class="error-panel"><strong>Failed to load pull requests</strong><pre>${escapeHtml(err?.message || String(err))}</pre></div>`;
        document.getElementById('prStatusPanel').textContent = 'Refresh failed';
    } finally {
        prRefreshInProgress = false;
    }
}

function updatePrNavCount(data) {
    const count = document.getElementById('pullRequestsCount');
    count.textContent = data.pullRequests.length;
    count.style.background = '';
    count.style.color = '';

    const tabCounts = {
        tabCountOpen: data.pullRequests.length,
        tabCountMerged: (data.mergedPullRequests?.length || 0) + (data.mergedDependabotPullRequests?.length || 0),
        tabCountMergedYesterday: (data.mergedYesterdayPullRequests?.length || 0) + (data.mergedYesterdayDependabotPullRequests?.length || 0),
        tabCountDependabot: data.dependabotPullRequests?.length || 0,
    };
    for (const [id, n] of Object.entries(tabCounts)) {
        const el = document.getElementById(id);
        if (el) { el.textContent = n; }
    }
}

function getPrsForTab(data) {
    if (activePrTab === 'merged') { return [...data.mergedPullRequests, ...data.mergedDependabotPullRequests]; }
    if (activePrTab === 'merged-yesterday') { return [...(data.mergedYesterdayPullRequests || []), ...(data.mergedYesterdayDependabotPullRequests || [])]; }
    if (activePrTab === 'dependabot') { return data.dependabotPullRequests; }
    return data.pullRequests;
}

function matchesPrFilter(pr) {
    if (activePrFilter === 'human') { return !isDependabotPr(pr); }
    if (activePrFilter === 'dependabot') { return isDependabotPr(pr); }
    if (activePrFilter === 'opened-today') { return getLocalDateKey(pr.createdAt) === getLocalDateKey(); }
    if (activePrFilter === 'approved') { return pr.reviewDecision === 'APPROVED' && !pr.isDraft; }
    if (activePrFilter === 'changes-requested') { return pr.reviewDecision === 'CHANGES_REQUESTED' && !pr.isDraft; }
    if (activePrFilter === 'draft') { return Boolean(pr.isDraft); }
    if (activePrFilter === 'checks-passing') { return pr.checkStatus === 'success'; }
    if (activePrFilter === 'checks-failing') { return pr.checkStatus === 'failure'; }
    return true;
}

function getPrReviewLabel(pr) {
    if (pr.isDraft) { return 'Draft'; }
    return { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' }[pr.reviewDecision] || 'Open';
}

function getPrReviewClass(pr) {
    if (pr.isDraft) { return 'is-draft'; }
    return { APPROVED: 'is-approved', CHANGES_REQUESTED: 'is-changes-requested', REVIEW_REQUIRED: 'is-pending' }[pr.reviewDecision] || 'is-open';
}

function getPrAgeDetails(createdAt) {
    if (!createdAt) { return null; }
    const hours = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 3_600_000));
    const days = Math.floor(hours / 24);
    if (hours < 24) { return null; }
    const label = `${days}d old`;
    const cssClass = days >= 14 ? 'is-critical' : days >= 7 ? 'is-warning' : 'is-notice';
    return { cssClass, label };
}

function getPipelineStatusForPr(pr) {
    const runs = window._lastPipelineRuns;
    if (!runs) { return null; }
    const prNumber = pr.number;
    const mergedAt = pr.mergedAt ? new Date(pr.mergedAt) : null;

    const prMatching = runs.filter((r) => r.sourceBranch === `PR #${prNumber}` || r.trigger === `PR #${prNumber}`);
    if (prMatching.length) {
        const latest = prMatching.sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
        if (latest.status === 'inProgress') { return { label: 'Pipeline running', cls: 'is-progressing', url: latest.url }; }
        if (latest.result === 'succeeded') { return { label: 'Pipeline passed', cls: 'is-healthy', url: latest.url }; }
        if (latest.result === 'failed') { return { label: 'Pipeline failed', cls: 'is-failed', url: latest.url }; }
        if (latest.result === 'canceled') { return { label: 'Pipeline canceled', cls: 'is-scaled-down', url: latest.url }; }
    }

    if (mergedAt) {
        const repoShort = pr.repository?.split('/').pop()?.toLowerCase();
        const postMerge = runs.filter((r) => {
            if (!repoShort) { return false; }
            const runRepo = (r.repoName || '').toLowerCase();
            if (runRepo !== repoShort) { return false; }
            const runTime = r.startTime ? new Date(r.startTime) : null;
            return runTime && runTime >= mergedAt;
        }).sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        if (postMerge.length) {
            const latest = postMerge[0];
            if (latest.status === 'inProgress') { return { label: 'Pipeline running', cls: 'is-progressing', url: latest.url }; }
            if (latest.result === 'succeeded') { return { label: 'Pipeline passed', cls: 'is-healthy', url: latest.url }; }
            if (latest.result === 'failed') { return { label: 'Pipeline failed', cls: 'is-failed', url: latest.url }; }
            if (latest.result === 'canceled') { return { label: 'Pipeline canceled', cls: 'is-scaled-down', url: latest.url }; }
        }
    }

    return null;
}

function getDeploymentStatusForPr(pr) {
    if (!latestDeployments.length) { return null; }
    const repoName = pr.repository?.split('/').pop()?.toLowerCase();
    if (!repoName) { return null; }
    const dep = latestDeployments.find((d) => d.imageRepoName?.toLowerCase() === repoName);
    if (!dep) { return null; }
    const statusLabel = getStatusLabel(dep.status);
    const cls = dep.status === 'healthy' ? 'is-healthy' :
        dep.status === 'progressing' ? 'is-progressing' : 'is-failed';
    return { label: `Deployed · ${statusLabel}`, cls };
}

function renderPrView(data) {
    const list = document.getElementById('prList');
    const prs = getPrsForTab(data);
    const isMergedTab = activePrTab === 'merged' || activePrTab === 'merged-yesterday';
    const isDependabotTab = activePrTab === 'dependabot';

    const filterBar = document.getElementById('prFilterBar');
    filterBar.style.display = '';
    const openOnlyFilters = ['opened-today', 'approved', 'changes-requested', 'draft', 'checks-passing', 'checks-failing'];
    const mergedOnlyFilters = ['human', 'dependabot'];
    document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((chip) => {
        const f = chip.dataset.prFilter;
        if (isMergedTab) {
            chip.style.display = openOnlyFilters.includes(f) ? 'none' : '';
        } else {
            chip.style.display = mergedOnlyFilters.includes(f) ? 'none' : '';
        }
    });

    const counts = {
        'all': prs.length,
        'human': prs.filter((p) => !isDependabotPr(p)).length,
        'dependabot': prs.filter((p) => isDependabotPr(p)).length,
        'opened-today': prs.filter((p) => getLocalDateKey(p.createdAt) === getLocalDateKey()).length,
        'approved': prs.filter((p) => p.reviewDecision === 'APPROVED' && !p.isDraft).length,
        'changes-requested': prs.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED' && !p.isDraft).length,
        'draft': prs.filter((p) => p.isDraft).length,
        'checks-passing': prs.filter((p) => p.checkStatus === 'success').length,
        'checks-failing': prs.filter((p) => p.checkStatus === 'failure').length,
    };
    document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((chip) => {
        const span = chip.querySelector('span');
        if (span) { span.textContent = counts[chip.dataset.prFilter] ?? 0; }
    });

    const filtered = activePrFilter === 'all' ? prs : prs.filter(matchesPrFilter);

    if (filtered.length === 0) {
        const msg = activePrTab === 'merged' ? 'No pull requests merged today.' :
            activePrTab === 'merged-yesterday' ? 'No pull requests merged yesterday.' :
            isDependabotTab ? 'No open Dependabot pull requests.' :
                activePrFilter === 'all' ? 'No open pull requests.' : 'No pull requests match this filter.';
        list.innerHTML = `<p class="empty-state">${msg}</p>`;
        return;
    }

    const sorted = [...filtered].sort((a, b) => {
        const ta = isMergedTab ? String(a.mergedAt) : String(a.updatedAt);
        const tb = isMergedTab ? String(b.mergedAt) : String(b.updatedAt);
        return tb.localeCompare(ta);
    });
    list.innerHTML = sorted.map((pr) => renderPrCard(pr, isMergedTab)).join('');

    const config = loadConfig();
    if (config.showPrAvatars) {
        const placeholders = list.querySelectorAll('.pr-avatar--placeholder[data-login]');
        for (const el of placeholders) {
            const login = el.dataset.login;
            fetchAvatar(login).then((url) => {
                if (!url) { return; }
                const img = document.createElement('img');
                img.className = 'pr-avatar';
                img.src = url;
                img.alt = login;
                el.replaceWith(img);
            });
        }
    }
    if (config.azureOrg && config.azureProject && window._lastPipelineRuns) {
        for (const pr of sorted) {
            if (pr.checkStatus === 'failure') { injectPrPipelineErrors(pr, config); }
        }
    }
}

async function injectPrPipelineErrors(pr, config) {
    const runs = window._lastPipelineRuns;
    if (!runs) { return; }

    const matching = runs.filter((r) =>
        (r.sourceBranch === `PR #${pr.number}` || r.trigger === `PR #${pr.number}`) &&
        r.result === 'failed' && r.status === 'completed'
    ).sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    if (!matching.length) { return; }
    const run = matching[0];

    const card = document.querySelector(`.pr-card[data-url="${CSS.escape(pr.url)}"]`);
    if (!card) { return; }

    const result = await window.kubeDashboard.fetchFailedStep({
        org: config.azureOrg,
        project: config.azureProject,
        buildId: run.id,
    });
    if (!result?.stepName) { return; }

    const freshCard = document.querySelector(`.pr-card[data-url="${CSS.escape(pr.url)}"]`);
    if (!freshCard) { return; }

    const cardBody = freshCard.querySelector('.pr-card-body') || freshCard;
    const metaRow = cardBody.querySelector('.pr-meta-row');
    if (metaRow && !cardBody.querySelector('.pr-pipeline-failed-step')) {
        const el = document.createElement('span');
        el.className = 'pipeline-failed-step pr-pipeline-failed-step';
        el.textContent = `Pipeline: ${run.name} · Failed at: ${result.stepName}`;
        metaRow.insertAdjacentElement('afterend', el);
    }

    if (!result.logUrl) { return; }
    const errors = await window.kubeDashboard.fetchLogErrors({
        org: config.azureOrg,
        logUrl: result.logUrl,
    });
    if (!errors.length) { return; }

    const finalCard = document.querySelector(`.pr-card[data-url="${CSS.escape(pr.url)}"]`);
    if (!finalCard || finalCard.querySelector('.pipeline-errors')) { return; }

    const errDiv = document.createElement('details');
    errDiv.className = 'pipeline-errors';
    errDiv.dataset.errors = JSON.stringify(errors);
    errDiv.innerHTML = `<summary class="pipeline-errors-summary">${errors.length} error${errors.length !== 1 ? 's' : ''}<button class="copy-errors-btn" title="Copy errors to clipboard">Copy</button></summary>`
        + errors.map((e) => `<div class="pipeline-error-line">${escapeHtml(e)}</div>`).join('');
    (finalCard.querySelector('.pr-card-body') || finalCard).appendChild(errDiv);
}

function renderPrCard(pr, isMerged = false) {
    const reviewLabel = isMerged ? 'Merged' : getPrReviewLabel(pr);
    const reviewClass = isMerged ? 'is-merged' : getPrReviewClass(pr);
    const checkClass = { success: 'is-success', failure: 'is-failure', pending: 'is-pending', none: 'is-none' }[pr.checkStatus] || 'is-none';
    const dateLabel = isMerged ? `Merged ${formatRelativeTime(pr.mergedAt)}` : `Updated ${formatRelativeTime(pr.updatedAt)}`;
    const ageDetails = isMerged ? null : getPrAgeDetails(pr.createdAt);

    const pipelineStatus = getPipelineStatusForPr(pr);
    const deploymentStatus = isMerged ? getDeploymentStatusForPr(pr) : null;
    const pipelineLink = pipelineStatus?.url
        ? `<span class="datadog-link pr-pipeline-link" data-url="${escapeHtml(pipelineStatus.url)}">Pipeline ↗</span>`
        : '';

    const prKey = `${pr.repository}/${pr.number}`;
    const isApproved = approvedPrKeys.has(prKey) || pr.reviewDecision === 'APPROVED';
    const showActions = !isMerged && isDependabotPr(pr) && pr.checkStatus === 'success';
    const actionsHtml = showActions ? `
        <div class="pr-actions-row" data-pr-number="${pr.number}" data-pr-repo="${escapeHtml(pr.repository)}">
            ${!isApproved ? `<button class="pr-action-btn pr-approve-btn">Approve</button>` : `
            <select class="pr-merge-method-select">
                <option value="squash" selected>Squash</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
            </select>
            <button class="pr-action-btn pr-merge-btn">Merge</button>`}
        </div>` : '';

    const config = loadConfig();
    const showAvatars = config.showPrAvatars ?? true;
    const login = pr.author?.login || 'unknown';
    const isBot = isDependabotPr(pr);
    const cachedAvatar = showAvatars && !isBot ? avatarCache.get(login) : null;
    const avatarHtml = showAvatars ? `
        <div class="pr-avatar-col">
            ${isBot
                ? `<div class="pr-avatar pr-avatar--bot">${BOT_AVATAR_SVG}</div>`
                : cachedAvatar
                    ? `<img class="pr-avatar" src="${escapeHtml(cachedAvatar)}" alt="${escapeHtml(login)}" />`
                    : `<div class="pr-avatar pr-avatar--placeholder" data-login="${escapeHtml(login)}"></div>`}
            <span class="pr-avatar-name" title="${escapeHtml(isBot ? 'dependabot' : login)}">${escapeHtml(isBot ? 'dependabot' : login)}</span>
        </div>` : '';

    return `
    <div class="pr-card deployment-card${showAvatars ? ' pr-card--with-avatar' : ''}" data-url="${escapeHtml(pr.url)}">
        ${avatarHtml}
        <div class="pr-card-body">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <span class="eyebrow-inline">${escapeHtml(pr.repository)}</span>
                <h3>${escapeHtml(pr.title)}</h3>
            </div>
            <div class="deployment-pill-row">
                ${pipelineLink}
                <span class="check-pill ${checkClass}">${escapeHtml(pr.checkStatusLabel || 'No checks')}</span>
                <span class="status-pill ${reviewClass}">${escapeHtml(reviewLabel)}</span>
            </div>
        </div>
        <div class="pr-meta-row">
            <span class="pr-meta">#${pr.number} · ${escapeHtml(dateLabel)}</span>
            ${ageDetails ? `<span class="age-pill ${ageDetails.cssClass}">${escapeHtml(ageDetails.label)}</span>` : ''}
            ${pr.headRefOid ? `<span class="branch-pill pr-comments-pill" data-pr-key="${escapeHtml(pr.repository + '/' + pr.number)}" style="cursor:pointer">${pr.commentActivityCount > 0 ? `${pr.commentActivityCount} comment${pr.commentActivityCount !== 1 ? 's' : ''}` : 'Description'}</span>` : ''}
            ${isDependabotPr(pr) ? analyzeDependabotPr(pr).map((w) => `<span class="dep-warn-pill dep-warn-pill--${w.level}">${escapeHtml(w.label)}</span>`).join('') : ''}
        </div>
        ${(pipelineStatus && isMerged) || deploymentStatus ? `
        <div class="pr-infra-row">
            ${pipelineStatus && isMerged ? `<span class="pr-infra-item"><span class="pr-infra-label">Pipeline</span><span class="status-pill ${pipelineStatus.cls}">${escapeHtml(pipelineStatus.label.replace('Pipeline ', ''))}</span></span>` : ''}
            ${deploymentStatus ? `<span class="pr-infra-item"><span class="pr-infra-label">Deployment</span><span class="status-pill ${deploymentStatus.cls}">${escapeHtml(deploymentStatus.label.replace('Deployed · ', ''))}</span></span>` : ''}
        </div>` : ''}
        ${actionsHtml}
        </div>
    </div>`;
}
