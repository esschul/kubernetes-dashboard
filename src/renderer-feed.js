'use strict';

let feedEvents = [];
let activeFeedTypes = new Set(['pr', 'pipeline', 'deploy']);

function getFeedDateRange() {
    const fromEl = document.getElementById('feedDateFrom');
    const toEl = document.getElementById('feedDateTo');
    const from = fromEl?.value ? new Date(fromEl.value).getTime() : Date.now() - 24 * 60 * 60 * 1000;
    const to = toEl?.value ? new Date(toEl.value).getTime() + 86399999 : Date.now();
    return { from, to };
}

function initFeedDateRange() {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const fromEl = document.getElementById('feedDateFrom');
    const toEl = document.getElementById('feedDateTo');
    if (fromEl && !fromEl.value) { fromEl.value = yesterday; fromEl.max = today; }
    if (toEl && !toEl.value) { toEl.value = today; }
}

function buildFeedEvents() {
    const { from: cutoff, to: ceiling } = getFeedDateRange();
    const events = [];

    if (latestPrData) {
        const open = latestPrData.pullRequests || [];
        const merged = [...(latestPrData.mergedPullRequests || []), ...(latestPrData.mergedYesterdayPullRequests || []), ...(latestPrData.mergedDependabotPullRequests || [])];
        const allPrs = [...open, ...merged];
        for (const pr of allPrs) {
            const tCreated = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
            if (tCreated >= cutoff && tCreated <= ceiling) {
                events.push({ type: 'pr', label: 'PR opened', time: tCreated, title: pr.title, meta: `${pr.repository} · #${pr.number} · ${pr.author?.login || '?'}`, url: pr.url, success: true });
            }
            if (pr.mergedAt) {
                const tMerged = new Date(pr.mergedAt).getTime();
                if (tMerged >= cutoff && tMerged <= ceiling) {
                    events.push({ type: 'pr', label: 'PR merged', time: tMerged, title: pr.title, meta: `${pr.repository} · #${pr.number} · ${pr.author?.login || '?'}`, url: pr.url, success: true });
                }
            }
        }
    }

    if (window._lastPipelineRuns) {
        const feedConfig = loadConfig();
        const activeTeam = feedConfig.azureTeam || null;
        const teamRuns = activeTeam
            ? window._lastPipelineRuns.filter((r) => r.team === activeTeam)
            : window._lastPipelineRuns;
        for (const run of teamRuns) {
            const t = run.startTime ? new Date(run.startTime).getTime() : 0;
            if (t < cutoff || t > ceiling) continue;
            const failed = run.result === 'failed' || run.result === 'canceled';
            const label = failed ? 'Pipeline failed' : run.result === 'succeeded' ? 'Pipeline passed' : 'Pipeline';
            events.push({ type: 'pipeline', label, time: t, title: run.name, meta: run.sourceBranch || '', url: run.url, success: !failed });
        }
    }

    for (const d of latestDeployments) {
        for (const rollout of (d.rollouts || [])) {
            const t = rollout.deployedAt ? new Date(rollout.deployedAt).getTime() : 0;
            if (t < cutoff || t > ceiling) continue;
            const rev = rollout.revision ? ` · r${rollout.revision}` : '';
            const tag = rollout.imageTag ? ` · ${rollout.imageTag.slice(0, 12)}` : '';
            const branch = rollout.branch ? ` · ${rollout.branch}` : '';
            events.push({ type: 'deploy', label: 'Deployed', time: t, title: d.name, meta: `${d.namespace || ''}${rev}${tag}${branch}`, url: null, success: true });
        }
    }

    events.sort((a, b) => b.time - a.time);
    return events;
}

const FEED_ICONS = {
    pr: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><line x1="6" y1="7" x2="6" y2="17"/><path d="M18 7v4a6 6 0 0 1-6 6H9"/><polyline points="6 14 9 17 6 20"/></svg>`,
    pipeline: `<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>`,
    deploy: `<svg viewBox="0 0 24 24"><path d="M13 2.05V4.07C15.94 4.55 18.5 6.15 20.19 8.5L21.96 7.5C19.96 4.72 17.17 2.8 13 2.05M11 2.06C6.92 2.8 3.96 5.17 2.04 7.5L3.81 8.5C5.5 6.15 8.06 4.55 11 4.07V2.06M2.05 9.5C1.39 11.15 1 12.92 1 14.77C1 16.63 1.4 18.41 2.07 20.06L3.84 19.06C3.31 17.75 3 16.3 3 14.77C3 13.24 3.31 11.79 3.84 10.5L2.05 9.5M21.95 9.5L20.16 10.5C20.69 11.79 21 13.24 21 14.77C21 16.3 20.69 17.75 20.16 19.06L21.93 20.06C22.6 18.41 23 16.63 23 14.77C23 12.92 22.61 11.15 21.95 9.5M12 9A3 3 0 0 0 9 12A3 3 0 0 0 12 15A3 3 0 0 0 15 12A3 3 0 0 0 12 9M12 17C9.25 17 7 18.57 7 20.5V22H17V20.5C17 18.57 14.75 17 12 17Z"/></svg>`,
};

function renderFeed(query) {
    const list = document.getElementById('feedList');
    const q = (query || '').toLowerCase();
    const items = feedEvents.filter((e) =>
        activeFeedTypes.has(e.type) &&
        (!q || e.title.toLowerCase().includes(q) || e.meta.toLowerCase().includes(q))
    );
    if (!items.length) {
        list.innerHTML = '<div class="empty-state">No events found.</div>';
        return;
    }
    list.innerHTML = items.map((e) => {
        const iconClass = e.type === 'pipeline' && !e.success ? 'feed-icon--fail'
            : e.type === 'deploy' && !e.success ? 'feed-icon--fail'
            : `feed-icon--${e.type}`;
        const icon = FEED_ICONS[e.type] || '';
        const titleHtml = e.url
            ? `<span class="feed-title feed-link" data-url="${escapeHtml(e.url)}">${escapeHtml(e.title)}</span>`
            : `<span class="feed-title">${escapeHtml(e.title)}</span>`;
        const cardClass = !e.success ? 'feed-item--fail' : `feed-item--${e.type}`;
        return `<div class="feed-item ${cardClass}">
            <div class="feed-icon ${iconClass}">${icon}</div>
            <div class="feed-body">
                <div class="feed-title-row">${titleHtml}<span class="feed-label feed-label--${e.type}${e.success ? '' : '-fail'}">${escapeHtml(e.label)}</span></div>
                <div class="feed-meta">${escapeHtml(e.meta)}</div>
            </div>
            ${e.time ? `<div class="feed-time">${formatRelativeTime(new Date(e.time).toISOString())}</div>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('.feed-link[data-url]').forEach((el) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => window.kubeDashboard.openExternal(el.dataset.url));
    });
}

async function refreshFeed() {
    const status = document.getElementById('feedStatusPanel');
    status.textContent = 'Loading…';
    feedEvents = buildFeedEvents();
    renderFeed(document.getElementById('feedSearch')?.value);
    const count = feedEvents.filter((e) => e.time > 0).length;
    const { from, to } = getFeedDateRange();
    const fromStr = new Date(from).toLocaleDateString();
    const toStr = new Date(to).toLocaleDateString();
    const rangeStr = fromStr === toStr ? fromStr : `${fromStr} – ${toStr}`;
    status.textContent = `${count} event${count !== 1 ? 's' : ''} in ${rangeStr}`;
}

document.getElementById('feedSearch')?.addEventListener('input', (e) => renderFeed(e.target.value));
document.getElementById('feedRefreshBtn')?.addEventListener('click', () => {
    const btn = document.getElementById('feedRefreshBtn');
    btn.classList.add('is-spinning');
    btn.addEventListener('animationiteration', () => btn.classList.remove('is-spinning'), { once: true });
    refreshFeed();
});

document.querySelectorAll('.filter-chip[data-feed-type]').forEach((chip) => {
    chip.addEventListener('click', () => {
        const type = chip.dataset.feedType;
        if (activeFeedTypes.has(type)) {
            activeFeedTypes.delete(type);
            chip.classList.remove('is-active');
        } else {
            activeFeedTypes.add(type);
            chip.classList.add('is-active');
        }
        feedEvents = buildFeedEvents();
        renderFeed(document.getElementById('feedSearch')?.value);
    });
});

['feedDateFrom', 'feedDateTo'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
        feedEvents = buildFeedEvents();
        renderFeed(document.getElementById('feedSearch')?.value);
        const { from, to } = getFeedDateRange();
        const count = feedEvents.filter((e) => e.time > 0).length;
        const fromStr = new Date(from).toLocaleDateString();
        const toStr = new Date(to).toLocaleDateString();
        const rangeStr = fromStr === toStr ? fromStr : `${fromStr} – ${toStr}`;
        const status = document.getElementById('feedStatusPanel');
        if (status) status.textContent = `${count} event${count !== 1 ? 's' : ''} in ${rangeStr}`;
    });
});
