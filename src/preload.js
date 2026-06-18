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
    onUpdateReady: (cb) => ipcRenderer.on('update-ready', (_e, version) => cb(version)),
    installUpdate: () => ipcRenderer.send('update-install'),
    approvePr: (config) => ipcRenderer.invoke('pr:approve', config),
    mergePr: (config) => ipcRenderer.invoke('pr:merge', config),
    openExternal: (url) => ipcRenderer.invoke('external:open', url),
    requestNotificationPermission: () => ipcRenderer.invoke('notifications:requestPermission'),
});
