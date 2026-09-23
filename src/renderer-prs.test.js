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
        const seen = new Set();
        const dedup = (arr) => (arr || []).filter((p) => { if (seen.has(p.url)) { return false; } seen.add(p.url); return true; });
        const all = [
            ...dedup(data.mergedPullRequests),
            ...dedup(data.mergedDependabotPullRequests),
            ...dedup(data.mergedYesterdayPullRequests),
            ...dedup(data.mergedYesterdayDependabotPullRequests),
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

test('merged tab deduplicates PRs that appear in multiple lists', () => {
    const pr = { url: 'dup', mergedAt: '2026-01-01T00:00:00Z' };
    const data = {
        mergedPullRequests: [pr],
        mergedDependabotPullRequests: [pr],
        mergedYesterdayPullRequests: [pr],
        mergedYesterdayDependabotPullRequests: [],
    };
    assert.equal(getPrsForTab(data, mergedState).length, 1);
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

// ── Group-by-repo logic ───────────────────────────────────────────────────────
console.log('\ngroup-by-repo — ordering and grouping');

function buildGroupedItems(filtered, sortKey) {
    const orderedItems = [];
    const repoNames = [...new Set(filtered.map((p) => p.repository))].sort();
    const groups = new Map(repoNames.map((r) => [r, []]));
    filtered.forEach((pr) => { groups.get(pr.repository)?.push(pr); });
    for (const [repo, groupPrs] of groups) {
        if (!groupPrs.length) { continue; }
        const sortedGroup = [...groupPrs].sort((a, b) => String(sortKey(b)).localeCompare(String(sortKey(a))));
        const shortName = repo.split('/')[1] || repo;
        orderedItems.push({ heading: shortName });
        sortedGroup.forEach((pr) => orderedItems.push({ key: `${pr.repository}/${pr.number}` }));
    }
    return orderedItems;
}

test('repos are grouped alphabetically', () => {
    const prs = [
        { repository: 'acme/z-service', number: 1, updatedAt: '2026-01-01' },
        { repository: 'acme/a-service', number: 2, updatedAt: '2026-01-01' },
        { repository: 'acme/m-service', number: 3, updatedAt: '2026-01-01' },
    ];
    const items = buildGroupedItems(prs, (pr) => pr.updatedAt);
    const headings = items.filter((i) => i.heading).map((i) => i.heading);
    assert.deepEqual(headings, ['a-service', 'm-service', 'z-service']);
});

test('PRs within a group are sorted by updatedAt descending', () => {
    const prs = [
        { repository: 'acme/repo', number: 1, updatedAt: '2026-01-01T10:00:00Z' },
        { repository: 'acme/repo', number: 2, updatedAt: '2026-01-03T10:00:00Z' },
        { repository: 'acme/repo', number: 3, updatedAt: '2026-01-02T10:00:00Z' },
    ];
    const items = buildGroupedItems(prs, (pr) => pr.updatedAt);
    const keys = items.filter((i) => i.key).map((i) => i.key);
    assert.deepEqual(keys, ['acme/repo/2', 'acme/repo/3', 'acme/repo/1']);
});

test('each repo gets exactly one heading', () => {
    const prs = [
        { repository: 'acme/svc', number: 1, updatedAt: '2026-01-01' },
        { repository: 'acme/svc', number: 2, updatedAt: '2026-01-02' },
        { repository: 'acme/other', number: 3, updatedAt: '2026-01-01' },
    ];
    const items = buildGroupedItems(prs, (pr) => pr.updatedAt);
    assert.equal(items.filter((i) => i.heading === 'svc').length, 1);
    assert.equal(items.filter((i) => i.heading === 'other').length, 1);
    assert.equal(items.filter((i) => i.key).length, 3);
});

test('repo short name uses segment after slash', () => {
    const prs = [{ repository: 'org/my-cool-service', number: 1, updatedAt: '2026-01-01' }];
    const items = buildGroupedItems(prs, (pr) => pr.updatedAt);
    assert.equal(items[0].heading, 'my-cool-service');
});

test('repo with no slash uses full name as heading', () => {
    const prs = [{ repository: 'standalone', number: 1, updatedAt: '2026-01-01' }];
    const items = buildGroupedItems(prs, (pr) => pr.updatedAt);
    assert.equal(items[0].heading, 'standalone');
});

// ── Bulk actions — DOM ────────────────────────────────────────────────────────
console.log('\nbulk actions — selection state and bar updates');

function makeBulkDom(doc) {
    doc.body.innerHTML = `
        <div id="prList"></div>
        <div id="prBulkBar" class="hidden">
            <label><input type="checkbox" id="prBulkSelectAll"><span id="prBulkCount"></span></label>
            <button id="prBulkApprove" disabled>Approve</button>
            <button id="prBulkClose" disabled>Close</button>
            <button id="prBulkMerge" disabled>Merge approved</button>
        </div>`;
    return doc;
}

function addCheckboxCard(list, doc, { key, repo, number, approved = false, checked = false }) {
    const card = doc.createElement('div');
    card.className = 'pr-card';
    const label = doc.createElement('label');
    label.className = 'pr-select-col';
    const cb = doc.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'pr-select-cb';
    cb.dataset.prKey = key;
    cb.dataset.prRepo = repo;
    cb.dataset.prNumber = String(number);
    cb.dataset.prApproved = approved ? '1' : '';
    cb.checked = checked;
    label.appendChild(cb);
    card.appendChild(label);
    list.appendChild(card);
    return cb;
}

function updateBulkBar(selectedPrKeys, doc, activePrTab = 'dependabot') {
    const bar = doc.getElementById('prBulkBar');
    bar.classList.toggle('hidden', activePrTab !== 'dependabot');
    const count = selectedPrKeys.size;
    const allCbs = [...doc.querySelectorAll('#prList .pr-select-cb')];
    const total = allCbs.length;
    const countLabel = count === 0 ? (total > 0 ? `Select all (${total})` : 'No PRs') : `${count} of ${total} selected`;
    doc.getElementById('prBulkCount').textContent = countLabel;
    const selectAll = doc.getElementById('prBulkSelectAll');
    selectAll.indeterminate = count > 0 && count < total;
    selectAll.checked = total > 0 && count === total;
    const approvedCount = allCbs.filter((cb) => selectedPrKeys.has(cb.dataset.prKey) && cb.dataset.prApproved === '1').length;
    const mergeBtn = doc.getElementById('prBulkMerge');
    mergeBtn.textContent = approvedCount > 0 ? `Merge approved (${approvedCount})` : 'Merge approved';
    mergeBtn.disabled = count === 0;
    doc.getElementById('prBulkApprove').disabled = count === 0;
    doc.getElementById('prBulkClose').disabled = count === 0;
}

test('bulk bar is hidden when not on dependabot tab', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const sel = new Set(['r/1']);
    addCheckboxCard(document.getElementById('prList'), document, { key: 'r/1', repo: 'r', number: 1, checked: true });
    updateBulkBar(sel, document, 'open');
    assert.ok(document.getElementById('prBulkBar').classList.contains('hidden'));
});

test('bulk bar is always visible on dependabot tab even with nothing selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const sel = new Set();
    addCheckboxCard(document.getElementById('prList'), document, { key: 'r/1', repo: 'r', number: 1 });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(!document.getElementById('prBulkBar').classList.contains('hidden'));
    assert.equal(document.getElementById('prBulkCount').textContent, 'Select all (1)');
});

test('action buttons are disabled when nothing is selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const sel = new Set();
    addCheckboxCard(document.getElementById('prList'), document, { key: 'r/1', repo: 'r', number: 1 });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(document.getElementById('prBulkApprove').disabled);
    assert.ok(document.getElementById('prBulkClose').disabled);
    assert.ok(document.getElementById('prBulkMerge').disabled);
});

test('count label shows "X of Y selected" when something is selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const list = document.getElementById('prList');
    const sel = new Set(['r/1']);
    addCheckboxCard(list, document, { key: 'r/1', repo: 'r', number: 1, checked: true });
    addCheckboxCard(list, document, { key: 'r/2', repo: 'r', number: 2 });
    updateBulkBar(sel, document, 'dependabot');
    assert.equal(document.getElementById('prBulkCount').textContent, '1 of 2 selected');
});

test('merge button disabled when nothing selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const sel = new Set();
    addCheckboxCard(document.getElementById('prList'), document, { key: 'r/1', repo: 'r', number: 1, approved: true });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(document.getElementById('prBulkMerge').disabled);
});

test('merge button enabled and shows count for approved selected PRs', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const list = document.getElementById('prList');
    const sel = new Set(['r/1', 'r/2']);
    addCheckboxCard(list, document, { key: 'r/1', repo: 'r', number: 1, approved: true, checked: true });
    addCheckboxCard(list, document, { key: 'r/2', repo: 'r', number: 2, approved: false, checked: true });
    updateBulkBar(sel, document, 'dependabot');
    const mergeBtn = document.getElementById('prBulkMerge');
    assert.ok(!mergeBtn.disabled);
    assert.equal(mergeBtn.textContent, 'Merge approved (1)');
});

test('select-all checkbox is indeterminate when partially selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const list = document.getElementById('prList');
    const sel = new Set(['r/1']);
    addCheckboxCard(list, document, { key: 'r/1', repo: 'r', number: 1, checked: true });
    addCheckboxCard(list, document, { key: 'r/2', repo: 'r', number: 2, checked: false });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(document.getElementById('prBulkSelectAll').indeterminate);
});

test('select-all checkbox is checked when all are selected', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const list = document.getElementById('prList');
    const sel = new Set(['r/1', 'r/2']);
    addCheckboxCard(list, document, { key: 'r/1', repo: 'r', number: 1, checked: true });
    addCheckboxCard(list, document, { key: 'r/2', repo: 'r', number: 2, checked: true });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(document.getElementById('prBulkSelectAll').checked);
    assert.ok(!document.getElementById('prBulkSelectAll').indeterminate);
});

test('clearing selection disables action buttons but keeps bar visible on dependabot tab', () => {
    const { document } = new JSDOM('<!DOCTYPE html><body></body>').window;
    makeBulkDom(document);
    const list = document.getElementById('prList');
    const sel = new Set(['r/1']);
    addCheckboxCard(list, document, { key: 'r/1', repo: 'r', number: 1, checked: true });
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(!document.getElementById('prBulkApprove').disabled, 'approve enabled when selected');
    sel.clear();
    updateBulkBar(sel, document, 'dependabot');
    assert.ok(!document.getElementById('prBulkBar').classList.contains('hidden'), 'bar stays visible');
    assert.ok(document.getElementById('prBulkApprove').disabled, 'approve disabled after clear');
});

// ── merged list union across refresh sources ─────────────────────────────────
// Each source is incomplete on its own: the fetch reports no merged PRs for repos whose
// background merged phase is still running, that phase arrives later as a partial, and the
// previous list covers what neither has refetched.
console.log('\nunionByUrl — merged lists across sources');

function unionByUrl(...lists) {
    const seen = new Set();
    return lists.filter(Boolean).flat().filter((pr) => !seen.has(pr.url) && seen.add(pr.url));
}

const pr = (n, extra = {}) => ({ url: `https://github.com/acme/repo/pull/${n}`, ...extra });

test('a freshly merged PR from this fetch survives alongside previously known ones', () => {
    const previous = [pr(1)];
    const fetched = [pr(1), pr(2)];
    const result = unionByUrl(undefined, fetched, previous);
    assert.deepEqual(result.map((p) => p.url), [pr(1).url, pr(2).url]);
});

test('previously known merged PRs are kept when this fetch reports none', () => {
    const result = unionByUrl(undefined, [], [pr(1), pr(2)]);
    assert.equal(result.length, 2, 'merged count must not drop to zero mid-reload');
});

test('the background merged partial takes precedence for duplicates', () => {
    const result = unionByUrl([pr(1, { source: 'partial' })], [pr(1, { source: 'fetch' })], [pr(1, { source: 'previous' })]);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'partial');
});

test('all three sources contribute their unique PRs', () => {
    const result = unionByUrl([pr(1)], [pr(2)], [pr(3)]);
    assert.deepEqual(result.map((p) => p.url), [pr(1).url, pr(2).url, pr(3).url]);
});

test('missing sources are ignored', () => {
    const result = unionByUrl(undefined, undefined, undefined);
    assert.deepEqual(result, []);
});

test('a PR merged during this fetch reaches the open-tab filter', () => {
    const openPrs = [pr(1), pr(2)];
    const data = {
        mergedPullRequests: unionByUrl(undefined, [pr(2)], []),
    };
    const visible = getPrsForTab({ ...data, pullRequests: openPrs }, { activePrTab: 'open' });
    assert.deepEqual(visible.map((p) => p.url), [pr(1).url], 'PR 2 was merged and must leave the open tab');
});

// ── Bulk patch helpers (inlined from renderer-prs.js) ────────────────────────

function applyBulkPatches(latestPrData, patches) {
    const mergedAt = new Date().toISOString();
    for (const patch of patches) {
        if (!patch) { continue; }
        const url = `https://github.com/${patch.repoFullName}/pull/${patch.prNumber}`;
        if (patch.action === 'approved') {
            for (const list of [latestPrData.pullRequests, latestPrData.dependabotPullRequests]) {
                const p = (list || []).find((p) => p.url === url);
                if (p) { p.reviewDecision = 'APPROVED'; }
            }
        } else if (patch.action === 'merged') {
            for (const key of ['pullRequests', 'dependabotPullRequests']) {
                if (!latestPrData[key]) { continue; }
                const idx = latestPrData[key].findIndex((p) => p.url === url);
                if (idx !== -1) {
                    const [p] = latestPrData[key].splice(idx, 1);
                    p.mergedAt = mergedAt;
                    latestPrData.mergedPullRequests = [p, ...(latestPrData.mergedPullRequests || [])];
                }
            }
        }
    }
}

const mkPr = (repo, n, extra = {}) => ({ url: `https://github.com/${repo}/pull/${n}`, repository: repo, ...extra });

test('bulk merge removes all selected PRs from open list', () => {
    const data = {
        pullRequests: [mkPr('org/a', 1), mkPr('org/b', 2), mkPr('org/c', 3)],
        dependabotPullRequests: [],
        mergedPullRequests: [],
    };
    const patches = [
        { action: 'merged', repoFullName: 'org/a', prNumber: 1 },
        { action: 'merged', repoFullName: 'org/b', prNumber: 2 },
    ];
    applyBulkPatches(data, patches);
    assert.equal(data.pullRequests.length, 1, 'only pr 3 should remain open');
    assert.equal(data.pullRequests[0].url, 'https://github.com/org/c/pull/3');
    assert.equal(data.mergedPullRequests.length, 2, 'both merged PRs added to merged list');
});

test('bulk approve sets APPROVED on all selected PRs', () => {
    const data = {
        pullRequests: [mkPr('org/a', 1), mkPr('org/b', 2), mkPr('org/c', 3)],
        dependabotPullRequests: [],
        mergedPullRequests: [],
    };
    const patches = [
        { action: 'approved', repoFullName: 'org/a', prNumber: 1 },
        { action: 'approved', repoFullName: 'org/c', prNumber: 3 },
    ];
    applyBulkPatches(data, patches);
    assert.equal(data.pullRequests[0].reviewDecision, 'APPROVED');
    assert.equal(data.pullRequests[1].reviewDecision, undefined, 'pr 2 must remain unchanged');
    assert.equal(data.pullRequests[2].reviewDecision, 'APPROVED');
});

test('bulk merge on three PRs removes all three', () => {
    const data = {
        pullRequests: [mkPr('org/a', 1), mkPr('org/b', 2), mkPr('org/c', 3)],
        dependabotPullRequests: [],
        mergedPullRequests: [],
    };
    const patches = [
        { action: 'merged', repoFullName: 'org/a', prNumber: 1 },
        { action: 'merged', repoFullName: 'org/b', prNumber: 2 },
        { action: 'merged', repoFullName: 'org/c', prNumber: 3 },
    ];
    applyBulkPatches(data, patches);
    assert.equal(data.pullRequests.length, 0, 'all PRs should be removed');
    assert.equal(data.mergedPullRequests.length, 3);
});

test('null patches (failed requests) are skipped', () => {
    const data = {
        pullRequests: [mkPr('org/a', 1), mkPr('org/b', 2)],
        dependabotPullRequests: [],
        mergedPullRequests: [],
    };
    applyBulkPatches(data, [null, { action: 'merged', repoFullName: 'org/b', prNumber: 2 }]);
    assert.equal(data.pullRequests.length, 1);
    assert.equal(data.pullRequests[0].url, 'https://github.com/org/a/pull/1');
});

// ── countMergedForSub deduplication ─────────────────────────────────────────

function countMergedForSub(data) {
    const today = getLocalDateKey();
    const seen = new Set();
    return [
        ...(data.mergedPullRequests || []),
        ...(data.mergedDependabotPullRequests || []),
        ...(data.mergedYesterdayPullRequests || []),
        ...(data.mergedYesterdayDependabotPullRequests || []),
    ].filter((p) => {
        if (!p.mergedAt || getLocalDateKey(p.mergedAt) !== today) { return false; }
        if (seen.has(p.url)) { return false; }
        seen.add(p.url);
        return true;
    }).length;
}

const todayIso = new Date().toISOString();
const yesterdayIso = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString(); })();
const mergedPr = (n, mergedAt = todayIso) => ({ url: `https://github.com/org/repo/pull/${n}`, mergedAt });

test('badge count matches visible list when a PR appears in multiple merged lists', () => {
    const dupPr = mergedPr(1);
    const data = {
        mergedPullRequests: [dupPr, mergedPr(2)],
        mergedDependabotPullRequests: [dupPr],  // same PR duplicated
        mergedYesterdayPullRequests: [],
        mergedYesterdayDependabotPullRequests: [],
    };
    assert.equal(countMergedForSub(data), 2, 'duplicate PR must be counted only once');
});

test('badge excludes PRs merged yesterday', () => {
    const data = {
        mergedPullRequests: [mergedPr(1), mergedPr(2, yesterdayIso)],
        mergedDependabotPullRequests: [],
        mergedYesterdayPullRequests: [mergedPr(2, yesterdayIso)],
        mergedYesterdayDependabotPullRequests: [],
    };
    assert.equal(countMergedForSub(data), 1, 'only today PRs count toward badge');
});

test('badge count equals visible list count when there are no duplicates', () => {
    const data = {
        mergedPullRequests: [mergedPr(1), mergedPr(2), mergedPr(3)],
        mergedDependabotPullRequests: [mergedPr(4), mergedPr(5)],
        mergedYesterdayPullRequests: [],
        mergedYesterdayDependabotPullRequests: [],
    };
    const badge = countMergedForSub(data);
    const visible = getPrsForTab(data, { activePrTab: 'merged', activeMergedSub: 'today' }).length;
    assert.equal(badge, visible, 'badge and visible list must agree');
});
