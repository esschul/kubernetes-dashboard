const fs = require('node:fs');
const path = require('node:path');

const COMMON_BIN_DIRS = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
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
