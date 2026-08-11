'use strict';
/* exported updateFilterCounts, renderDeploymentList, renderPrRow, matchesFilter, depHasTrello */

function updateFilterCounts(deployments) {
    const counts = {
        all: deployments.length,
        healthy: deployments.filter((d) => d.status === 'healthy').length,
        failing: deployments.filter((d) => isFailingStatus(d.status)).length,
        progressing: deployments.filter((d) => d.status === 'progressing').length,
        'has-trello': deployments.filter(depHasTrello).length,
    };
    document.querySelectorAll('.filter-chip[data-filter]').forEach((chip) => {
        const count = counts[chip.dataset.filter] ?? 0;
        let span = chip.querySelector('span');
        if (!span) {
            span = document.createElement('span');
            chip.appendChild(span);
        }
        span.textContent = count;
    });
}

function renderDeploymentList(deployments) {
    const list = document.getElementById('deploymentList');
    updateFilterCounts(deployments);
    const filtered = deployments.filter(matchesFilter);

    if (filtered.length === 0) {
        const msg = deployments.length === 0
            ? 'No deployments found. Check your context and namespace in Settings.'
            : 'No deployments match the current filter.';
        list.innerHTML = `<p class="empty-state">${msg}</p>`;
        return;
    }

    const gen = ++renderGeneration;
    const isGrid = list.classList.contains('is-grid');
    list.innerHTML = filtered.map(isGrid ? renderGridCard : renderDeploymentCard).join('');

    let delay = 0;
    for (const dep of filtered) {
        if (!dep.gitSha || !/^[0-9a-f]{7,}/i.test(dep.gitSha)) { continue; }
        const cacheKey = `${dep.name}/${dep.gitSha}`;
        if (prCache.has(cacheKey)) {
            fetchAndInjectPr(dep, gen);
        } else {
            setTimeout(() => fetchAndInjectPr(dep, gen), delay);
            delay += 400;
        }
    }
}

async function fetchAndInjectPr(dep, gen) {
    const cacheKey = `${dep.name}/${dep.gitSha}`;
    const cardKey = `${dep.namespace}/${dep.name}`;
    const card = document.querySelector(`.deployment-card[data-name="${CSS.escape(cardKey)}"]`);
    if (!card || gen !== renderGeneration) { return; }
    if (card.dataset.sha !== dep.gitSha) { return; }

    if (prCache.has(cacheKey)) {
        const cached = prCache.get(cacheKey);
        if (cached) {
            injectPrRow(card, cached, dep.gitSha);
        } else {
            card.querySelector('.pr-row')?.remove();
        }
        return;
    }

    const config = loadConfig();
    if (!config.githubOrg) {
        card.querySelector('.pr-row')?.remove();
        return;
    }

    try {
        const pr = await window.kubeDashboard.fetchPrForSha(dep.gitSha, dep.imageRepoName, config.githubOrg);
        prCache.set(cacheKey, pr);
        if (pr) {
            injectPrRow(card, pr, dep.gitSha);
            if (pr.trelloUrl) { updateFilterCounts(latestDeployments); }
        } else {
            card.querySelector('.pr-row')?.remove();
        }
    } catch (err) {
        const row = card.querySelector('.pr-row');
        if (row) {
            const errStr = String(err?.message ?? err ?? '');
            const isRateLimit = errStr.includes('rate limit') || errStr.includes('403');
            row.innerHTML = `<span class="pr-loading">${isRateLimit ? '⏱ GitHub rate limit — will retry on next refresh' : 'Could not load commit info'}</span>`;
        }
    }
}

function injectPrRow(card, pr, sha) {
    const isGrid = card.classList.contains('deployment-card--grid');

    if (isGrid) {
        const section = card.querySelector('.grid-pr-section');
        if (section) {
            const mergedLabel = pr.mergedAt ? formatRelativeTime(pr.mergedAt) : '';
            const mergedSuffix = mergedLabel ? ` <span class="grid-pr-meta">${escapeHtml(mergedLabel)}</span>` : '';
            section.classList.remove('pr-row--loading');
            section.innerHTML = `<span class="grid-pr-intro">Last change was merged by <strong>${escapeHtml(pr.author)}</strong>:${mergedSuffix}</span>
                <span class="grid-pr-title" data-url="${escapeHtml(pr.url)}">"${escapeHtml(pr.title)}"</span>`;
        }
    } else {
        const existing = card.querySelector('.pr-row');
        if (existing) {
            existing.innerHTML = renderPrRow(pr, sha);
            existing.classList.remove('pr-row--loading');
        } else {
            const row = document.createElement('div');
            row.className = 'pr-row';
            row.innerHTML = renderPrRow(pr, sha);
            card.querySelector('.deployment-card-top').insertAdjacentElement('afterend', row);
        }
    }

    const placeholder = card.querySelector('.trello-placeholder');
    if (placeholder && pr.trelloUrl) {
        const trello = document.createElement('span');
        trello.className = isGrid ? 'grid-action-btn grid-action-btn--external trello-link' : 'trello-link';
        trello.dataset.url = pr.trelloUrl;
        trello.textContent = 'Trello ↗';
        placeholder.replaceWith(trello);
    } else if (placeholder) {
        placeholder.remove();
    }
}

function renderPrRow(pr, sha) {
    const shortSha = sha ? sha.slice(0, 8) : '';
    const mergedLabel = pr.mergedAt ? `Merged ${formatRelativeTime(pr.mergedAt)}` : pr.state;
    return `
        <div class="pr-row-link" data-url="${escapeHtml(pr.url)}">
            <span class="pr-title">${escapeHtml(pr.title)}</span>
            <span class="pr-meta">#${pr.number} · ${escapeHtml(pr.author)} · ${escapeHtml(mergedLabel)} · <code>${escapeHtml(shortSha)}</code></span>
        </div>`;
}

function getDatadogLogsUrl(serviceName) {
    const config = loadConfig();
    if (!config.datadogSite || !serviceName) { return null; }
    const envContexts = config.envContexts || {};
    const activeContext = config.context || '';
    let env = 'prod';
    if (activeContext && activeContext === envContexts.qa) { env = 'qa'; }
    else if (activeContext && activeContext === envContexts.test) { env = 'test'; }
    else if (activeContext && activeContext === envContexts.prod) { env = 'prod'; }
    const query = encodeURIComponent(`env:${env} service:${serviceName}`);
    return `${config.datadogSite}/logs?query=${query}&live=true&stream_sort=desc&viz=stream`;
}

function getPodStatusClass(status) {
    if (status === 'Running') { return 'is-running'; }
    if (status === 'Pending' || status === 'ContainerCreating' || status === 'PodInitializing') { return 'is-pending'; }
    if (status === 'Completed' || status === 'Succeeded') { return 'is-completed'; }
    return 'is-error';
}

function renderFailures(failures) {
    const items = failures.slice(0, 5).map((f) => {
        if (f.type === 'crash-loop') {
            return `<li><span class="failure-label">CrashLoopBackOff</span> · ${escapeHtml(f.container)} in ${escapeHtml(f.pod)} · ${f.restarts} restart${f.restarts !== 1 ? 's' : ''}</li>`;
        }
        if (f.type === 'oom') {
            return `<li><span class="failure-label">OOMKilled</span> · ${escapeHtml(f.container)} in ${escapeHtml(f.pod)} · ${f.restarts} restart${f.restarts !== 1 ? 's' : ''}</li>`;
        }
        if (f.type === 'image-pull') {
            return `<li><span class="failure-label">ImagePullBackOff</span> · ${escapeHtml(f.message)}</li>`;
        }
        if (f.type === 'event') {
            const countLabel = f.count > 1 ? ` (×${f.count})` : '';
            return `<li>${escapeHtml(f.message)}${countLabel}</li>`;
        }
        return `<li>${escapeHtml(f.message)}</li>`;
    });
    const more = failures.length > 5 ? `<li>…and ${failures.length - 5} more</li>` : '';
    return `<div class="failures-list"><strong>Issues detected</strong><ul>${items.join('')}${more}</ul></div>`;
}

function renderPodTable(dep) {
    if (dep.pods.length === 0) { return '<p class="pod-empty">No pods found</p>'; }
    const rows = dep.pods.map((pod) => {
        const statusClass = getPodStatusClass(pod.status);
        const age = pod.startTime ? formatRelativeTime(pod.startTime) : '—';
        const restartLabel = pod.restarts > 0
            ? `<span class="pod-restarts">${pod.restarts} restart${pod.restarts !== 1 ? 's' : ''}</span>`
            : '';
        return `<div class="pod-row">
            <span class="pod-name">${escapeHtml(pod.name)}</span>
            <span class="pod-status ${statusClass}">${escapeHtml(pod.status)}</span>
            ${restartLabel}
            <span class="pod-age">${age}</span>
        </div>`;
    }).join('');
    return `<div class="pod-table">${rows}</div>`;
}

function renderRolloutHistory(rollouts, repoName) {
    if (!rollouts.length) { return '<p class="pod-empty">No rollout history available.</p>'; }
    return `<div class="rollout-table">${rollouts.map((r) => {
        const time = r.deployedAt ? new Date(r.deployedAt).toLocaleString() : '—';
        const rel = r.deployedAt ? formatRelativeTime(r.deployedAt) : '';
        const rev = r.revision ? `<span class="rollout-rev">r${r.revision}</span>` : '';
        const sha = r.releaseCommit || '';
        const prAttr = sha && repoName ? ` data-sha="${escapeHtml(sha)}" data-repo="${escapeHtml(repoName)}"` : '';
        const isLocalBuild = r.imageTag?.startsWith('local-build-');
        let infoContent;
        if (isLocalBuild) {
            const avatarHtml = r.deployedBy
                ? `<img class="rollout-avatar" data-login="${escapeHtml(r.deployedBy)}" src="" alt="${escapeHtml(r.deployedBy)}" style="display:none">`
                : '';
            const parts = [];
            if (r.branch) { parts.push(`<span class="rollout-local-branch">${escapeHtml(r.branch)}</span>`); }
            if (r.deployedBy) { parts.push(`<span class="rollout-local-by">${escapeHtml(r.deployedBy)}</span>`); }
            infoContent = `${avatarHtml}${parts.join(' ')}`;
        } else {
            infoContent = `<span class="rollout-pr-title">${sha ? 'Loading…' : ''}</span>`;
        }
        const rollbackBtn = (!r.isCurrent && r.revision && !isLocalBuild)
            ? `<button class="rollout-rollback-btn" data-revision="${escapeHtml(r.revision)}">Roll back</button>`
            : '';
        return `<div class="rollout-row${r.isCurrent ? ' is-current' : ''}${isLocalBuild ? ' is-local-build' : ''}"${prAttr}>
            ${rev}
            <span class="rollout-time" title="${escapeHtml(time)}">${rel}</span>
            <span class="rollout-action">${r.isCurrent ? '<span class="rollout-current">current</span>' : ''}${rollbackBtn}</span>
            <span class="rollout-pr">${infoContent}</span>
        </div>`;
    }).join('')}</div>`;
}

function renderGridCard(dep) {
    const statusClass = dep.status.replace(/[^a-z-]/g, '');
    const deployedLabel = dep.deployedAt ? formatRelativeTime(dep.deployedAt) : '—';
    const deployedAbsolute = dep.deployedAt ? new Date(dep.deployedAt).toLocaleString() : '';
    const datadogUrl = getDatadogLogsUrl(dep.name);
    const podCount = dep.pods.length;
    const healthyCount = dep.pods.filter((p) => getPodStatusClass(p.status) === 'pod-status--running').length;
    const hasHistory = dep.rollouts?.length > 0;
    const hasDatadog = !!datadogUrl;
    const imageTag = getImageTag(dep.image);
    const isLocalBuild = imageTag && imageTag.startsWith('local-build');
    const hasPr = !isLocalBuild && dep.gitSha && /^[0-9a-f]{7,}/i.test(dep.gitSha);

    const latestRollout = dep.rollouts?.[0];
    const localBranch = latestRollout?.branch || '';
    const localBy = latestRollout?.deployedBy || '';

    const isProgressing = dep.status === 'progressing';
    const podNames = dep.pods.map((p) => {
        const sc = getPodStatusClass(p.status);
        const isRunning = sc === 'pod-status--running';
        return `<span class="grid-pod-chip ${isRunning ? 'grid-pod-chip--running' : 'grid-pod-chip--pending'}" title="${escapeHtml(p.name)}">${escapeHtml(p.name.replace(/^.*-([^-]+-[^-]+)$/, '$1'))}</span>`;
    }).join('');

    let podLine;
    if (podCount === 0) {
        podLine = `<p class="grid-card-pods"><span class="grid-card-status is-failing">No pods running</span></p>`;
    } else if (isProgressing) {
        podLine = `<p class="grid-card-pods"><span class="grid-card-status is-progressing grid-rolling-label">Rolling out…</span> ${healthyCount}/${podCount} ready</p>`;
    } else if (dep.status === 'failing' || dep.status === 'error') {
        podLine = `<p class="grid-card-pods">Running with ${podCount} pod${podCount !== 1 ? 's' : ''} — <span class="grid-card-status is-${escapeHtml(statusClass)}">${escapeHtml(dep.status)}</span></p>`;
    } else {
        podLine = `<p class="grid-card-pods">Currently running with ${podCount} <span class="grid-card-status is-${podCount === healthyCount ? 'healthy' : escapeHtml(statusClass)}">${podCount === healthyCount ? 'healthy' : escapeHtml(dep.status)}</span> pod${podCount !== 1 ? 's' : ''}</p>`;
    }
    const podChips = podCount > 0 ? `<details class="grid-pod-details"><summary class="grid-pod-summary">Pods</summary><div class="grid-pod-chips">${podNames}</div></details>` : '';

    let prSection;
    if (isLocalBuild) {
        prSection = `<div class="grid-pr-section">
            <span class="grid-pr-intro">Local build${localBy ? ` by <strong>${escapeHtml(localBy)}</strong>` : ''}</span>
            ${localBranch ? `<span class="grid-pr-title">${escapeHtml(localBranch)}</span>` : ''}
        </div>`;
    } else {
        prSection = `<div class="grid-pr-section pr-row pr-row--loading">
            ${hasPr ? `<span class="pr-loading">Loading…</span>` : ''}
        </div>`;
    }

    const logsSvg = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:inline;vertical-align:-1px;margin-right:4px"><rect x="2" y="2" width="12" height="2" rx="1" fill="currentColor"/><rect x="2" y="7" width="9" height="2" rx="1" fill="currentColor"/><rect x="2" y="12" width="11" height="2" rx="1" fill="currentColor"/></svg>`;
    const restartSvg = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" style="display:inline;vertical-align:-1px"><path d="M13.5 8A5.5 5.5 0 1 1 8 2.5V1l3 2.5L8 6V4.5a3.5 3.5 0 1 0 3.5 3.5h2z" fill="currentColor"/></svg>`;

    return `
    <div class="deployment-card deployment-card--grid${isProgressing ? ' is-rolling-out' : ''}" data-name="${escapeHtml(dep.namespace + '/' + dep.name)}" data-dep-name="${escapeHtml(dep.name)}" data-sha="${escapeHtml(dep.gitSha || '')}">
        <div class="grid-card-age" title="${escapeHtml(deployedAbsolute)}">Last updated <strong>${escapeHtml(deployedLabel)}</strong></div>
        <div class="grid-card-eyebrow">${escapeHtml(dep.namespace || '')}</div>
        <h3 class="grid-card-name">${escapeHtml(dep.name)}</h3>
        ${podLine}
        ${podChips}
        ${prSection}
        <hr class="grid-card-divider">
        ${dep.failures?.length > 0 && dep.status !== 'healthy' ? `<button class="grid-issues-btn" data-dep-name="${escapeHtml(dep.name)}">⚠ ${dep.failures.length} issue${dep.failures.length !== 1 ? 's' : ''}</button>` : ''}
        <div class="grid-card-actions">
            ${hasDatadog ? `<span class="grid-action-btn grid-action-btn--external datadog-link" data-url="${escapeHtml(datadogUrl)}">Datadog ↗</span>` : ''}
            <span class="trello-placeholder"></span>
            <button class="grid-action-btn logs-open-btn" data-dep-name="${escapeHtml(dep.name)}">${logsSvg}Logs</button>
            <button class="grid-action-btn restart-btn" data-dep-name="${escapeHtml(dep.name)}">Restart ${restartSvg}</button>
            ${hasHistory ? `<button class="grid-action-btn grid-history-btn">History</button>` : ''}
        </div>
        <div class="rollout-history hidden">${renderRolloutHistory(dep.rollouts || [], dep.imageRepoName)}</div>
    </div>`;
}

function renderDeploymentCard(dep) {
    const statusClass = dep.status.replace(/[^a-z-]/g, '');
    const statusLabel = getStatusLabel(dep.status);
    const deployedLabel = dep.deployedAt ? formatRelativeTime(dep.deployedAt) : 'unknown';
    const deployedAbsolute = dep.deployedAt ? new Date(dep.deployedAt).toLocaleString() : '';
    const agePillClass = getAgePillClass(dep.deployedAt);
    const imageTag = getImageTag(dep.image);
    const isLocalBuild = imageTag && imageTag.startsWith('local-build');
    const failuresHtml = dep.failures.length > 0 && dep.status !== 'healthy' ? renderFailures(dep.failures) : '';
    const datadogUrl = getDatadogLogsUrl(dep.name);

    return `
    <div class="deployment-card" data-name="${escapeHtml(dep.namespace + '/' + dep.name)}" data-dep-name="${escapeHtml(dep.name)}" data-sha="${escapeHtml(dep.gitSha || '')}">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <h3>${escapeHtml(dep.name)}</h3>
                ${isLocalBuild ? `<span class="local-build-badge" title="${escapeHtml(dep.image || '')}">local build</span>` : ''}
            </div>
            <div class="deployment-pill-row">
                <span class="trello-placeholder"></span>
                <button class="logs-open-btn" data-dep-name="${escapeHtml(dep.name)}">Logs</button>
                ${datadogUrl ? `<span class="datadog-link" data-url="${escapeHtml(datadogUrl)}">Datadog ↗</span>` : ''}
                <span class="status-pill is-${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span>
                <span class="age-pill ${agePillClass}" title="${escapeHtml(deployedAbsolute)}">${escapeHtml(deployedLabel)}</span>
                ${dep.rollouts?.length > 0 ? `<button class="rollout-history-btn" title="Show rollout history">History</button>` : ''}
                <span class="expand-chevron">›</span>
            </div>
        </div>
        ${dep.gitSha && /^[0-9a-f]{7,}/i.test(dep.gitSha) ? `<div class="pr-row pr-row--loading"><span class="pr-loading">Loading commit info…</span></div>` : ''}
        ${failuresHtml}
        <div class="rollout-history hidden">
            ${renderRolloutHistory(dep.rollouts || [], dep.imageRepoName)}
        </div>
        <div class="pod-expand hidden">
            <div class="pod-expand-header">
                <button class="restart-btn" data-dep-name="${escapeHtml(dep.name)}">Restart deployment</button>
            </div>
            ${renderPodTable(dep)}
        </div>
    </div>`;
}
