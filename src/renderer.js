'use strict';
/* exported latestDeployments, renderGeneration, prCache, loadConfig, setLastUpdated, refresh, depHasTrello, matchesFilter, getCurrentEnvLabel */

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
    const cfg = readStoredJson(STORAGE_KEYS.config, { context: '', namespace: '' });
    // azureTeam was added later — default to namespace for existing configs
    if (cfg.azureTeam === undefined) { cfg.azureTeam = cfg.namespace || ''; }
    return cfg;
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
    if (view === 'pipelines' && !window._lastPipelineRuns) {
        refreshPipelines();
    }
    if (view === 'pull-requests' && !latestPrData) {
        refreshPullRequests();
    }
    if (view === 'feed') {
        initFeedDateRange();
        refreshFeed();
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
    window.kubeDashboard.getBuildDate().then((date) => {
        const el = document.getElementById('buildDateLabel');
        if (el && date) { el.textContent = `Built ${new Date(date).toLocaleString()}`; }
    });
    const config = loadConfig();
    ensureSelectOption('contextInput', config.context || '');
    ensureSelectOption('namespaceInput', config.namespace || '');
    document.getElementById('githubOrgInput').value = config.githubOrg || '';
    document.getElementById('githubTopicInput').value = config.githubTopic || '';
    document.getElementById('githubWatchedReposInput').value = (config.githubWatchedRepos || []).join('\n');
    document.getElementById('datadogSiteInput').value = config.datadogSite || '';
    document.getElementById('showPrAvatarsInput').checked = config.showPrAvatars ?? true;
    document.getElementById('notificationsEnabledInput').checked = config.notificationsEnabled || false;
    document.getElementById('pipelineNotificationsEnabledInput').checked = config.pipelineNotificationsEnabled || false;
    document.getElementById('azureOrgInput').value = config.azureOrg || '';
    document.getElementById('azureProjectInput').value = config.azureProject || '';
    document.getElementById('azureTeamInput').value = config.azureTeam ?? config.namespace ?? '';
    document.getElementById('envProdInput').value = config.envContexts?.prod || '';
    document.getElementById('envQaInput').value = config.envContexts?.qa || '';
    document.getElementById('envTestInput').value = config.envContexts?.test || '';
    updateSaveButtonState();
}

function readFormConfig() {
    return {
        context: document.getElementById('contextInput').value,
        namespace: document.getElementById('namespaceInput').value,
        githubOrg: document.getElementById('githubOrgInput').value.trim(),
        githubTopic: document.getElementById('githubTopicInput').value.trim(),
        githubWatchedRepos: document.getElementById('githubWatchedReposInput').value
            .split('\n').map((r) => r.trim()).filter(Boolean),
        datadogSite: document.getElementById('datadogSiteInput').value.trim().replace(/\/$/, ''),
        showPrAvatars: document.getElementById('showPrAvatarsInput').checked,
        notificationsEnabled: document.getElementById('notificationsEnabledInput').checked,
        pipelineNotificationsEnabled: document.getElementById('pipelineNotificationsEnabledInput').checked,
        azureOrg: document.getElementById('azureOrgInput').value.trim(),
        azureProject: document.getElementById('azureProjectInput').value.trim(),
        azureTeam: document.getElementById('azureTeamInput').value.trim(),
        envContexts: {
            prod: document.getElementById('envProdInput').value,
            qa: document.getElementById('envQaInput').value,
            test: document.getElementById('envTestInput').value,
        },
    };
}

function updateSaveButtonState() {
    const saved = loadConfig();
    const current = readFormConfig();
    const isDirty = JSON.stringify(saved) !== JSON.stringify(current);
    document.getElementById('saveSettings').classList.toggle('is-dirty', isDirty);
}

// Watch all settings inputs for changes
document.getElementById('namespaceInput')?.addEventListener('change', () => {
    const teamInput = document.getElementById('azureTeamInput');
    if (!teamInput.value.trim()) {
        teamInput.value = document.getElementById('namespaceInput').value;
    }
});

['contextInput', 'namespaceInput', 'githubOrgInput', 'githubTopicInput', 'githubWatchedReposInput', 'datadogSiteInput',
    'azureOrgInput', 'azureProjectInput', 'azureTeamInput', 'envProdInput', 'envQaInput', 'envTestInput', 'showPrAvatarsInput', 'notificationsEnabledInput', 'pipelineNotificationsEnabledInput',
].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', updateSaveButtonState);
    document.getElementById(id)?.addEventListener('input', updateSaveButtonState);
});

document.getElementById('contextInput').addEventListener('change', () => {
    loadNamespacesForSelectedContext().catch((err) => {
        setStatus(`Could not load namespaces: ${err?.message || String(err)}`);
    });
});

document.getElementById('reloadContextsBtn').addEventListener('click', async () => {
    await window.kubeDashboard.invalidateContextsCache();
    await loadClusterSettingsIfEmpty();
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

const ENV_COLOR_CLASS = { Prod: 'is-env-prod', QA: 'is-env-qa', Test: 'is-env-test' };

function renderEnvSwitcher(config) {
    const switcher = document.getElementById('envSwitcher');
    const envs = config?.envContexts || {};
    const buttons = Object.entries({ Prod: envs.prod, QA: envs.qa, Test: envs.test })
        .filter(([, ctx]) => ctx);

    if (buttons.length === 0) { switcher.innerHTML = ''; return; }

    switcher.innerHTML = buttons.map(([label, ctx]) => {
        const isActive = (config?.context || '') === ctx;
        const colorClass = ENV_COLOR_CLASS[label] || '';
        return `<button class="env-btn ${colorClass} ${isActive ? 'is-active' : ''}" data-context="${escapeHtml(ctx)}" data-env="${label.toLowerCase()}">${label}</button>`;
    }).join('');
}

function getCurrentEnvLabel(config) {
    const envs = config?.envContexts || {};
    const ctx = config?.context || '';
    if (ctx && ctx === envs.prod) { return 'prod'; }
    if (ctx && ctx === envs.qa) { return 'qa'; }
    if (ctx && ctx === envs.test) { return 'test'; }
    return null;
}

document.getElementById('envSwitcher').addEventListener('click', (e) => {
    const btn = e.target.closest('.env-btn');
    if (!btn) { return; }
    const config = loadConfig();
    config.context = btn.dataset.context;
    saveConfig(config);
    updateContextLabel(config);
    renderEnvSwitcher(config);
    clearAllLists();
    refreshAll();
});

function clearAllLists() {
    latestDeployments = [];
    window._lastPipelineRuns = null;
    latestPrData = null;
    refreshInProgress = false;
    pipelinesRefreshInProgress = false;
    prRefreshInProgress = false;
    document.getElementById('deploymentList').innerHTML = '';
    document.getElementById('pipelineList').innerHTML = '';
    document.getElementById('prList').innerHTML = '';
}

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
    const config = readFormConfig();
    const oldConfig = loadConfig();
    if ((config.notificationsEnabled && !oldConfig.notificationsEnabled) ||
        (config.pipelineNotificationsEnabled && !oldConfig.pipelineNotificationsEnabled)) {
        window.kubeDashboard.requestNotificationPermission();
    }
    saveConfig(config);
    updateSaveButtonState();
    updateContextLabel(config);
    renderEnvSwitcher(config);
    if (!config.namespace) {
        setStatus('Set a namespace in Settings before refreshing deployments.');
        return;
    }
    if (config.namespace !== oldConfig.namespace) {
        clearAllLists();
    }
    switchView('deployments');
    refreshAll();
});

function updateContextLabel(config) {
    const label = document.getElementById('contextLabel');
    label.textContent = (config.namespace || 'Kubernetes').toUpperCase();
}

// --- Refresh logic ---
function setLastUpdated() {
    const el = document.getElementById('updatedLabel');
    if (el) { el.textContent = `Updated ${new Date().toLocaleTimeString()}`; }
}

function setRefreshSpinning(spinning) {
    document.getElementById('refreshAllButton')?.classList.toggle('is-spinning', spinning);
}

function refreshAll() {
    setRefreshSpinning(true);
    window.kubeDashboard.clearPrCache?.();
    Promise.allSettled([refresh(), refreshPipelines(), refreshPullRequests(true)])
        .then(() => setRefreshSpinning(false));
}

document.getElementById('refreshAllButton').addEventListener('click', refreshAll);


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
    setStatus('Refreshing…');

    try {
        const deployments = await window.kubeDashboard.fetchDeployments(config);
        latestDeployments = deployments;
        renderDeploymentList(deployments);
        updateCounts(deployments);
        setStatus(`${deployments.length} deployment${deployments.length !== 1 ? 's' : ''}`);
        setLastUpdated();
    } catch (err) {
        showError(err);
        setStatus('Refresh failed');
    } finally {
        refreshInProgress = false;
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

// --- Filter ---
function depHasTrello(dep) {
    const cacheKey = `${dep.name}/${dep.gitSha}`;
    const pr = prCache.get(cacheKey);
    return Boolean(pr?.trelloUrl);
}

function matchesFilter(dep) {
    if (activeFilter === 'all') { return true; }
    if (activeFilter === 'healthy') { return dep.status === 'healthy'; }
    if (activeFilter === 'failing') { return isFailingStatus(dep.status); }
    if (activeFilter === 'progressing') { return dep.status === 'progressing'; }
    if (activeFilter === 'scaled-down') { return dep.status === 'scaled-down'; }
    if (activeFilter === 'has-trello') { return depHasTrello(dep); }
    return true;
}

// --- Pipeline card clicks ---
document.getElementById('pipelineList').addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-errors-btn');
    if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const errDiv = copyBtn.closest('.pipeline-errors');
        const card = copyBtn.closest('.pipeline-card');
        const errors = JSON.parse(errDiv?.dataset.errors || '[]');
        const prNumber = card?.dataset.prNumber;
        const prTitle = card?.dataset.prTitle;
        const prUrl = card?.dataset.prUrl;
        const prLabel = prNumber ? `GitHub PR #${prNumber}${prTitle ? ` - ${prTitle}` : ''}${prUrl ? ` (${prUrl})` : ''}` : '';
        const text = `${prLabel}\n\nErrors:\n${errors.join('\n')}`.trim();
        navigator.clipboard.writeText(text);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        return;
    }
    const rerunBtn = e.target.closest('.pipeline-rerun-btn');
    if (rerunBtn) {
        e.preventDefault();
        e.stopPropagation();
        const card = rerunBtn.closest('.pipeline-card');
        const buildId = parseInt(card?.dataset.buildId, 10);
        const config = loadConfig();
        rerunBtn.disabled = true;
        rerunBtn.textContent = '↺ Rerunning…';
        window.kubeDashboard.rerunFailedJobs({ org: config.azureOrg, project: config.azureProject, buildId })
            .then(() => {
                rerunBtn.textContent = '✓ Queued';
                setTimeout(() => refreshPipelines(), 3000);
            })
            .catch((err) => {
                rerunBtn.disabled = false;
                rerunBtn.textContent = '↺ Rerun failed jobs';
                console.error('[rerun]', err);
                alert(`Failed to rerun: ${err.message}`);
            });
        return;
    }

    const link = e.target.closest('.pr-row-link, .trello-link, .pipeline-link');
    if (link) {
        window.kubeDashboard.openExternal(link.dataset.url);
    }
});

// --- Card expand/collapse + PR links ---
document.getElementById('deploymentList').addEventListener('click', (e) => {
    // Handle PR/Trello/Datadog link clicks without toggling expand
    const link = e.target.closest('.pr-row-link, .trello-link, .datadog-link, .rollout-pr-link');
    if (link) {
        e.stopPropagation();
        window.kubeDashboard.openExternal(link.dataset.url);
        return;
    }

    // Handle logs button
    const logsBtn = e.target.closest('.logs-open-btn');
    if (logsBtn) {
        e.stopPropagation();
        const depName = logsBtn.dataset.depName;
        const dep = latestDeployments.find((d) => d.name === depName);
        const pods = dep?.pods?.map((p) => p.name).filter(Boolean) || [];
        const config = loadConfig();
        openLogsModal({ depName, pods, context: config.context, namespace: config.namespace });
        return;
    }

    // Handle rollback button
    const rollbackBtn = e.target.closest('.rollout-rollback-btn');
    if (rollbackBtn) {
        e.stopPropagation();
        const row = rollbackBtn.closest('.rollout-row');
        const card = rollbackBtn.closest('.deployment-card');
        const depName = card?.dataset.depName;
        const revision = rollbackBtn.dataset.revision;
        const prTitleEl = row?.querySelector('.rollout-pr-title, .rollout-info');
        const prTitle = prTitleEl?.textContent?.trim();
        const tagEl = row?.querySelector('.rollout-tag');
        const tag = tagEl?.textContent?.trim();
        const config = loadConfig();
        openRollbackModal({ depName, namespace: config.namespace, context: config.context, revision, prTitle, tag });
        return;
    }

    // Handle history button toggle
    if (e.target.closest('.rollout-history-btn')) {
        const btn = e.target.closest('.rollout-history-btn');
        const card = btn.closest('.deployment-card');
        const history = card?.querySelector('.rollout-history');
        if (history) {
            const isOpen = !history.classList.contains('hidden');
            history.classList.toggle('hidden', isOpen);
            btn.classList.toggle('is-active', !isOpen);
            if (!isOpen) {
                const rows = history.querySelectorAll('.rollout-row[data-sha][data-repo]');
                rows.forEach(async (row) => {
                    if (row.dataset.prLoaded) { return; }
                    row.dataset.prLoaded = '1';
                    const titleEl = row.querySelector('span.rollout-pr-title');
                    try {
                        const pr = await window.kubeDashboard.fetchPrForSha(row.dataset.sha, row.dataset.repo, initialConfig.githubOrg);
                        if (titleEl) {
                            if (pr?.title) {
                                titleEl.innerHTML = pr.url
                                    ? `<span class="rollout-pr-link" data-url="${escapeHtml(pr.url)}">#${pr.number} ${escapeHtml(pr.title)}</span>`
                                    : escapeHtml(pr.title);
                            } else {
                                titleEl.textContent = '';
                            }
                        }
                    } catch {
                        if (titleEl) { titleEl.textContent = ''; }
                    }
                });

                const avatarImgs = history.querySelectorAll('img.rollout-avatar[data-login]');
                avatarImgs.forEach(async (img) => {
                    if (img.dataset.avatarLoaded) { return; }
                    img.dataset.avatarLoaded = '1';
                    const url = await fetchAvatar(img.dataset.login);
                    if (url) {
                        img.src = url;
                        img.style.display = '';
                    }
                });
            }
        }
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

// --- Utilities ---

// --- Init ---
const initialConfig = loadConfig();
updateContextLabel(initialConfig);
renderEnvSwitcher(initialConfig);
populateSettingsForm();

window.kubeDashboard.onUpdateAvailable((version) => {
    const banner = document.getElementById('updateBanner');
    const text = document.getElementById('updateBannerText');
    if (banner && text) {
        text.textContent = `Version ${version} downloading…`;
        banner.classList.remove('hidden');
    }
});

window.kubeDashboard.onUpdateReady((version) => {
    const banner = document.getElementById('updateBanner');
    const text = document.getElementById('updateBannerText');
    if (banner && text) {
        text.textContent = `Version ${version} is ready to install`;
        banner.classList.remove('hidden');
    }
});
document.getElementById('updateBannerBtn')?.addEventListener('click', () => {
    console.log('[updater] install button clicked');
    window.kubeDashboard.installUpdate();
});
document.getElementById('updateBannerDismiss')?.addEventListener('click', () => {
    document.getElementById('updateBanner').classList.add('hidden');
});
const initialPrTopic = initialConfig.githubTopic || initialConfig.namespace;
if (initialConfig.githubOrg && initialPrTopic) {
    switchView('pull-requests');
} else if (initialConfig.namespace) {
    switchView('deployments');
} else {
    setStatus('Save settings to refresh deployments.');
    switchView('settings');
}
// Pre-fetch all data sources in parallel on startup
if (initialConfig.namespace) { refresh(); }
if (initialConfig.azureOrg && initialConfig.azureProject) { refreshPipelines(); }
if (initialConfig.githubOrg && initialPrTopic) { refreshPullRequests(true); }

// Auto-refresh every 2 minutes
setInterval(refreshAll, 2 * 60 * 1000);

// --- Settings export/import ---
// --- Rollback modal ---
let rollbackPending = null;

function openRollbackModal({ depName, namespace, context, revision, prTitle, tag }) {
    rollbackPending = { depName, namespace, context, revision };
    document.getElementById('rollbackModalTitle').textContent = `Roll back deployment to r${revision}?`;
    const parts = [`Deployment: ${depName} in ${namespace}`];
    if (tag) { parts.push(`Image tag: ${tag}`); }
    if (prTitle) { parts.push(`Release: ${prTitle}`); }
    document.getElementById('rollbackModalDesc').textContent = parts.join('\n');
    const status = document.getElementById('rollbackModalStatus');
    status.textContent = '';
    status.className = 'modal-status hidden';
    document.getElementById('rollbackModalActions').classList.remove('hidden');
    document.getElementById('rollbackConfirmBtn').disabled = false;
    document.getElementById('rollbackConfirmBtn').textContent = 'Roll back';
    document.getElementById('rollbackModal').showModal();
}

function closeRollbackModal() {
    document.getElementById('rollbackModal').close();
    rollbackPending = null;
}

document.getElementById('rollbackCancelBtn')?.addEventListener('click', () => closeRollbackModal());
document.getElementById('rollbackModal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('rollbackModal')) { closeRollbackModal(); }
});

// ── Log modal ──────────────────────────────────────────────────────────────

document.getElementById('rollbackConfirmBtn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!rollbackPending) { return; }
    const { depName, namespace, context, revision } = rollbackPending;
    const config = loadConfig();
    const confirmBtn = document.getElementById('rollbackConfirmBtn');
    const status = document.getElementById('rollbackModalStatus');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Rolling back…';
    document.getElementById('rollbackModalActions').classList.add('hidden');
    status.className = 'modal-status modal-status--info';
    status.textContent = `Running kubectl rollout undo deployment/${depName} --to-revision=${revision}…`;

    try {
        await window.kubeDashboard.rollbackDeployment({
            context: context || config.context,
            namespace,
            name: depName,
            revision,
            kubectlPath: config.kubectlPath,
        });
        status.textContent = `Rolled back. Waiting for rollout to complete…`;
        const statusOutput = await window.kubeDashboard.rollbackStatus({
            context: context || config.context,
            namespace,
            name: depName,
            kubectlPath: config.kubectlPath,
        });
        status.className = 'modal-status modal-status--success';
        status.textContent = statusOutput.trim();
        setTimeout(() => {
            closeRollbackModal();
            refresh();
        }, 2000);
    } catch (err) {
        status.className = 'modal-status modal-status--error';
        status.textContent = `Failed: ${err.message}`;
        document.getElementById('rollbackModalActions').classList.remove('hidden');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Roll back';
    }
});

window.__loadRawConfig = () => localStorage.getItem(STORAGE_KEYS.config) || '{}';

window.kubeDashboard.onSettingsImport((config) => {
    saveConfig(config);
    populateSettingsForm();
    alert('Settings imported. Refresh to apply.');
});
