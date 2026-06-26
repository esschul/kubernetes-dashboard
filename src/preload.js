const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kubeDashboard', {
    fetchDeployments: async (config) => {
        const response = await ipcRenderer.invoke('deployments:fetch', config);
        if (!response.ok) {
            throw response.error;
        }
        return response.result;
    },
    fetchPrForSha: async (sha, repoName, org) => {
        const response = await ipcRenderer.invoke('pr:fetchForSha', sha, repoName, org);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchFailedStep: async (config) => {
        const response = await ipcRenderer.invoke('pipeline:failedStep', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchPipelineRuns: async (config) => {
        const response = await ipcRenderer.invoke('pipelines:fetch', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchNamespaces: async (config) => {
        const response = await ipcRenderer.invoke('namespaces:fetch', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchContexts: async (config) => {
        const response = await ipcRenderer.invoke('contexts:fetch', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    invalidateContextsCache: async () => {
        await ipcRenderer.invoke('contexts:invalidate');
    },
    fetchPrByNumber: async (prNumber, repoName, org) => {
        const response = await ipcRenderer.invoke('pr:fetchByNumber', prNumber, repoName, org);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchPullRequests: async (config) => {
        const response = await ipcRenderer.invoke('prs:fetch', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    fetchLogErrors: async (config) => {
        const response = await ipcRenderer.invoke('pipeline:logErrors', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    clearPrCache: () => ipcRenderer.invoke('prs:clearCache'),
    fetchGithubUser: async (login) => {
        const res = await ipcRenderer.invoke('gh:user', login);
        if (!res.ok) { throw new Error(res.error); }
        return res.result;
    },
    getBuildDate: () => ipcRenderer.invoke('app:buildDate'),
    onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, version) => cb(version)),
    onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
    installUpdate: () => ipcRenderer.send('update-install'),
    approvePr: (config) => ipcRenderer.invoke('pr:approve', config),
    mergePr: (config) => ipcRenderer.invoke('pr:merge', config),
    rerunFailedJobs: async (config) => {
        const response = await ipcRenderer.invoke('pipeline:rerun', config);
        if (!response.ok) { throw response.error; }
        return response.result;
    },
    restartDeployment: async (config) => {
        const response = await ipcRenderer.invoke('deployment:restart', config);
        if (!response.ok) { throw new Error(response.error.message); }
        return response.result;
    },
    rollbackDeployment: async (config) => {
        const response = await ipcRenderer.invoke('deployment:rollback', config);
        if (!response.ok) { throw new Error(response.error.message); }
        return response.result;
    },
    rollbackStatus: async (config) => {
        const response = await ipcRenderer.invoke('deployment:rollbackStatus', config);
        if (!response.ok) { throw new Error(response.error.message); }
        return response.result;
    },
    onSettingsImport: (cb) => ipcRenderer.on('settings:import', (_e, config) => cb(config)),
    onScreenshotCopied: (cb) => ipcRenderer.on('screenshot:copied', () => cb()),
    onScreenshotFailed: (cb) => ipcRenderer.on('screenshot:failed', (_e, message) => cb(message)),
    openExternal: (url) => ipcRenderer.invoke('external:open', url),
    requestNotificationPermission: () => ipcRenderer.invoke('notifications:requestPermission'),
    searchLogs: async (config) => {
        const response = await ipcRenderer.invoke('logs:search', config);
        if (!response.ok) { throw new Error(response.error.message); }
        return response.result;
    },
    startLogStream: (config) => ipcRenderer.invoke('logs:start', config),
    stopLogStream: () => ipcRenderer.invoke('logs:stop'),
    onLogLine: (cb) => ipcRenderer.on('logs:line', (_e, line) => cb(line)),
    onLogError: (cb) => ipcRenderer.on('logs:error', (_e, msg) => cb(msg)),
    onLogClosed: (cb) => ipcRenderer.on('logs:closed', () => cb()),
    offLogListeners: () => {
        ipcRenderer.removeAllListeners('logs:line');
        ipcRenderer.removeAllListeners('logs:error');
        ipcRenderer.removeAllListeners('logs:closed');
    },
});
