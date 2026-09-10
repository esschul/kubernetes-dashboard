const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = os.homedir();
const COMMON_BIN_DIRS = [
    ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : []),
    ...(process.platform === 'linux' ? [
        '/home/linuxbrew/.linuxbrew/bin',   // Homebrew on Linux (system install)
        `${home}/.linuxbrew/bin`,           // Homebrew on Linux (per-user install)
    ] : []),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    `${home}/.krew/bin`,   // kubectl krew plugins (e.g. kubelogin for AKS)
];

function resolveCommand(command, envVarName) {
    const configured = process.env[envVarName];
    if (configured) { return configured; }

    for (const dir of getSearchDirs()) {
        const candidate = path.join(dir, command);
        if (fs.existsSync(candidate)) { return candidate; }
    }

    return command;
}

function getSearchDirs() {
    const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    return [...new Set([...pathDirs, ...COMMON_BIN_DIRS])];
}

module.exports = { resolveCommand };
