#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { TOOLS, ToolInputError, freshness, validateArgs, sourcesFor, sourceWarnings } = require('./tools');

const SERVER_INFO = { name: 'kubernetes-dashboard', version: require('../package.json').version };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function defaultSnapshotPath() {
    const base = process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(base, 'kubernetes-dashboard', 'snapshot.json');
}

function readSnapshot(file) {
    let snapshot;
    try {
        snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`No snapshot at ${file}. Start Kubernetes Dashboard and let it refresh once.`, { cause: err });
        }
        throw new Error(`Could not read the snapshot at ${file}: ${err.message}`, { cause: err });
    }
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error(`The snapshot at ${file} is not a JSON object.`);
    }
    return snapshot;
}

function findTool(name) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) { throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 }); }
    return tool;
}

function callTool(name, args, { snapshotPath, now = new Date(), isAlive } = {}) {
    const tool = findTool(name);
    const validArgs = validateArgs(tool, args);
    const snapshot = readSnapshot(snapshotPath);
    const fresh = freshness(snapshot, { now, isAlive });
    if (!fresh.appRunning) {
        fresh.note = 'Kubernetes Dashboard is not running, so this data is not being updated.';
    } else if (fresh.stale) {
        fresh.note = 'The snapshot has not been written for a while, or has a bad timestamp; the app may be idle or failing to fetch. See dashboard_status.';
    }
    if (tool.section) {
        fresh.sources = sourcesFor(tool.section, snapshot, validArgs, now);
        const warnings = sourceWarnings(tool.section, fresh.sources);
        if (warnings.length) { fresh.warnings = warnings; }
    }
    return { snapshot: fresh, result: tool.run(snapshot, validArgs, { now }) };
}

function handle(message, options) {
    const { id, method, params } = message;
    switch (method) {
    case 'initialize': {
        const requested = params?.protocolVersion;
        return {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions: 'Read-only view of what Kubernetes Dashboard last fetched: PRs (with Trello cards), Azure DevOps pipeline runs and Kubernetes deployments. Every result starts with snapshot freshness; mention it when the data is stale.',
        };
    }
    case 'ping':
        return {};
    case 'tools/list':
        return { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) };
    case 'tools/call':
        findTool(params?.name);
        try {
            const output = callTool(params.name, params.arguments, options);
            return { content: [{ type: 'text', text: JSON.stringify(output) }] };
        } catch (err) {
            if (!(err instanceof ToolInputError) && err.code) { throw err; }
            return { content: [{ type: 'text', text: err.message }], isError: true };
        }
    default:
        if (id === undefined) { return undefined; }
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
}

function invalidRequest(id, message) {
    return { jsonrpc: '2.0', id, error: { code: -32600, message } };
}

function respondOne(message, options) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return invalidRequest(null, 'Invalid Request: expected a JSON-RPC object');
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    const validId = typeof message.id === 'string' || typeof message.id === 'number';
    if (typeof message.method !== 'string') {
        if (hasId && ('result' in message || 'error' in message)) { return null; }
        return invalidRequest(validId ? message.id : null, 'Invalid Request: missing method');
    }
    if (!hasId) {
        try { handle(message, options); } catch { /* notifications get no reply */ }
        return null;
    }
    if (!validId) { return invalidRequest(null, 'Invalid Request: id must be a string or a number'); }
    try {
        return { jsonrpc: '2.0', id: message.id, result: handle(message, options) };
    } catch (err) {
        return { jsonrpc: '2.0', id: message.id, error: { code: err.code || -32603, message: err.message } };
    }
}

function respond(message, options) {
    if (!Array.isArray(message)) { return respondOne(message, options); }
    if (!message.length) { return invalidRequest(null, 'Invalid Request: empty batch'); }
    const replies = message.map((m) => respondOne(m, options)).filter(Boolean);
    return replies.length ? replies : null;
}

function main() {
    const options = { snapshotPath: process.env.KUBE_DASHBOARD_SNAPSHOT || defaultSnapshotPath() };
    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        if (!line.trim()) { return; }
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
            return;
        }
        const reply = respond(message, options);
        if (reply) { process.stdout.write(`${JSON.stringify(reply)}\n`); }
    });
}

if (require.main === module) { main(); }

module.exports = { respond, callTool, defaultSnapshotPath };
