'use strict';

const STORAGE_KEYS = {
    config: 'kube-dashboard:config',
    activeFilter: 'kube-dashboard:filter',
    sidebarCollapsed: 'kube-dashboard:sidebar-collapsed',
    theme: 'kube-dashboard:theme',
};

// --- State ---
let activeFilter = readStoredJson(STORAGE_KEYS.activeFilter, 'all');
let refreshInProgress = false;
let latestDeployments = [];
const prCache = new Map(); // key: `${depName}/${gitSha}` → pr object or null
let renderGeneration = 0;  // incremented on every render; guards stale async injections

// --- Storage helpers ---
function readStoredJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function loadConfig() {
    return readStoredJson(STORAGE_KEYS.config, { context: '', namespace: '' });
}

function saveConfig(config) {
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(config));
}

// --- Theme ---
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeToggle').textContent = theme === 'dark' ? '☀' : '☾';
}

const storedTheme = localStorage.getItem(STORAGE_KEYS.theme) || 'light';
applyTheme(storedTheme);

document.getElementById('themeToggle').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEYS.theme, next);
    applyTheme(next);
});

// --- Sidebar collapse ---
const appShell = document.getElementById('appShell');
const sidebarToggle = document.getElementById('sidebarToggle');

if (readStoredJson(STORAGE_KEYS.sidebarCollapsed, false)) {
    appShell.classList.add('is-sidebar-collapsed');
    sidebarToggle.textContent = '›';
}

sidebarToggle.addEventListener('click', () => {
    const collapsed = appShell.classList.toggle('is-sidebar-collapsed');
    sidebarToggle.textContent = collapsed ? '›' : '‹';
    localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, JSON.stringify(collapsed));
});

// --- Navigation ---
document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
        switchView(btn.dataset.view);
    });
});

function switchView(view) {
    document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach((el) => {
        el.classList.toggle('hidden', el.id !== `${view}View`);
    });
    if (view === 'settings') {
        populateSettingsForm();
        loadClusterSettingsIfEmpty();
    }
    if (view === 'deployments' && !latestDeployments.length) {
        refresh();
    }
    if (view === 'pipelines') {
        refreshPipelines();
    }
    if (view === 'pull-requests') {
        refreshPullRequests();
    }
}

// --- Filter bar ---
document.querySelectorAll('.filter-chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
        activeFilter = chip.dataset.filter;
        localStorage.setItem(STORAGE_KEYS.activeFilter, JSON.stringify(activeFilter));
        document.querySelectorAll('.filter-chip[data-filter]').forEach((c) => {
            c.classList.toggle('is-active', c.dataset.filter === activeFilter);
        });
        renderDeploymentList(latestDeployments);
    });
});

// Restore active filter chip
document.querySelectorAll('.filter-chip[data-filter]').forEach((c) => {
    c.classList.toggle('is-active', c.dataset.filter === activeFilter);
});

// --- Settings form ---
function populateSettingsForm() {
    const config = loadConfig();
    ensureSelectOption('contextInput', config.context || '');
    ensureSelectOption('namespaceInput', config.namespace || '');
    document.getElementById('githubOrgInput').value = config.githubOrg || '';
    document.getElementById('githubTopicInput').value = config.githubTopic || '';
    document.getElementById('azureOrgInput').value = config.azureOrg || '';
    document.getElementById('azureProjectInput').value = config.azureProject || '';
    document.getElementById('envProdInput').value = config.envContexts?.prod || '';
    document.getElementById('envQaInput').value = config.envContexts?.qa || '';
    document.getElementById('envTestInput').value = config.envContexts?.test || '';
}

document.getElementById('contextInput').addEventListener('change', () => {
    loadNamespacesForSelectedContext().catch((err) => {
        setStatus(`Could not load namespaces: ${err?.message || String(err)}`);
    });
});

async function loadClusterSettingsIfEmpty() {
    const contextSelect = document.getElementById('contextInput');
    try {
        const currentValue = contextSelect.value;
        const contexts = await window.kubeDashboard.fetchContexts();
        const options = [new Option('(current context)', ''),
            ...contexts.map((ctx) => new Option(`${ctx.isCurrent ? '* ' : '  '}${ctx.name}`, ctx.name))];
        contextSelect.replaceChildren(...options);
        contextSelect.value = currentValue || '';

        // Populate env mapping selects — read saved values from config, not from the (empty) selects
        const savedConfig = loadConfig();
        const envMap = { envProdInput: savedConfig.envContexts?.prod, envQaInput: savedConfig.envContexts?.qa, envTestInput: savedConfig.envContexts?.test };
        for (const [id, savedValue] of Object.entries(envMap)) {
            const sel = document.getElementById(id);
            sel.replaceChildren(new Option('(none)', ''),
                ...contexts.map((ctx) => new Option(ctx.name, ctx.name)));
            sel.value = savedValue || '';
        }

        await loadNamespacesForSelectedContext();
    } catch (err) {
        setStatus(`Could not load kubectl settings: ${err?.message || String(err)}`);
    }
}

function renderEnvSwitcher(config) {
    const switcher = document.getElementById('envSwitcher');
    const envs = config?.envContexts || {};
    const buttons = Object.entries({ Prod: envs.prod, QA: envs.qa, Test: envs.test })
        .filter(([, ctx]) => ctx);

    if (buttons.length === 0) { switcher.innerHTML = ''; return; }

    switcher.innerHTML = buttons.map(([label, ctx]) => {
        const isActive = (config?.context || '') === ctx;
        return `<button class="env-btn ${isActive ? 'is-active' : ''}" data-context="${escapeHtml(ctx)}">${label}</button>`;
    }).join('');
}

document.getElementById('envSwitcher').addEventListener('click', (e) => {
    const btn = e.target.closest('.env-btn');
    if (!btn) { return; }
    const config = loadConfig();
    config.context = btn.dataset.context;
    saveConfig(config);
    updateContextLabel(config);
    renderEnvSwitcher(config);
    refresh();
});

async function loadNamespacesForSelectedContext() {
    const context = document.getElementById('contextInput').value;
    const currentNamespace = document.getElementById('namespaceInput').value;
    const namespaces = await window.kubeDashboard.fetchNamespaces({ context });
    replaceSelectOptions('namespaceInput', namespaces, '(select a namespace)', currentNamespace);
}

function replaceSelectOptions(id, values, emptyLabel, selectedValue) {
    const select = document.getElementById(id);
    select.replaceChildren(new Option(emptyLabel, ''));
    for (const value of values) {
        select.appendChild(new Option(value, value));
    }
    if (selectedValue) { ensureSelectOption(id, selectedValue); }
    select.value = selectedValue || '';
}

function ensureSelectOption(id, value) {
    const select = document.getElementById(id);
    if (!value) {
        select.value = '';
        return;
    }
    if (![...select.options].some((option) => option.value === value)) {
        select.appendChild(new Option(value, value));
    }
    select.value = value;
}

document.getElementById('saveSettings').addEventListener('click', () => {
    const config = {
        context: document.getElementById('contextInput').value,
        namespace: document.getElementById('namespaceInput').value,
        githubOrg: document.getElementById('githubOrgInput').value.trim(),
        githubTopic: document.getElementById('githubTopicInput').value.trim(),
        azureOrg: document.getElementById('azureOrgInput').value.trim(),
        azureProject: document.getElementById('azureProjectInput').value.trim(),
        envContexts: {
            prod: document.getElementById('envProdInput').value,
            qa: document.getElementById('envQaInput').value,
            test: document.getElementById('envTestInput').value,
        },
    };
    saveConfig(config);
    updateContextLabel(config);
    renderEnvSwitcher(config);
    if (!config.namespace) {
        setStatus('Set a namespace in Settings before refreshing deployments.');
        return;
    }
    switchView('deployments');
    refresh();
});

function updateContextLabel(config) {
    const label = document.getElementById('contextLabel');
    const parts = [];
    if (config.context) { parts.push(config.context); }
    if (config.namespace) { parts.push(config.namespace); }
    label.textContent = parts.length ? parts.join(' / ') : 'Current context';
}

// --- Refresh logic ---
document.getElementById('refreshButton').addEventListener('click', () => {
    if (!refreshInProgress) { refresh(); }
});

async function refresh() {
    if (refreshInProgress) { return; }
    const config = loadConfig();
    if (!config.namespace) {
        latestDeployments = [];
        renderDeploymentList([]);
        updateCounts([]);
        setStatus('Set a namespace in Settings before refreshing deployments.');
        switchView('settings');
        return;
    }

    refreshInProgress = true;
    document.getElementById('refreshButton').disabled = true;
    setStatus('Refreshing…');

    try {
        const deployments = await window.kubeDashboard.fetchDeployments(config);
        latestDeployments = deployments;
        renderDeploymentList(deployments);
        updateCounts(deployments);
        const now = new Date().toLocaleTimeString();
        setStatus(`Last refreshed at ${now} · ${deployments.length} deployment${deployments.length !== 1 ? 's' : ''}`);
    } catch (err) {
        showError(err);
        setStatus('Refresh failed');
    } finally {
        refreshInProgress = false;
        document.getElementById('refreshButton').disabled = false;
    }
}

function setStatus(text) {
    document.getElementById('statusPanel').textContent = text;
}

function showError(err) {
    const list = document.getElementById('deploymentList');
    const msg = err?.message || String(err);
    const details = err?.details ? `\n\n${err.details}` : '';
    list.innerHTML = `<div class="error-panel"><strong>Failed to fetch deployments</strong><pre>${escapeHtml(msg + details)}</pre></div>`;
}

// --- Counts ---
function updateCounts(deployments) {
    const failing = deployments.filter((d) => isFailingStatus(d.status)).length;
    const count = document.getElementById('deploymentsCount');
    if (failing > 0) {
        count.textContent = `${failing} failing`;
        count.style.background = '#ffe0de';
        count.style.color = '#b42318';
    } else {
        count.textContent = deployments.length;
        count.style.background = '';
        count.style.color = '';
    }
}

function isFailingStatus(status) {
    return ['error', 'crash-loop', 'failed', 'unavailable'].includes(status);
}

// --- Filter ---
function matchesFilter(dep) {
    if (activeFilter === 'all') { return true; }
    if (activeFilter === 'healthy') { return dep.status === 'healthy'; }
    if (activeFilter === 'failing') { return isFailingStatus(dep.status); }
    if (activeFilter === 'progressing') { return dep.status === 'progressing'; }
    if (activeFilter === 'scaled-down') { return dep.status === 'scaled-down'; }
    return true;
}

// --- Pipeline card clicks ---
document.getElementById('pipelineList').addEventListener('click', (e) => {
    const link = e.target.closest('.pr-row-link, .trello-link');
    if (link) {
        window.kubeDashboard.openExternal(link.dataset.url);
        return;
    }
    const card = e.target.closest('.pipeline-card');
    if (card?.dataset.url) { window.kubeDashboard.openExternal(card.dataset.url); }
});

// --- Card expand/collapse + PR links ---
document.getElementById('deploymentList').addEventListener('click', (e) => {
    // Handle PR link clicks without toggling expand
    const link = e.target.closest('.pr-row-link, .trello-link');
    if (link) {
        e.stopPropagation();
        window.kubeDashboard.openExternal(link.dataset.url);
        return;
    }

    const card = e.target.closest('.deployment-card');
    if (!card) { return; }
    const expand = card.querySelector('.pod-expand');
    const chevron = card.querySelector('.expand-chevron');
    if (!expand) { return; }
    const isOpen = !expand.classList.contains('hidden');
    expand.classList.toggle('hidden', isOpen);
    if (chevron) { chevron.textContent = isOpen ? '›' : '˅'; }
    card.classList.toggle('is-expanded', !isOpen);
});

// --- Rendering ---
function updateFilterCounts(deployments) {
    const counts = {
        all: deployments.length,
        healthy: deployments.filter((d) => d.status === 'healthy').length,
        failing: deployments.filter((d) => isFailingStatus(d.status)).length,
        progressing: deployments.filter((d) => d.status === 'progressing').length,
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
    list.innerHTML = filtered.map(renderDeploymentCard).join('');

    // Stagger PR lookups to avoid hammering the GitHub API.
    // Cached results (repo already known + PR cached) resolve instantly;
    // only uncached ones actually hit the network.
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
    // Bail if a newer render has replaced this card
    if (!card || gen !== renderGeneration) { return; }
    // Also verify the card still reflects the same SHA we fetched for
    if (card.dataset.sha !== dep.gitSha) { return; }

    if (prCache.has(cacheKey)) {
        const cached = prCache.get(cacheKey);
        if (cached) {
            injectPrRow(card, cached, dep.gitSha);
        } else {
            const row = card.querySelector('.pr-row');
            if (row) { row.remove(); }
        }
        return;
    }

    const config = loadConfig();
    if (!config.githubOrg) {
        const row = card.querySelector('.pr-row');
        if (row) { row.remove(); }
        return;
    }

    try {
        const pr = await window.kubeDashboard.fetchPrForSha(dep.gitSha, dep.imageRepoName, config.githubOrg);
        prCache.set(cacheKey, pr);
        if (pr) {
            injectPrRow(card, pr, dep.gitSha);
        } else {
            const row = card.querySelector('.pr-row');
            if (row) { row.remove(); }
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

    // Inject Trello link into the pill row if present
    const placeholder = card.querySelector('.trello-placeholder');
    if (placeholder && pr.trelloUrl) {
        const trello = document.createElement('span');
        trello.className = 'trello-link';
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

function renderDeploymentCard(dep) {
    const statusClass = dep.status.replace(/[^a-z-]/g, '');
    const statusLabel = getStatusLabel(dep.status);
    const deployedLabel = dep.deployedAt ? formatRelativeTime(dep.deployedAt) : 'unknown';
    const deployedAbsolute = dep.deployedAt ? new Date(dep.deployedAt).toLocaleString() : '';
    const agePillClass = getAgePillClass(dep.deployedAt);
    const imageTag = getImageTag(dep.image);
    const isLocalBuild = imageTag && imageTag.startsWith('local-build');
    const failuresHtml = dep.failures.length > 0 && dep.status !== 'healthy' ? renderFailures(dep.failures) : '';

    return `
    <div class="deployment-card" data-name="${escapeHtml(dep.namespace + '/' + dep.name)}" data-sha="${escapeHtml(dep.gitSha || '')}"">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <span class="eyebrow-inline">${escapeHtml(dep.namespace)}</span>
                <h3>${escapeHtml(dep.name)}</h3>
                ${isLocalBuild ? `<span class="local-build-badge" title="${escapeHtml(dep.image || '')}">local build</span>` : ''}
            </div>
            <div class="deployment-pill-row">
                <span class="trello-placeholder"></span>
                <span class="status-pill is-${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span>
                <span class="age-pill ${agePillClass}" title="${escapeHtml(deployedAbsolute)}">${escapeHtml(deployedLabel)}</span>
                <span class="expand-chevron">›</span>
            </div>
        </div>
        ${dep.gitSha && /^[0-9a-f]{7,}/i.test(dep.gitSha) ? `<div class="pr-row pr-row--loading"><span class="pr-loading">Loading commit info…</span></div>` : ''}
        ${failuresHtml}
        <div class="pod-expand hidden">
            ${renderPodTable(dep)}
        </div>
    </div>`;
}


function renderPodTable(dep) {
    if (dep.pods.length === 0) {
        return '<p class="pod-empty">No pods found</p>';
    }
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

// --- Utilities ---
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
    // Truncate digest SHAs (sha256:abc123...) to 8 chars
    if (/^[0-9a-f]{12,}$/i.test(tag)) { return tag.slice(0, 8); }
    if (tag.startsWith('sha256:')) { return 'sha256:' + tag.slice(7, 15); }
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

// --- Pipelines ---
let pipelinesRefreshInProgress = false;
let activePipelineFilter = 'all';
let pipelineRenderGeneration = 0;
const pipelinePrCache = new Map(); // key: `pipeline/${repoName}/${sha}` → pr or null

document.getElementById('pipelinesRefreshButton').addEventListener('click', () => {
    if (!pipelinesRefreshInProgress) { refreshPipelines(); }
});

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
    document.getElementById('pipelinesRefreshButton').disabled = true;
    document.getElementById('pipelinesStatusPanel').textContent = 'Refreshing…';

    const config = loadConfig();
    try {
        const runs = await window.kubeDashboard.fetchPipelineRuns({
            org: config.azureOrg,
            project: config.azureProject,
        });
        renderPipelineList(runs);

        // Count only for the user's team
        const teamRuns = config.namespace
            ? runs.filter((r) => r.team === config.namespace)
            : runs;

        // Deduplicate by pipeline name (latest run per pipeline)
        const latestByName = new Map();
        for (const r of teamRuns) {
            if (!latestByName.has(r.name)) { latestByName.set(r.name, r); }
        }
        const teamPipelines = [...latestByName.values()];

        const failed = teamPipelines.filter((r) => r.result === 'failed').length;
        const running = teamPipelines.filter((r) => r.status === 'inProgress').length;
        const now = new Date().toLocaleTimeString();
        document.getElementById('pipelinesStatusPanel').textContent =
            `Last refreshed at ${now} · ${teamPipelines.length} pipeline${teamPipelines.length !== 1 ? 's' : ''} today`;
        const count = document.getElementById('pipelinesCount');
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
        document.getElementById('pipelinesRefreshButton').disabled = false;
    }
}

function renderPipelineList(runs) {
    window._lastPipelineRuns = runs;
    const list = document.getElementById('pipelineList');

    const pConfig = loadConfig();
    let filtered = pConfig.namespace
        ? runs.filter((r) => r.team === pConfig.namespace)
        : runs;

    // Update chip counts
    const deduped = (arr) => [...new Map(arr.map((r) => [r.name, r])).values()];
    const chipCounts = {
        all: deduped(filtered).length,
        failed: deduped(filtered.filter((r) => r.result === 'failed')).length,
        succeeded: deduped(filtered.filter((r) => r.result === 'succeeded')).length,
    };
    document.querySelectorAll('.filter-chip[data-pipeline-filter]').forEach((chip) => {
        const span = chip.querySelector('span');
        if (span) { span.textContent = chipCounts[chip.dataset.pipelineFilter] ?? 0; }
    });

    if (activePipelineFilter === 'failed') {
        filtered = filtered.filter((r) => r.result === 'failed');
    } else if (activePipelineFilter === 'succeeded') {
        filtered = filtered.filter((r) => r.result === 'succeeded');
    }

    if (filtered.length === 0) {
        list.innerHTML = '<p class="empty-state">No pipeline runs today.</p>';
        return;
    }

    // Group by pipeline name, latest run per pipeline
    const grouped = new Map();
    for (const run of filtered) {
        if (!grouped.has(run.name)) { grouped.set(run.name, run); }
    }

    pipelineRenderGeneration++;
    const gen = pipelineRenderGeneration;

    list.innerHTML = [...grouped.values()].map(renderPipelineGroup).join('');

    // Fetch failure reasons and PR info async
    const pipelineConfig = loadConfig();
    let stagger = 0;
    for (const run of grouped.values()) {
        if (run.result === 'failed') { fetchAndInjectFailedStep(run, pipelineConfig); }
        if (run.sourceVersion && run.repoName && pipelineConfig.githubOrg) {
            const isCached = pipelinePrCache.has(`pipeline/${run.repoName}/${run.sourceVersion}`);
            setTimeout(() => fetchAndInjectPipelinePr(run, gen, pipelineConfig), isCached ? 0 : stagger);
            if (!isCached) { stagger += 400; }
        } else {
            // No sha/repo – remove loading placeholder
            const card = list.querySelector(`.pipeline-card[data-id="${run.id}"]`);
            if (card) { card.querySelector('.pr-row')?.remove(); }
        }
    }
}

async function fetchAndInjectFailedStep(run, config) {
    try {
        const step = await window.kubeDashboard.fetchFailedStep({
            org: config.azureOrg,
            project: config.azureProject,
            buildId: run.id,
        });
        if (!step) { return; }
        const card = document.querySelector(`.pipeline-card[data-id="${run.id}"]`);
        if (!card) { return; }
        const metaRow = card.querySelector('.pipeline-meta-row');
        if (metaRow) {
            const el = document.createElement('span');
            el.className = 'pipeline-failed-step';
            el.textContent = `Failed at: ${step}`;
            metaRow.appendChild(el);
        }
    } catch { /* ignore */ }
}

async function fetchAndInjectPipelinePr(run, gen, config) {
    const cacheKey = `pipeline/${run.repoName}/${run.sourceVersion}`;
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
        const pr = await window.kubeDashboard.fetchPrForSha(run.sourceVersion, run.repoName, config.githubOrg);
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

    // Trello link
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

    return `
    <div class="pipeline-card" data-url="${escapeHtml(run.url)}" data-id="${run.id}">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <h3>${escapeHtml(run.name)}</h3>
            </div>
            <div class="deployment-pill-row">
                <span class="trello-placeholder"></span>
                <span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
                <span class="age-pill" title="${escapeHtml(startAbsolute)}">${escapeHtml(startLabel)}</span>
            </div>
        </div>
        ${hasSha ? `<div class="pr-row pr-row--loading"><span class="pr-loading">Loading commit info…</span></div>` : ''}
        <div class="pipeline-meta-row">
            ${run.sourceBranch ? `<span class="branch-pill">${escapeHtml(run.sourceBranch)}</span>` : ''}
            ${run.trigger && run.trigger !== run.sourceBranch ? `<span class="pipeline-meta-text">${escapeHtml(run.trigger)}</span>` : ''}
            ${duration ? `<span class="pipeline-meta-text">${escapeHtml(duration)}</span>` : ''}
        </div>
    </div>`;
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

function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) { return `${seconds}s`; }
    return `${minutes}m ${seconds}s`;
}

// --- Pull Requests ---
let prRefreshInProgress = false;
let activePrTab = 'open';  // 'open' | 'merged' | 'dependabot'
let activePrFilter = 'all';
let latestPrData = null;

document.getElementById('prRefreshButton').addEventListener('click', () => {
    if (!prRefreshInProgress) { refreshPullRequests(true); }
});

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
    const chip = e.target.closest('.filter-chip[data-pr-filter]');
    if (!chip) { return; }
    activePrFilter = chip.dataset.prFilter;
    document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.prFilter === activePrFilter);
    });
    if (latestPrData) { renderPrView(latestPrData); }
});

document.getElementById('prList').addEventListener('click', (e) => {
    const card = e.target.closest('.pr-card[data-url]');
    if (card) { window.kubeDashboard.openExternal(card.dataset.url); }
});

async function refreshPullRequests(force = false) {
    if (prRefreshInProgress) { return; }
    // Don't re-fetch if we have fresh data and this isn't a forced refresh
    if (latestPrData && !force) { renderPrView(latestPrData); return; }

    const config = loadConfig();
    if (!config.githubOrg || !config.githubTopic) {
        document.getElementById('prList').innerHTML = '<p class="empty-state">Set GitHub org and repo topic in Settings to load pull requests.</p>';
        document.getElementById('prStatusPanel').textContent = 'Not configured';
        return;
    }

    prRefreshInProgress = true;
    document.getElementById('prRefreshButton').disabled = true;
    document.getElementById('prStatusPanel').textContent = 'Loading…';

    try {
        const data = await window.kubeDashboard.fetchPullRequests({ org: config.githubOrg, topic: config.githubTopic });
        latestPrData = data;
        renderPrView(data);
        const now = new Date().toLocaleTimeString();
        document.getElementById('prStatusPanel').textContent = `${data.repositories.length} repo${data.repositories.length !== 1 ? 's' : ''} · Updated ${now}`;
        updatePrNavCount(data);
    } catch (err) {
        document.getElementById('prList').innerHTML = `<div class="error-panel"><strong>Failed to load pull requests</strong><pre>${escapeHtml(err?.message || String(err))}</pre></div>`;
        document.getElementById('prStatusPanel').textContent = 'Refresh failed';
    } finally {
        prRefreshInProgress = false;
        document.getElementById('prRefreshButton').disabled = false;
    }
}

function updatePrNavCount(data) {
    const count = document.getElementById('pullRequestsCount');
    const open = data.pullRequests.length;
    if (open > 0) {
        count.textContent = open;
        count.style.background = '';
        count.style.color = '';
    } else {
        count.textContent = '';
    }
}

function getPrsForTab(data) {
    if (activePrTab === 'merged') { return [...data.mergedPullRequests, ...data.mergedDependabotPullRequests]; }
    if (activePrTab === 'dependabot') { return data.dependabotPullRequests; }
    return data.pullRequests;
}

function matchesPrFilter(pr) {
    if (activePrFilter === 'approved') { return pr.reviewDecision === 'APPROVED' && !pr.isDraft; }
    if (activePrFilter === 'changes-requested') { return pr.reviewDecision === 'CHANGES_REQUESTED' && !pr.isDraft; }
    if (activePrFilter === 'draft') { return Boolean(pr.isDraft); }
    if (activePrFilter === 'checks-failing') { return pr.checkStatus === 'failure'; }
    return true;
}

function renderPrView(data) {
    const list = document.getElementById('prList');
    const prs = getPrsForTab(data);
    const isMergedTab = activePrTab === 'merged';
    const isDependabotTab = activePrTab === 'dependabot';

    // Update filter chip counts (only relevant for open tab)
    const showFilters = !isMergedTab;
    document.getElementById('prFilterBar').style.display = showFilters ? '' : 'none';
    if (showFilters) {
        document.querySelectorAll('.filter-chip[data-pr-filter]').forEach((chip) => {
            const f = chip.dataset.prFilter;
            const span = chip.querySelector('span');
            if (!span) { return; }
            if (f === 'all') { span.textContent = prs.length; return; }
            span.textContent = prs.filter((pr) => matchesPrFilter({ ...pr, _filter: f, checkStatus: pr.checkStatus, reviewDecision: pr.reviewDecision, isDraft: pr.isDraft })).length;
            // recalc properly
            const counts = {
                'approved': prs.filter((p) => p.reviewDecision === 'APPROVED' && !p.isDraft).length,
                'changes-requested': prs.filter((p) => p.reviewDecision === 'CHANGES_REQUESTED' && !p.isDraft).length,
                'draft': prs.filter((p) => p.isDraft).length,
                'checks-failing': prs.filter((p) => p.checkStatus === 'failure').length,
            };
            span.textContent = counts[f] ?? 0;
        });
    }

    const filtered = activePrFilter === 'all' || isMergedTab ? prs : prs.filter(matchesPrFilter);

    if (filtered.length === 0) {
        const msg = isMergedTab ? 'No pull requests merged today.' :
            isDependabotTab ? 'No open Dependabot pull requests.' :
                activePrFilter === 'all' ? 'No open pull requests.' : 'No pull requests match this filter.';
        list.innerHTML = `<p class="empty-state">${msg}</p>`;
        return;
    }

    list.innerHTML = filtered.map((pr) => renderPrCard(pr, isMergedTab)).join('');
}

function getPipelineStatusForPr(prNumber) {
    const runs = window._lastPipelineRuns;
    if (!runs) { return null; }
    // Match pipeline runs triggered by this PR (sourceBranch = "PR #N")
    const matching = runs.filter((r) => r.sourceBranch === `PR #${prNumber}` || r.trigger === `PR #${prNumber}`);
    if (!matching.length) { return null; }
    // Pick the most recent
    const latest = matching.sort((a, b) => new Date(b.startTime) - new Date(a.startTime))[0];
    if (latest.status === 'inProgress') { return { label: 'Pipeline running', cls: 'is-progressing' }; }
    if (latest.result === 'succeeded') { return { label: 'Pipeline passed', cls: 'is-healthy' }; }
    if (latest.result === 'failed') { return { label: 'Pipeline failed', cls: 'is-failed' }; }
    if (latest.result === 'canceled') { return { label: 'Pipeline canceled', cls: 'is-scaled-down' }; }
    return null;
}

function getDeploymentStatusForPr(pr) {
    if (!latestDeployments.length) { return null; }
    // Match by the last segment of the repo name, e.g. "bring/checkout-api" → "checkout-api"
    const repoName = pr.repository?.split('/').pop()?.toLowerCase();
    if (!repoName) { return null; }
    const dep = latestDeployments.find((d) => d.imageRepoName?.toLowerCase() === repoName);
    if (!dep) { return null; }
    const statusLabel = getStatusLabel(dep.status);
    const cls = dep.status === 'healthy' ? 'is-healthy' :
        dep.status === 'progressing' ? 'is-progressing' : 'is-failed';
    return { label: `Deployed · ${statusLabel}`, cls };
}

function renderPrCard(pr, isMerged = false) {
    const reviewLabel = isMerged ? 'Merged' : getPrReviewLabel(pr);
    const reviewClass = isMerged ? 'is-merged' : getPrReviewClass(pr);
    const checkClass = { success: 'is-success', failure: 'is-failure', pending: 'is-pending', none: 'is-none' }[pr.checkStatus] || 'is-none';
    const dateLabel = isMerged ? `Merged ${formatRelativeTime(pr.mergedAt)}` : `Updated ${formatRelativeTime(pr.updatedAt)}`;
    const ageDetails = !isMerged ? getPrAgeDetails(pr.createdAt) : null;

    const pipelineStatus = isMerged ? getPipelineStatusForPr(pr.number) : null;
    const deploymentStatus = isMerged ? getDeploymentStatusForPr(pr) : null;

    return `
    <div class="pr-card deployment-card" data-url="${escapeHtml(pr.url)}">
        <div class="deployment-card-top">
            <div class="deployment-name-row">
                <span class="eyebrow-inline">${escapeHtml(pr.repository)}</span>
                <h3>${escapeHtml(pr.title)}</h3>
            </div>
            <div class="deployment-pill-row">
                ${ageDetails ? `<span class="age-pill ${ageDetails.cssClass}">${escapeHtml(ageDetails.label)}</span>` : ''}
                <span class="check-pill ${checkClass}">${escapeHtml(pr.checkStatusLabel || 'No checks')}</span>
                <span class="status-pill ${reviewClass}">${escapeHtml(reviewLabel)}</span>
            </div>
        </div>
        <div class="pr-meta-row">
            <span class="pr-meta">#${pr.number} · ${escapeHtml(pr.author?.login || 'unknown')} · ${escapeHtml(dateLabel)}</span>
            ${pr.commentActivityCount > 0 ? `<span class="branch-pill">${pr.commentActivityCount} comment${pr.commentActivityCount !== 1 ? 's' : ''}</span>` : ''}
        </div>
        ${pipelineStatus || deploymentStatus ? `
        <div class="pr-infra-row">
            ${pipelineStatus ? `<span class="pr-infra-item"><span class="pr-infra-label">Pipeline</span><span class="status-pill ${pipelineStatus.cls}">${escapeHtml(pipelineStatus.label.replace('Pipeline ', ''))}</span></span>` : ''}
            ${deploymentStatus ? `<span class="pr-infra-item"><span class="pr-infra-label">Deployment</span><span class="status-pill ${deploymentStatus.cls}">${escapeHtml(deploymentStatus.label.replace('Deployed · ', ''))}</span></span>` : ''}
        </div>` : ''}
    </div>`;
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
    const days = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
    const cssClass = days >= 30 ? 'age-pill is-critical' : days >= 14 ? 'age-pill is-warning' : days >= 7 ? 'age-pill is-notice' : 'age-pill is-fresh';
    const label = days === 0 ? 'Opened today' : `${days}d old`;
    return { cssClass, label };
}

// --- Init ---
const initialConfig = loadConfig();
updateContextLabel(initialConfig);
renderEnvSwitcher(initialConfig);
populateSettingsForm();
if (initialConfig.githubOrg && initialConfig.githubTopic) {
    switchView('pull-requests');
} else if (initialConfig.namespace) {
    switchView('deployments');
} else {
    setStatus('Save settings to refresh deployments.');
    switchView('settings');
}
// Always pre-fetch deployments in the background if namespace is configured
if (initialConfig.namespace) {
    refresh();
}
