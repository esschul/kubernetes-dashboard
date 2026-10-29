'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listPullRequests, listTrelloCards, listPipelineRuns, listDeployments, getDeployment, dashboardStatus, freshness, validateArgs, TOOLS, trelloShortLink } = require('./tools');
const { respond } = require('./server');

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
    }
}

const NOW = new Date('2026-10-29T10:00:00Z');
const card = (id, slug) => ({ id, slug, url: `https://trello.com/c/${id}` });

const SNAPSHOT = {
    version: 1,
    writtenAt: '2026-10-29T09:55:00Z',
    app: { version: '1.1.77', pid: 4242, startedAt: '2026-10-29T08:00:00Z' },
    pullRequests: {
        fetchedAt: '2026-10-29T09:54:00Z',
        lastError: null,
        pullRequests: [
            { repository: 'posten/checkout-api', number: 1, url: 'u1', title: 'Validate booking', author: { login: 'espen' }, headRefName: 'validate-booking_xRqkAzIU', trelloCard: card('xRqkAzIU', 'validate-booking') },
            { repository: 'posten/pickup-point', number: 2, url: 'u2', title: 'Validate in pickup', author: { login: 'kari' }, headRefName: 'validate-booking_xRqkAzIU', trelloCard: card('xRqkAzIU', 'validate-booking') },
            { repository: 'posten/pickup-point', number: 3, url: 'u3', title: 'Hotfix', author: { login: 'kari' }, headRefName: 'hotfix', trelloCard: null },
        ],
        dependabotPullRequests: [
            { repository: 'posten/checkout-api', number: 4, url: 'u4', title: 'Bump electron', author: { login: 'dependabot' }, headRefName: 'dependabot/npm/electron', trelloCard: null },
        ],
        mergedPullRequests: [
            { repository: 'posten/checkout-api', number: 5, url: 'u5', title: 'Earlier part', author: { login: 'espen' }, headRefName: 'validate-booking_xRqkAzIU', mergedAt: '2026-10-29T08:00:00Z', trelloCard: card('xRqkAzIU', 'validate-booking') },
        ],
        mergedYesterdayPullRequests: [],
    },
    pipelines: {
        'https://dev.azure.com/posten/bring': {
            fetchedAt: '2026-10-29T09:50:00Z',
            lastError: null,
            runs: [
                { id: 10, name: 'checkout-api', repoName: 'checkout-api', result: 'failed', sourceBranch: 'PR #1', startTime: '2026-10-29T09:00:00Z' },
                { id: 11, name: 'pickup-point', repoName: 'pickup-point', result: 'succeeded', sourceBranch: 'master', startTime: '2026-10-29T09:30:00Z' },
            ],
        },
    },
    deployments: {
        'qa/checkout': {
            context: 'qa', namespace: 'checkout', fetchedAt: '2026-10-29T09:40:00Z', lastError: { at: '2026-10-29T09:52:00Z', message: 'VPN' },
            deployments: [
                { name: 'checkout-api', namespace: 'checkout', status: 'healthy', ready: 2, desired: 2, image: 'img:1', gitSha: 'abc', pods: [{ name: 'p1' }] },
                { name: 'pickup-point', namespace: 'checkout', status: 'crash-loop', ready: 0, desired: 2, image: 'img:2', gitSha: 'def', pods: [] },
            ],
        },
    },
};

console.log('\nmcp tools');

test('lists open human PRs by default, filtered by repo and card', () => {
    assert.deepEqual(listPullRequests(SNAPSHOT).items.map((p) => p.number), [1, 2, 3]);
    assert.deepEqual(listPullRequests(SNAPSHOT, { repo: 'pickup' }).items.map((p) => p.number), [2, 3]);
    assert.deepEqual(listPullRequests(SNAPSHOT, { state: 'all', trelloCard: 'xRqkAzIU' }).items.map((p) => p.number), [1, 2, 5]);
    assert.deepEqual(listPullRequests(SNAPSHOT, { includeBots: true }).items.map((p) => p.number), [1, 2, 3, 4]);
    assert.equal(listPullRequests(SNAPSHOT).items[0].author, 'espen');
});

test('groups PRs by Trello card across repos and states', () => {
    const { items: cards, pullRequestsWithoutCard } = listTrelloCards(SNAPSHOT);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].card.id, 'xRqkAzIU');
    assert.deepEqual(cards[0].pullRequests.map((p) => p.number), [1, 2, 5]);
    assert.equal(pullRequestsWithoutCard, 1);
    assert.deepEqual(listTrelloCards(SNAPSHOT, { includeMerged: false }).items[0].pullRequests.map((p) => p.number), [1, 2]);
});

test('lists pipeline runs newest first, filtered by result', () => {
    assert.deepEqual(listPipelineRuns(SNAPSHOT).items.map((r) => r.id), [11, 10]);
    assert.deepEqual(listPipelineRuns(SNAPSHOT, { result: 'failed' }).items.map((r) => r.id), [10]);
    assert.deepEqual(listPipelineRuns(SNAPSHOT, { branch: 'PR #1' }).items.map((r) => r.id), [10]);
});

test('lists deployments without pods, and only failing ones on request', () => {
    const all = listDeployments(SNAPSHOT).items;
    assert.equal(all.length, 2);
    assert.equal(all[0].pods, undefined);
    assert.deepEqual(listDeployments(SNAPSHOT, { unhealthyOnly: true }).items.map((d) => d.name), ['pickup-point']);
    assert.deepEqual(listDeployments(SNAPSHOT, { context: 'prod' }).items, []);
});

test('get_deployment returns the full object for an exact name', () => {
    const [dep] = getDeployment(SNAPSHOT, { name: 'checkout-api' });
    assert.deepEqual(dep.pods, [{ name: 'p1' }]);
    assert.equal(dep.source, 'qa/checkout');
    assert.deepEqual(getDeployment(SNAPSHOT, { name: 'checkout' }), []);
});

test('dashboard_status shows age and last error per part', () => {
    const status = dashboardStatus(SNAPSHOT, {}, { now: NOW });
    assert.equal(status.pullRequests.ageMinutes, 6);
    assert.equal(status.pullRequests.open, 4);
    assert.equal(status.pipelines[0].ageMinutes, 10);
    assert.equal(status.deployments[0].lastError.message, 'VPN');
    assert.equal(status.app.version, '1.1.77');
});

test('freshness reports age, whether the app runs and staleness', () => {
    assert.deepEqual(freshness(SNAPSHOT, { now: NOW, isAlive: () => true }), {
        writtenAt: '2026-10-29T09:55:00Z', ageMinutes: 5, appRunning: true, stale: false,
    });
    const old = freshness(SNAPSHOT, { now: new Date('2026-10-29T11:00:00Z'), isAlive: () => false });
    assert.equal(old.stale, true);
    assert.equal(old.appRunning, false);
});

console.log('\nmcp server');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-dashboard-mcp-'));
const snapshotPath = path.join(dir, 'snapshot.json');
fs.writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT));
const options = { snapshotPath, now: NOW, isAlive: () => false };

test('initialize echoes a supported protocol version', () => {
    const reply = respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, options);
    assert.equal(reply.result.protocolVersion, '2025-03-26');
    assert.deepEqual(reply.result.capabilities, { tools: {} });
});

test('notifications get no reply and unknown methods an error', () => {
    assert.equal(respond({ jsonrpc: '2.0', method: 'notifications/initialized' }, options), null);
    assert.equal(respond({ jsonrpc: '2.0', id: 2, method: 'resources/list' }, options).error.code, -32601);
});

test('tools/list exposes every tool with a schema', () => {
    const { tools } = respond({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, options).result;
    assert.deepEqual(tools.map((t) => t.name), ['dashboard_status', 'list_pull_requests', 'list_trello_cards', 'list_pipeline_runs', 'list_deployments', 'get_deployment']);
    assert.ok(tools.every((t) => t.inputSchema.type === 'object'));
});

test('tools/call wraps the result with snapshot freshness', () => {
    const reply = respond({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_trello_cards', arguments: {} } }, options);
    const body = JSON.parse(reply.result.content[0].text);
    assert.equal(body.snapshot.ageMinutes, 5);
    assert.equal(body.snapshot.appRunning, false);
    assert.match(body.snapshot.note, /not running/);
    assert.equal(body.result.items[0].card.id, 'xRqkAzIU');
});

test('tools/call reports a missing snapshot as a tool error', () => {
    const reply = respond({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'dashboard_status' } }, { snapshotPath: path.join(dir, 'missing.json') });
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /Start Kubernetes Dashboard/);
});

console.log('\nmcp fixes from client testing');

const call = (name, args, opts = options) => respond({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, opts);

test('null, arrays, null ids and client responses are handled', () => {
    assert.equal(respond(null, options).error.code, -32600);
    assert.equal(respond(42, options).error.code, -32600);
    assert.equal(respond([], options).error.code, -32600);
    assert.equal(respond({ jsonrpc: '2.0', id: null, method: 'ping' }, options).error.code, -32600);
    assert.equal(respond({ jsonrpc: '2.0', id: 9, result: {} }, options), null);
    const batch = respond([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'ping' }], options);
    assert.deepEqual(batch.map((r) => r.id), [1, 2]);
});

test('unknown tool is a -32602 protocol error', () => {
    assert.equal(call('nope', {}).error.code, -32602);
});

test('bad arguments come back as tool errors the model can fix', () => {
    for (const [name, args, msg] of [
        ['get_deployment', {}, /"name" is required/],
        ['get_deployment', { name: 123 }, /must be a string/],
        ['list_pipeline_runs', { limit: -1 }, /at least 1/],
        ['list_pipeline_runs', { limit: '5' }, /must be an integer/],
        ['list_pull_requests', { includeBots: 'false' }, /must be a boolean/],
        ['list_pull_requests', { state: 'closed' }, /one of open, merged, all/],
        ['list_pull_requests', { repoName: 'x' }, /Unknown argument "repoName"/],
    ]) {
        const reply = call(name, args);
        assert.equal(reply.result.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(reply.result.content[0].text, msg);
    }
});

test('lists are limited and report the total', () => {
    const many = { ...SNAPSHOT, pullRequests: { ...SNAPSHOT.pullRequests, pullRequests: Array.from({ length: 120 }, (_, i) => ({ repository: 'r', number: i, url: `x${i}`, author: { login: 'a' } })) } };
    const out = listPullRequests(many, {});
    assert.equal(out.total, 120);
    assert.equal(out.returned, 50);
    assert.equal(listPullRequests(many, { limit: 5 }).items.length, 5);
});

test('results are compact JSON', () => {
    const text = call('dashboard_status', {}).result.content[0].text;
    assert.equal(text.includes('\n'), false);
});

test('fetch errors and missing data show up next to list results', () => {
    const body = JSON.parse(call('list_deployments', { context: 'qa' }).result.content[0].text);
    assert.equal(body.snapshot.sources[0].source, 'qa/checkout');
    assert.match(body.snapshot.warnings[0], /last fetch failed .* \(VPN\)/);
    const none = JSON.parse(call('list_deployments', { context: 'prod' }).result.content[0].text);
    assert.match(none.snapshot.warnings[0], /no data, not because there is nothing/);
    const unfetched = { ...SNAPSHOT, pullRequests: { fetchedAt: null, lastError: null } };
    fs.writeFileSync(path.join(dir, 'unfetched.json'), JSON.stringify(unfetched));
    const prs = JSON.parse(call('list_pull_requests', {}, { ...options, snapshotPath: path.join(dir, 'unfetched.json') }).result.content[0].text);
    assert.match(prs.snapshot.warnings[0], /never fetched/);
});

test('bad or future timestamps are stale', () => {
    assert.equal(freshness({ writtenAt: 'garbage' }, { now: NOW }).stale, true);
    assert.equal(freshness({ writtenAt: '2026-10-29T11:00:00Z' }, { now: NOW }).stale, true);
});

test('broken snapshot files name the file', () => {
    for (const [file, content, msg] of [['empty.json', '', /Could not read the snapshot at .*empty\.json/], ['null.json', 'null', /not a JSON object/]]) {
        fs.writeFileSync(path.join(dir, file), content);
        const reply = call('dashboard_status', {}, { snapshotPath: path.join(dir, file) });
        assert.equal(reply.result.isError, true);
        assert.match(reply.result.content[0].text, msg);
    }
});

test('filters are forgiving about case, partial names and Trello URLs', () => {
    assert.equal(listDeployments(SNAPSHOT, { context: 'QA', namespace: 'CHECK' }).total, 2);
    assert.equal(getDeployment(SNAPSHOT, { name: 'Checkout-API' }).length, 1);
    assert.equal(trelloShortLink('https://trello.com/c/xRqkAzIU/123-validate-booking'), 'xRqkAzIU');
    assert.equal(trelloShortLink('validate-booking_xRqkAzIU'), 'xRqkAzIU');
    assert.equal(listPullRequests(SNAPSHOT, { trelloCard: 'https://trello.com/c/xRqkAzIU' }).total, 2);
});

test('every tool is annotated read-only and validates its own schema', () => {
    for (const tool of TOOLS) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.deepEqual(validateArgs(tool, tool.inputSchema.required ? { name: 'x' } : {}), tool.inputSchema.required ? { name: 'x' } : {});
    }
});
