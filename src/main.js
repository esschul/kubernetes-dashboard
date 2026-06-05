const { app, BrowserWindow, ipcMain, shell } = require('electron');
if (!app.isPackaged) { require('electron-reload')(__dirname); }
const path = require('node:path');
const { fetchDeployments, fetchContexts, fetchNamespaces } = require('./kubectl-client');
const { fetchPrForSha } = require('./github-client');
const { fetchPipelineRuns, fetchFailedStep } = require('./azure-client');

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 820,
        minHeight: 620,
        backgroundColor: '#f6f7fb',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
    ipcMain.handle('deployments:fetch', async (_event, config) => {
        try {
            const result = await fetchDeployments(config);
            return { ok: true, result };
        } catch (err) {
            const msg = err.message || '';
            const isVpn = msg.includes('privatelink') || msg.includes('no such host') || msg.includes('Unable to connect to the server');
            return {
                ok: false,
                error: {
                    message: isVpn ? 'Could not reach the cluster — are you connected to VPN?' : err.message,
                    details: isVpn ? '' : (err.stderr || ''),
                }
            };
        }
    });

    ipcMain.handle('pr:fetchForSha', async (_event, sha, repoName, org) => {
        try {
            const result = await fetchPrForSha(sha, repoName, org);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('pipeline:failedStep', async (_event, config) => {
        try {
            const result = await fetchFailedStep(config);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: { message: err.message } };
        }
    });

    ipcMain.handle('pipelines:fetch', async (_event, config) => {
        try {
            const result = await fetchPipelineRuns(config);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: { message: err.message } };
        }
    });

    ipcMain.handle('namespaces:fetch', async (_event, config) => {
        try {
            const result = await fetchNamespaces(config);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: { message: err.message } };
        }
    });

    ipcMain.handle('contexts:fetch', async (_event, config) => {
        try {
            const result = await fetchContexts(config);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: { message: err.message } };
        }
    });

    ipcMain.handle('external:open', (_event, url) => {
        // Only allow safe URLs
        if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { app.quit(); }
});
