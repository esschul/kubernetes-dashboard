const { app, BrowserWindow, ipcMain, shell, Menu, dialog, Notification: ElectronNotification } = require('electron');
if (!app.isPackaged) { require('electron-reload')(__dirname); }

// Packaged Electron apps launch with a minimal PATH that lacks homebrew and
// other user-installed tools. Extend it so kubectl, gh, az and their auth
// plugins (kubelogin, etc.) can all be found as child processes.
const os = require('node:os');
const home = os.homedir();
const EXTRA_PATHS = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',   // Homebrew (Apple Silicon)
    '/usr/local/bin', '/usr/local/sbin',           // Homebrew (Intel) / manual installs
    `${home}/.pyenv/shims`,                        // pyenv shims (az installed via pip in pyenv)
    `${home}/.pyenv/bin`,                          // pyenv itself
    `${home}/.local/bin`,                          // pip --user installs
];
const currentPath = process.env.PATH || '';
const missingPaths = EXTRA_PATHS.filter((p) => !currentPath.split(':').includes(p));
if (missingPaths.length > 0) {
    process.env.PATH = [...missingPaths, currentPath].join(':');
}
const path = require('node:path');
const { autoUpdater } = require('electron-updater');

let buildDate = null;
try { buildDate = require('./build-info.json').date; } catch { /* not available in dev */ }
const { fetchDeployments, fetchContexts, fetchNamespaces } = require('./kubectl-client');
const { fetchPrForSha, fetchPrByNumber, fetchGithubUser, approvePr, mergePr } = require('./github-client');
const { fetchPipelineRuns, fetchFailedStep, fetchLogErrors, rerunFailedJobs } = require('./azure-client');
const { fetchPullRequests, clearPrListCache } = require('./pr-client');

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

    ipcMain.handle('pr:fetchByNumber', async (_event, prNumber, repoName, org) => {
        try {
            const result = await fetchPrByNumber(prNumber, repoName, org);
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

    ipcMain.handle('pipeline:logErrors', async (_event, config) => {
        try {
            const result = await fetchLogErrors(config);
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

    ipcMain.handle('pipeline:rerun', async (_event, config) => {
        try {
            const result = await rerunFailedJobs(config);
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

    ipcMain.handle('prs:fetch', async (_event, config) => {
        try {
            const result = await fetchPullRequests(config);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: { message: err.message } };
        }
    });

    ipcMain.handle('gh:user', async (_event, login) => {
        try {
            const result = await fetchGithubUser(login);
            return { ok: true, result };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('pr:approve', async (_event, config) => {
        try {
            await approvePr(config);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('pr:merge', async (_event, config) => {
        try {
            await mergePr(config);
            return { ok: true };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    });

    ipcMain.handle('prs:clearCache', () => {
        clearPrListCache();
        return { ok: true };
    });

    ipcMain.handle('notifications:requestPermission', () => {
        if (process.platform !== 'darwin') { return; }
        // Sending a notification from the main process is what triggers the macOS permission dialog
        if (ElectronNotification.isSupported()) {
            new ElectronNotification({
                title: 'Kubernetes Dashboard',
                body: 'Notifications are now enabled.',
            }).show();
        }
    });

    ipcMain.handle('app:buildDate', () => buildDate);

    ipcMain.handle('external:open', (_event, url) => {
        // Only allow safe URLs
        if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
            shell.openExternal(url);
        }
    });

    createWindow();

    const fs = require('node:fs');
    const menu = Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: 'File',
            submenu: [
                {
                    label: 'Export Settings…',
                    accelerator: 'CmdOrCtrl+E',
                    click: async () => {
                        const win = BrowserWindow.getFocusedWindow();
                        const { canceled, filePath } = await dialog.showSaveDialog(win, {
                            title: 'Export Settings',
                            defaultPath: 'kubernetes-dashboard-settings.json',
                            filters: [{ name: 'JSON', extensions: ['json'] }],
                        });
                        if (canceled || !filePath) { return; }
                        const raw = await win.webContents.executeJavaScript('window.__loadRawConfig?.() ?? "{}"');
                        fs.writeFileSync(filePath, JSON.stringify(JSON.parse(raw), null, 2), 'utf8');
                    },
                },
                {
                    label: 'Import Settings…',
                    accelerator: 'CmdOrCtrl+I',
                    click: async () => {
                        const win = BrowserWindow.getFocusedWindow();
                        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
                            title: 'Import Settings',
                            filters: [{ name: 'JSON', extensions: ['json'] }],
                            properties: ['openFile'],
                        });
                        if (canceled || !filePaths.length) { return; }
                        const raw = fs.readFileSync(filePaths[0], 'utf8');
                        const config = JSON.parse(raw);
                        win.webContents.send('settings:import', config);
                    },
                },
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' },
            ],
        },
    ]);
    Menu.setApplicationMenu(menu);

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) { createWindow(); }
    });

    if (app.isPackaged) {
        autoUpdater.checkForUpdates().catch((err) => console.error('[updater] checkForUpdates error:', err));
        setInterval(() => autoUpdater.checkForUpdates().catch((err) => console.error('[updater] checkForUpdates error:', err)), 30 * 60 * 1000);

        autoUpdater.on('error', (err) => console.error('[updater] error:', err));

        autoUpdater.on('update-available', (info) => {
            console.log('[updater] update available:', info.version);
            const win = BrowserWindow.getAllWindows()[0];
            if (win) { win.webContents.send('update-available', info.version); }
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[updater] update downloaded:', info.version);
            const win = BrowserWindow.getAllWindows()[0];
            if (win) { win.webContents.send('update-ready', info.version); }

            if (ElectronNotification.isSupported()) {
                const n = new ElectronNotification({
                    title: 'Update ready',
                    body: `Kubernetes Dashboard ${info.version} downloaded — click to restart and install.`,
                });
                n.on('click', () => autoUpdater.quitAndInstall());
                n.show();
            }
        });

        ipcMain.on('update-install', () => {
            try {
                console.log('[updater] quitAndInstall called');
                autoUpdater.quitAndInstall(false, true);
            } catch (err) {
                console.error('[updater] quitAndInstall error:', err);
            }
        });
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') { app.quit(); }
});
