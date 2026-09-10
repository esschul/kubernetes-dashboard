'use strict';

const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

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

// ── Helpers inlined from renderer-prs.js (no browser globals needed) ─────────

const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot[bot]', 'dependabot']);
function isDependabotPr(pr) { return DEPENDABOT_LOGINS.has(pr.author?.login); }

function getLocalDateKey(d) {
    if (!d) { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`; }
    const date = new Date(d);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

function getPrsForTab(data, { activePrTab, activeMergedSub, mergedSearchPrs }) {
    if (activePrTab === 'merged') {
        const all = [
            ...(data.mergedPullRequests || []),
            ...(data.mergedDependabotPullRequests || []),
            ...(data.mergedYesterdayPullRequests || []),
            ...(data.mergedYesterdayDependabotPullRequests || []),
        ];
        if (activeMergedSub === 'today') {
            const today = getLocalDateKey();
            return all.filter((pr) => pr.mergedAt && getLocalDateKey(pr.mergedAt) === today);
        }
        if (activeMergedSub === 'yesterday') {
            const d = new Date(); d.setDate(d.getDate() - 1);
            const yesterday = getLocalDateKey(d);
            return all.filter((pr) => pr.mergedAt && getLocalDateKey(pr.mergedAt) === yesterday);
        }
        if (activeMergedSub === 'search') { return mergedSearchPrs || []; }
        return all;
    }
    const mergedUrls = new Set([
        ...(data.mergedPullRequests || []).map((p) => p.url),
        ...(data.mergedDependabotPullRequests || []).map((p) => p.url),
        ...(data.mergedYesterdayPullRequests || []).map((p) => p.url),
        ...(data.mergedYesterdayDependabotPullRequests || []).map((p) => p.url),
    ]);
    if (activePrTab === 'dependabot') { return (data.dependabotPullRequests || []).filter((p) => !mergedUrls.has(p.url)); }
    return (data.pullRequests || []).filter((p) => !mergedUrls.has(p.url));
}

// withChecks: preserve known check status from latestPrData when partial arrives with 'none'
function buildWithChecks(latestPrData) {
    const knownChecks = new Map((latestPrData?.pullRequests || []).map((pr) => [pr.url, { checkStatus: pr.checkStatus, checkStatusLabel: pr.checkStatusLabel }]));
    return (prs) => prs.map((pr) => {
        const known = knownChecks.get(pr.url);
        return known && pr.checkStatus === 'none' ? { ...pr, ...known } : pr;
    });
}

function buildPartialView(latestPrData, partial) {
    const withChecks = buildWithChecks(latestPrData);
    const fetchedRepos = new Set(partial.repositories || []);
    return {
        ...latestPrData,
        pullRequests: [
            ...withChecks(partial.pullRequests || []),
            ...(latestPrData?.pullRequests || []).filter((pr) => !fetchedRepos.has(pr.repository)),
        ],
        dependabotPullRequests: latestPrData?.dependabotPullRequests || [],
        mergedPullRequests: latestPrData?.mergedPullRequests || [],
        mergedYesterdayPullRequests: latestPrData?.mergedYesterdayPullRequests || [],
        repositories: partial.repositories || [],
    };
}

// reconcilePrList + patchPrCard inlined for DOM tests
function patchPrCard(live, desired) {
    const liveBody = live.querySelector('.pr-card-body');
    const desiredBody = desired.querySelector('.pr-card-body');
    if (liveBody && desiredBody && liveBody.innerHTML !== desiredBody.innerHTML) {
        liveBody.innerHTML = desiredBody.innerHTML;
    }
}

function reconcilePrList(list, orderedItems, document) {
    const tmp = document.createElement('div');
    const desiredNodes = orderedItems.map((item) => {
        if (item.heading !== undefined) {
            const el = document.createElement('div');
            el.className = 'team-group-heading';
            el.textContent = item.heading;
            el.dataset.headingKey = item.heading;
            return el;
        }
        tmp.innerHTML = item.html;
        const el = tmp.firstElementChild;
        el.dataset.prKey = item.key;
        el.dataset.prHtml = item.html;
        return el;
    });

    const existing = new Map();
    for (const child of list.children) {
        const k = child.dataset.prKey || ('h:' + child.dataset.headingKey);
        if (k) { existing.set(k, child); }
    }

    let refNode = list.firstChild;
    for (const desired of desiredNodes) {
        const k = desired.dataset.prKey || ('h:' + desired.dataset.headingKey);
        const live = existing.get(k);
        if (live) {
            if (desired.dataset.prHtml && live.dataset.prHtml !== desired.dataset.prHtml) {
                live.dataset.prHtml = desired.dataset.prHtml;
                patchPrCard(live, desired);
            }
            if (live !== refNode) { list.insertBefore(live, refNode); }
            else { refNode = live.nextSibling; }
            existing.delete(k);
        } else {
            list.insertBefore(desired, refNode || null);
        }
    }
    for (const old of existing.values()) { old.remove(); }
}

// ── getPrsForTab ──────────────────────────────────────────────────────────────
console.log('\ngetPrsForTab — tab routing');

const openState = { activePrTab: 'open', activeMergedSub: 'today', mergedSearchPrs: null };
const depState  = { activePrTab: 'dependabot', activeMergedSub: 'today', mergedSearchPrs: null };
const mergedState = { activePrTab: 'merged', activeMergedSub: 'all', mergedSearchPrs: null };

test('open tab returns pullRequests', () => {
    const data = { pullRequests: [{ url: 'u1' }, { url: 'u2' }] };
    assert.equal(getPrsForTab(data, openState).length, 2);
});

test('dependabot tab returns dependabotPullRequests', () => {
    const data = { dependabotPullRequests: [{ url: 'u3' }], pullRequests: [] };
    assert.equal(getPrsForTab(data, depState)[0].url, 'u3');
});

test('merged tab (all sub) returns all merged arrays combined', () => {
    const data = {
        mergedPullRequests: [{ url: 'a', mergedAt: '2026-01-01T00:00:00Z' }],
        mergedDependabotPullRequests: [{ url: 'b', mergedAt: '2026-01-01T00:00:00Z' }],
        mergedYesterdayPullRequests: [],
        mergedYesterdayDependabotPullRequests: [],
    };
    assert.equal(getPrsForTab(data, mergedState).length, 2);
});

test('merged tab today sub filters by today date', () => {
    const today = getLocalDateKey();
    const yesterday = getLocalDateKey(new Date(Date.now() - 86400000));
    const data = {
        mergedPullRequests: [
            { url: 'a', mergedAt: `${today}T10:00:00Z` },
            { url: 'b', mergedAt: `${yesterday}T10:00:00Z` },
        ],
        mergedDependabotPullRequests: [], mergedYesterdayPullRequests: [], mergedYesterdayDependabotPullRequests: [],
    };
    const result = getPrsForTab(data, { ...mergedState, activeMergedSub: 'today' });
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'a');
});

test('merged tab search sub returns mergedSearchPrs', () => {
    const searchPrs = [{ url: 'search1' }];
    const data = { mergedPullRequests: [], mergedDependabotPullRequests: [], mergedYesterdayPullRequests: [], mergedYesterdayDependabotPullRequests: [] };
    const result = getPrsForTab(data, { ...mergedState, activeMergedSub: 'search', mergedSearchPrs: searchPrs });
    assert.equal(result[0].url, 'search1');
});

test('open tab excludes PRs also in mergedDependabotPullRequests (stale cache bleed)', () => {
    const data = {
        pullRequests: [{ url: 'open1' }, { url: 'merged-dep' }],
        mergedDependabotPullRequests: [{ url: 'merged-dep' }],
    };
    const result = getPrsForTab(data, openState);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'open1');
});

test('dependabot tab excludes PRs also in mergedDependabotPullRequests', () => {
    const data = {
        dependabotPullRequests: [{ url: 'dep1' }, { url: 'dep-merged' }],
        mergedDependabotPullRequests: [{ url: 'dep-merged' }],
    };
    const result = getPrsForTab(data, depState);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'dep1');
});

// ── withChecks partial-render logic ──────────────────────────────────────────
console.log('\nwithChecks — check status preserved across partial renders');

test('preserves known check status when partial arrives with none', () => {
    const latestPrData = {
        pullRequests: [{ url: 'u1', checkStatus: 'success', checkStatusLabel: 'Checks passing', repository: 'r/a' }],
    };
    const partial = {
        pullRequests: [{ url: 'u1', checkStatus: 'none', checkStatusLabel: 'No checks', repository: 'r/a' }],
        repositories: ['r/a'],
    };
    const view = buildPartialView(latestPrData, partial);
    assert.equal(view.pullRequests[0].checkStatus, 'success', 'check status must survive partial render');
});

test('does not overwrite already-enriched check status in partial', () => {
    const latestPrData = {
        pullRequests: [{ url: 'u2', checkStatus: 'failure', checkStatusLabel: 'Checks failing', repository: 'r/a' }],
    };
    const partial = {
        pullRequests: [{ url: 'u2', checkStatus: 'pending', checkStatusLabel: 'Checks pending', repository: 'r/a' }],
        repositories: ['r/a'],
    };
    const view = buildPartialView(latestPrData, partial);
    // partial has 'pending' (not 'none') → withChecks should NOT replace it
    assert.equal(view.pullRequests[0].checkStatus, 'pending');
});

test('keeps PRs from un-fetched repos in partial view', () => {
    const latestPrData = {
        pullRequests: [
            { url: 'u1', repository: 'r/fetched', checkStatus: 'success', checkStatusLabel: 'Checks passing' },
            { url: 'u2', repository: 'r/not-fetched', checkStatus: 'success', checkStatusLabel: 'Checks passing' },
        ],
    };
    const partial = {
        pullRequests: [{ url: 'u1', checkStatus: 'none', checkStatusLabel: 'No checks', repository: 'r/fetched' }],
        repositories: ['r/fetched'],
    };
    const view = buildPartialView(latestPrData, partial);
    assert.equal(view.pullRequests.length, 2, 'PR from un-fetched repo must be kept');
    const unfetched = view.pullRequests.find((p) => p.url === 'u2');
    assert.ok(unfetched, 'un-fetched repo PR must be present');
});

test('new PR in partial that was not in latestPrData gets none status (no cache hit)', () => {
    const latestPrData = { pullRequests: [] };
    const partial = {
        pullRequests: [{ url: 'new', checkStatus: 'none', checkStatusLabel: 'No checks', repository: 'r/a' }],
        repositories: ['r/a'],
    };
    const view = buildPartialView(latestPrData, partial);
    assert.equal(view.pullRequests[0].checkStatus, 'none');
});

// ── reconcilePrList (DOM) ─────────────────────────────────────────────────────
console.log('\nreconcilePrList — DOM reconciliation');

function makeList(doc) {
    const el = doc.createElement('div');
    el.id = 'prList';
    doc.body.appendChild(el);
    return el;
}

function cardHtml(key, label) {
    return `<div class="pr-card"><div class="pr-card-body"><span>${label}</span></div></div>`;
}

test('adds new cards to empty list', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    const list = makeList(document);
    reconcilePrList(list, [{ key: 'repo/1', html: cardHtml('repo/1', 'PR 1') }], document);
    assert.equal(list.children.length, 1);
    assert.equal(list.querySelector('.pr-card-body span').textContent, 'PR 1');
});

test('removes cards no longer in the list (tab switch)', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    const list = makeList(document);
    reconcilePrList(list, [
        { key: 'repo/1', html: cardHtml('repo/1', 'PR 1') },
        { key: 'repo/2', html: cardHtml('repo/2', 'PR 2') },
    ], document);
    assert.equal(list.children.length, 2);

    // Switch to a list with only one card — simulates merged → open tab switch
    reconcilePrList(list, [{ key: 'repo/3', html: cardHtml('repo/3', 'PR 3') }], document);
    assert.equal(list.children.length, 1, 'old cards must be removed');
    assert.equal(list.querySelector('.pr-card-body span').textContent, 'PR 3');
});

test('updates card body when HTML changes', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    const list = makeList(document);
    reconcilePrList(list, [{ key: 'repo/1', html: cardHtml('repo/1', 'Old label') }], document);
    reconcilePrList(list, [{ key: 'repo/1', html: cardHtml('repo/1', 'New label') }], document);
    assert.equal(list.querySelector('.pr-card-body span').textContent, 'New label');
});

test('does not re-create card when HTML is unchanged (avatar preservation)', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    const list = makeList(document);
    reconcilePrList(list, [{ key: 'repo/1', html: cardHtml('repo/1', 'PR 1') }], document);
    const original = list.firstElementChild;
    reconcilePrList(list, [{ key: 'repo/1', html: cardHtml('repo/1', 'PR 1') }], document);
    assert.equal(list.firstElementChild, original, 'same DOM node must be reused');
});

test('heading nodes are removed when switching away', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    const list = makeList(document);
    reconcilePrList(list, [
        { heading: 'Team A' },
        { key: 'repo/1', html: cardHtml('repo/1', 'PR 1') },
    ], document);
    assert.equal(list.children.length, 2);
    reconcilePrList(list, [{ key: 'repo/2', html: cardHtml('repo/2', 'PR 2') }], document);
    assert.equal(list.children.length, 1, 'heading must be removed with its group');
});
