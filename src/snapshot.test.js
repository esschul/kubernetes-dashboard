'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSnapshotStore, SNAPSHOT_VERSION } = require('./snapshot');

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
    }
}

const FIXED_NOW = new Date('2026-10-29T10:00:00Z');

function makeStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-dashboard-snapshot-'));
    const file = path.join(dir, 'snapshot.json');
    return { file, store: createSnapshotStore(file, { delayMs: 60_000, now: () => FIXED_NOW, app: { version: '1.2.3' } }) };
}

(async () => {
    console.log('\ncreateSnapshotStore');

    await test('writes an empty snapshot with version, timestamps and app info', async () => {
        const { file, store } = makeStore();
        await store.flush();
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
            version: SNAPSHOT_VERSION,
            writtenAt: FIXED_NOW.toISOString(),
            app: { version: '1.2.3', pid: process.pid, startedAt: FIXED_NOW.toISOString() },
            pullRequests: { fetchedAt: null, lastError: null },
            pipelines: {},
            deployments: {},
        });
    });

    await test('records when PRs were fetched and the last error', async () => {
        const { store } = makeStore();
        store.setPullRequests({ pullRequests: [] });
        store.setPullRequestsError(new Error('gh: rate limited'));
        const prs = store.build().pullRequests;
        assert.equal(prs.fetchedAt, FIXED_NOW.toISOString());
        assert.deepEqual(prs.lastError, { at: FIXED_NOW.toISOString(), message: 'gh: rate limited' });
        assert.deepEqual(prs.pullRequests, []);
        store.setPullRequests({ pullRequests: [] });
        assert.equal(store.build().pullRequests.lastError, null);
    });

    await test('keeps the last good deployments when a fetch fails', async () => {
        const { store } = makeStore();
        store.setDeployments({ context: 'qa', namespace: 'checkout' }, [{ name: 'checkout-api' }]);
        store.setDeploymentsError({ context: 'qa', namespace: 'checkout' }, new Error('Could not reach the cluster'));
        store.setPipelinesError({ org: 'posten', project: 'bring' }, new Error('az: not logged in'));
        const snap = store.build();
        assert.deepEqual(snap.deployments['qa/checkout'].deployments, [{ name: 'checkout-api' }]);
        assert.equal(snap.deployments['qa/checkout'].lastError.message, 'Could not reach the cluster');
        assert.deepEqual(snap.pipelines['posten/bring'], {
            fetchedAt: null,
            lastError: { at: FIXED_NOW.toISOString(), message: 'az: not logged in' },
        });
    });

    await test('adds the Trello card to every PR list', async () => {
        const { store } = makeStore();
        store.setPullRequests({
            pullRequests: [{ number: 1, headRefName: 'add-booking-validation_xRqkAzIU' }],
            mergedPullRequests: [{ number: 2, headRefName: 'feat/retry-logic' }],
            repositories: ['posten/checkout-api'],
        });
        const snap = store.build();
        assert.deepEqual(snap.pullRequests.pullRequests[0].trelloCard, {
            id: 'xRqkAzIU',
            slug: 'add-booking-validation',
            url: 'https://trello.com/c/xRqkAzIU',
        });
        assert.equal(snap.pullRequests.mergedPullRequests[0].trelloCard, null);
        assert.deepEqual(snap.pullRequests.repositories, ['posten/checkout-api']);
    });

    await test('keys deployments by context and namespace, pipelines by org and project', async () => {
        const { store } = makeStore();
        store.setDeployments({ context: 'qa', namespace: 'checkout' }, [{ name: 'checkout-api' }]);
        store.setDeployments({ namespace: 'checkout' }, [{ name: 'pickup-point' }]);
        store.setPipelines({ org: 'posten', project: 'bring' }, [{ id: 7 }]);
        const snap = store.build();
        assert.deepEqual(Object.keys(snap.deployments), ['qa/checkout', '(current)/checkout']);
        assert.deepEqual(snap.deployments['qa/checkout'], {
            context: 'qa',
            namespace: 'checkout',
            fetchedAt: FIXED_NOW.toISOString(),
            lastError: null,
            deployments: [{ name: 'checkout-api' }],
        });
        assert.deepEqual(snap.pipelines['posten/bring'].runs, [{ id: 7 }]);
    });

    await test('applies late check results to every list holding the PR', async () => {
        const { store } = makeStore();
        store.setPullRequests({
            pullRequests: [],
            dependabotPullRequests: [{ url: 'u828', number: 828, checkStatus: 'none' }],
            mergedPullRequests: [{ url: 'other', checkStatus: 'none' }],
        });
        store.applyCheckStatus({ url: 'u828', checkStatus: 'failure', checkStatusLabel: 'Checks failing' });
        const snap = store.build();
        assert.equal(snap.pullRequests.dependabotPullRequests[0].checkStatus, 'failure');
        assert.equal(snap.pullRequests.dependabotPullRequests[0].checkStatusLabel, 'Checks failing');
        assert.equal(snap.pullRequests.mergedPullRequests[0].checkStatus, 'none');
    });

    await test('replaces the file in one step and leaves no temp file', async () => {
        const { file, store } = makeStore();
        store.setPipelines({ org: 'posten', project: 'bring' }, []);
        await store.flush();
        store.setPipelines({ org: 'posten', project: 'bring' }, [{ id: 1 }]);
        await store.flush();
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pipelines['posten/bring'].runs, [{ id: 1 }]);
        assert.equal(fs.existsSync(`${file}.tmp`), false);
    });
})();
