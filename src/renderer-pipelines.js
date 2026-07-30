'use strict';
/* exported pipelinesRefreshInProgress, refreshPipelines, renderPipelineList */

let pipelinesRefreshInProgress = false;
let activePipelineFilter = 'all';
let pipelineRenderGeneration = 0;
const pipelinePrCache = new Map();
const seenFailedPipelineIds = new Set();
let pipelineNotifyReady = false;

function notifyFailedPipelines(runs) {
    const config = loadConfig();
    if (!config.pipelineNotificationsEnabled) { return; }
    const shouldNotify = pipelineNotifyReady;
    pipelineNotifyReady = true;
    for (const run of runs) {
        if (run.result !== 'failed' || run.status !== 'completed') { continue; }
        if (!seenFailedPipelineIds.has(run.id)) {
            seenFailedPipelineIds.add(run.id);
            if (shouldNotify) {
                const bType = getPipelineBranchType(run);
                new Notification(`Pipeline failed on ${bType}: ${run.name}`, {
                    body: run.team ? `${run.team} · ${run.sourceBranch || ''}` : (run.sourceBranch || ''),
                    silent: false,
                });
            }
        }
    }
}

document.getElementById('pipelineFilterBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip[data-pipeline-filter]');
    if (!chip) { return; }
    activePipelineFilter = chip.dataset.pipelineFilter;
    document.querySelectorAll('.filter-chip[data-pipeline-filter]').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.pipelineFilter === activePipelineFilter);
    });
    if (window._lastPipelineRuns) { renderPipelineList(window._lastPipelineRuns); }
});

async function refreshPipelines() {
    if (pipelinesRefreshInProgress) { return; }
    pipelinesRefreshInProgress = true;
    document.getElementById('pipelinesStatusPanel').textContent = 'Refreshing…';

    const config = loadConfig();
    try {
        const runs = await window.kubeDashboard.fetchPipelineRuns({
            org: config.azureOrg,
            project: config.azureProject,
        });
        renderPipelineList(runs);

        const activeTeam = config.azureTeam || null;
        const teamRuns = activeTeam ? runs.filter((r) => r.team === activeTeam) : runs;
        notifyFailedPipelines(teamRuns);

        const latestByName = new Map();
        for (const r of teamRuns) {
            if (!latestByName.has(r.name)) { latestByName.set(r.name, r); }
        }
        const teamPipelines = [...latestByName.values()];

        const failed = teamPipelines.filter((r) => r.result === 'failed').length;
        const running = teamPipelines.filter((r) => r.status === 'inProgress').length;
        document.getElementById('pipelinesStatusPanel').textContent =
            `${teamPipelines.length} pipeline${teamPipelines.length !== 1 ? 's' : ''} today`;
        setLastUpdated();
        const count = document.getElementById('pipelinesCount');
        const pipelinesNavItem = count?.closest('.nav-item');
        if (pipelinesNavItem) { pipelinesNavItem.dataset.failed = failed > 0 ? '1' : '0'; }
        if (failed > 0) {
            count.textContent = `${failed} failed`;
            count.style.background = '#ffe0de';
            count.style.color = '#b42318';
        } else if (running > 0) {
            count.textContent = `${running} running`;
            count.style.background = '#fff6d9';
            count.style.color = '#856300';
        } else {
            count.textContent = teamPipelines.length;
            count.style.background = '';
            count.style.color = '';
        }
    } catch (err) {
        document.getElementById('pipelineList').innerHTML =
            `<div class="error-panel"><strong>Failed to fetch pipelines</strong><pre>${escapeHtml(err?.message || String(err))}</pre></div>`;
        document.getElementById('pipelinesStatusPanel').textContent = 'Refresh failed';
    } finally {
        pipelinesRefreshInProgress = false;
    }
}

function renderPipelineList(runs) {
    window._lastPipelineRuns = runs;
    if (document.getElementById('feedView') && !document.getElementById('feedView').classList.contains('hidden')) {
        feedEvents = buildFeedEvents();
        renderFeed(document.getElementById('feedSearch')?.value);
    }
    const list = document.getElementById('pipelineList');

    const pConfig = loadConfig();
    const activeTeam = pConfig.azureTeam || null;
    let filtered = activeTeam ? runs.filter((r) => r.team === activeTeam) : runs;

    const _seen = new Set();
    const latestPerPipeline = filtered.filter((r) => {
        if (_seen.has(r.name)) { return false; }
        _seen.add(r.name);
        return true;
    });

    const chipCounts = {
        all: latestPerPipeline.length,
        failed: latestPerPipeline.filter((r) => r.result === 'failed').length,
        succeeded: latestPerPipeline.filter((r) => r.result === 'succeeded').length,
    };
    document.querySelectorAll('.filter-chip[data-pipeline-filter]').forEach((chip) => {
        const span = chip.querySelector('span');
        if (span) { span.textContent = chipCounts[chip.dataset.pipelineFilter] ?? 0; }
    });

    let toShow = latestPerPipeline;
    if (activePipelineFilter === 'failed') {
        toShow = toShow.filter((r) => r.result === 'failed');
    } else if (activePipelineFilter === 'succeeded') {
        toShow = toShow.filter((r) => r.result === 'succeeded');
    }

    if (toShow.length === 0) {
        list.innerHTML = '<p class="empty-state">No pipeline runs today.</p>';
        return;
    }

    const grouped = new Map(toShow.map((r) => [r.name, r]));

    pipelineRenderGeneration++;
    const gen = pipelineRenderGeneration;

    list.innerHTML = [...grouped.values()].map(renderPipelineGroup).join('');

    const pipelineConfig = loadConfig();
    let stagger = 0;
    for (const run of grouped.values()) {
        if (run.result === 'failed') { fetchAndInjectFailedStep(run, pipelineConfig); }
        const hasSha = run.sourceVersion && run.repoName && pipelineConfig.githubOrg;
        const hasPrNumber = run.sourceBranch?.startsWith('PR #') && run.repoName && pipelineConfig.githubOrg;
        if (hasSha || hasPrNumber) {
            const cacheKey = hasSha
                ? `pipeline/${run.repoName}/${run.sourceVersion}`
                : `pipeline/byNumber/${run.repoName}/${run.sourceBranch}`;
            const isCached = pipelinePrCache.has(cacheKey);
            setTimeout(() => fetchAndInjectPipelinePr(run, gen, pipelineConfig), isCached ? 0 : stagger);
            if (!isCached) { stagger += 400; }
        } else {
            const card = list.querySelector(`.pipeline-card[data-id="${run.id}"]`);
            if (card) { card.querySelector('.pr-row')?.remove(); }
        }
    }
}

async function fetchAndInjectFailedStep(run, config) {
    try {
        const result = await window.kubeDashboard.fetchFailedStep({
            org: config.azureOrg,
            project: config.azureProject,
            buildId: run.id,
        });
        if (!result) { return; }
        const card = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
        if (!card) { return; }
        const metaRow = card.querySelector('.pipeline-meta-row');
        if (metaRow) {
            const el = document.createElement('span');
            el.className = 'pipeline-failed-step';
            el.textContent = `Failed at: ${result.stepName}`;
            metaRow.appendChild(el);
        }

        if (!result.logUrl) { return; }
        const errors = await window.kubeDashboard.fetchLogErrors({
            org: config.azureOrg,
            logUrl: result.logUrl,
        });
        if (!errors.length) { return; }
        const freshCard = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
        if (!freshCard) { return; }
        const errDiv = document.createElement('details');
        errDiv.className = 'pipeline-errors';
        errDiv.innerHTML = `<summary class="pipeline-errors-summary">${errors.length} error${errors.length !== 1 ? 's' : ''}<button class="copy-errors-btn" title="Copy errors to clipboard">Copy</button></summary>`
            + errors.map((e) => `<div class="pipeline-error-line">${escapeHtml(e)}</div>`).join('');
        errDiv.dataset.errors = JSON.stringify(errors);
        freshCard.appendChild(errDiv);
    } catch { /* ignore */ }
}

async function fetchAndInjectPipelinePr(run, gen, config) {
    const hasSha = run.sourceVersion && run.repoName;
    const prNumberMatch = run.sourceBranch?.match(/^PR #(\d+)$/);
    const cacheKey = hasSha
        ? `pipeline/${run.repoName}/${run.sourceVersion}`
        : `pipeline/byNumber/${run.repoName}/${run.sourceBranch}`;

    const card = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
    if (!card) { return; }

    if (pipelinePrCache.has(cacheKey)) {
        const cached = pipelinePrCache.get(cacheKey);
        if (cached) {
            injectPipelinePrRow(card, cached, run.sourceVersion);
        } else {
            card.querySelector('.pr-row')?.remove();
        }
        return;
    }

    try {
        let pr = hasSha
            ? await window.kubeDashboard.fetchPrForSha(run.sourceVersion, run.repoName, config.githubOrg)
            : null;
        if (!pr && prNumberMatch) {
            pr = await window.kubeDashboard.fetchPrByNumber(prNumberMatch[1], run.repoName, config.githubOrg);
        }
        pipelinePrCache.set(cacheKey, pr);
        if (gen !== pipelineRenderGeneration) { return; }
        const freshCard = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
        if (!freshCard) { return; }
        if (pr) {
            injectPipelinePrRow(freshCard, pr, run.sourceVersion);
        } else {
            freshCard.querySelector('.pr-row')?.remove();
        }
    } catch {
        const c = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
        c?.querySelector('.pr-row')?.remove();
    }
}

function injectPipelinePrRow(card, pr, sha) {
    const existing = card.querySelector('.pr-row');
    const html = renderPrRow(pr, sha);
    if (existing) {
        existing.innerHTML = html;
        existing.classList.remove('pr-row--loading');
    } else {
        const row = document.createElement('div');
        row.className = 'pr-row';
        row.innerHTML = html;
        card.querySelector('.deployment-card-top').insertAdjacentElement('afterend', row);
    }
    card.dataset.prNumber = pr.number;
    card.dataset.prTitle = pr.title || '';
    card.dataset.prUrl = pr.url || '';

    const placeholder = card.querySelector('.trello-placeholder');
    if (placeholder) {
        if (pr.trelloUrl) {
            const trello = document.createElement('span');
            trello.className = 'trello-link';
            trello.dataset.url = pr.trelloUrl;
            trello.textContent = 'Trello ↗';
            placeholder.replaceWith(trello);
        } else {
            placeholder.remove();
        }
    }
}

function renderPipelineGroup(run) {
    const statusClass = getPipelineStatusClass(run);
    const statusLabel = getPipelineStatusLabel(run);
    const startLabel = run.startTime ? formatRelativeTime(run.startTime) : '—';
    const startAbsolute = run.startTime ? new Date(run.startTime).toLocaleTimeString() : '';
    const duration = run.finishTime && run.startTime
        ? formatDuration(new Date(run.finishTime) - new Date(run.startTime))
        : null;

    const config = loadConfig();
    const hasSha = run.sourceVersion && run.repoName && config.githubOrg;
    const prNumberMatch = run.sourceBranch?.match(/^PR #(\d+)$/);
    const prGhUrl = prNumberMatch && run.repoName && config.githubOrg
        ? `https://github.com/${config.githubOrg}/${run.repoName}/pull/${prNumberMatch[1]}`
        : null;

    const isFailed = run.result === 'failed' && run.status === 'completed';
    const branchType = isFailed ? getPipelineBranchType(run) : null;
    const branchBadge = branchType === 'master'
        ? `<span class="branch-type-badge branch-type-badge--master">master</span>`
        : branchType === 'branch'
        ? `<span class="branch-type-badge branch-type-badge--branch">branch</span>`
        : '';

    return `
    <div class="pipeline-card" data-id="${run.id}" data-build-id="${run.id}">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <h3>${escapeHtml(run.name)}</h3>
                ${branchBadge}
            </div>
            <div class="deployment-pill-row">
                <span class="trello-placeholder"></span>
                <span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
                <span class="age-pill" title="${escapeHtml(startAbsolute)}">${escapeHtml(startLabel)}</span>
                ${isFailed ? `<button class="pipeline-rerun-btn" title="Rerun failed jobs">↺ Rerun failed jobs</button>` : ''}
                <span class="pipeline-link datadog-link" data-url="${escapeHtml(run.url)}">Pipeline ↗</span>
            </div>
        </div>
        ${hasSha ? `<div class="pr-row pr-row--loading"><span class="pr-loading">Loading commit info…</span></div>` : ''}
        <div class="pipeline-meta-row">
            ${run.sourceBranch ? (prGhUrl
                ? `<span class="branch-pill pipeline-link" data-url="${escapeHtml(prGhUrl)}">${escapeHtml(run.sourceBranch)} ↗</span>`
                : `<span class="branch-pill">${escapeHtml(run.sourceBranch)}</span>`)
            : ''}
            ${run.trigger && run.trigger !== run.sourceBranch ? `<span class="pipeline-meta-text">${escapeHtml(run.trigger)}</span>` : ''}
            ${duration ? `<span class="pipeline-meta-text">${escapeHtml(duration)}</span>` : ''}
        </div>
    </div>`;
}
