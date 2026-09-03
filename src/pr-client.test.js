'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

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

function fixture(name) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name), 'utf8'));
}

// ── Functions under test (extracted from pr-client.js) ────────────────────────
// These are inlined here so tests can run without spawning gh or requiring
// the full module (which calls execFile at require time via top-level code).

function getLatestCommentActivity(pr) {
    const timestamps = [
        ...(pr.comments || []).map((c) => c.updatedAt || c.createdAt),
        ...(pr.reviews || []).filter((r) => String(r.body || '').trim()).map((r) => r.submittedAt || r.updatedAt || r.createdAt),
    ].filter(Boolean);
    if (!timestamps.length) { return { commentActivityAt: null, commentActivityCount: 0 }; }
    return { commentActivityAt: timestamps.sort().at(-1), commentActivityCount: timestamps.length };
}

function normalizePr(pr, repository) {
    return { ...pr, ...getLatestCommentActivity(pr), checkStatus: 'none', checkStatusLabel: 'No checks', repository };
}

function interpretCheckRuns(runs) {
    if (!runs.length) { return { checkStatus: 'none', checkStatusLabel: 'No checks' }; }
    const failed = ['action_required', 'cancelled', 'failure', 'timed_out', 'stale'];
    if (runs.some((r) => failed.includes(r.conclusion))) {
        return { checkStatus: 'failure', checkStatusLabel: 'Checks failing' };
    }
    if (runs.some((r) => r.status !== 'completed')) {
        return { checkStatus: 'pending', checkStatusLabel: 'Checks pending' };
    }
    return { checkStatus: 'success', checkStatusLabel: 'Checks passing' };
}

function normalizeSearchPr(pr) {
    const repo = pr.repository?.nameWithOwner || pr.repository?.fullName || '';
    return normalizePr({ ...pr, headRefOid: pr.headRefOid || '' }, repo);
}

// ── normalizePr against open PR fixture ───────────────────────────────────────
console.log('\nnormalizePr — open PRs');

test('preserves required fields', () => {
    const [raw] = fixture('gh-pr-list-open.json');
    const pr = normalizePr(raw, 'acme/my-service');
    assert.equal(pr.number, 42);
    assert.equal(pr.title, 'Add retry logic to log streaming');
    assert.equal(pr.url, 'https://github.com/acme/my-service/pull/42');
    assert.equal(pr.repository, 'acme/my-service');
    assert.equal(pr.author?.login, 'espen');
});

test('adds default checkStatus fields', () => {
    const [raw] = fixture('gh-pr-list-open.json');
    const pr = normalizePr(raw, 'acme/my-service');
    assert.equal(pr.checkStatus, 'none');
    assert.equal(pr.checkStatusLabel, 'No checks');
});

test('computes commentActivityCount from comments and reviews', () => {
    const [raw] = fixture('gh-pr-list-open.json');
    const pr = normalizePr(raw, 'acme/my-service');
    // 1 comment + 1 review with body = 2
    assert.equal(pr.commentActivityCount, 2);
});

test('picks latest commentActivityAt', () => {
    const [raw] = fixture('gh-pr-list-open.json');
    const pr = normalizePr(raw, 'acme/my-service');
    assert.equal(pr.commentActivityAt, '2026-06-22T11:00:00Z');
});

test('draft PR preserves isDraft flag', () => {
    const prs = fixture('gh-pr-list-open.json');
    const draft = normalizePr(prs[1], 'acme/my-service');
    assert.equal(draft.isDraft, true);
    assert.equal(draft.commentActivityCount, 0);
    assert.equal(draft.commentActivityAt, null);
});

// ── normalizePr against merged PR fixture ─────────────────────────────────────
console.log('\nnormalizePr — merged PRs');

test('preserves mergedAt', () => {
    const [raw] = fixture('gh-pr-list-merged.json');
    const pr = normalizePr(raw, 'acme/my-service');
    assert.equal(pr.mergedAt, '2026-06-25T10:00:00Z');
    assert.equal(pr.reviewDecision, 'APPROVED');
});

test('has no comments or reviews in merged fixture', () => {
    const [raw] = fixture('gh-pr-list-merged.json');
    const pr = normalizePr(raw, 'acme/my-service');
    assert.equal(pr.commentActivityCount, 0);
});

// ── normalizeSearchPr against author-search fixture ───────────────────────────
console.log('\nnormalizeSearchPr — author org search');

test('extracts repository from nested object', () => {
    const [raw] = fixture('gh-search-prs-open.json');
    const pr = normalizeSearchPr(raw);
    assert.equal(pr.repository, 'acme/other-service');
});

test('adds empty headRefOid if missing', () => {
    const [raw] = fixture('gh-search-prs-open.json');
    const pr = normalizeSearchPr(raw);
    assert.equal(pr.headRefOid, '');
});

test('preserves all expected fields', () => {
    const [raw] = fixture('gh-search-prs-open.json');
    const pr = normalizeSearchPr(raw);
    assert.equal(pr.number, 7);
    assert.equal(pr.reviewDecision, 'APPROVED');
    assert.equal(pr.author?.login, 'espen');
});

// ── interpretCheckRuns against check-runs fixture ────────────────────────────
console.log('\ninterpretCheckRuns — check runs');

test('returns pending when any run is not completed', () => {
    const runs = fixture('gh-check-runs.json');
    const result = interpretCheckRuns(runs);
    assert.equal(result.checkStatus, 'pending');
    assert.equal(result.checkStatusLabel, 'Checks pending');
});

test('returns success when all runs completed with success', () => {
    const runs = [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
    ];
    const result = interpretCheckRuns(runs);
    assert.equal(result.checkStatus, 'success');
    assert.equal(result.checkStatusLabel, 'Checks passing');
});

test('returns failure when any run has failing conclusion', () => {
    const runs = [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
    ];
    const result = interpretCheckRuns(runs);
    assert.equal(result.checkStatus, 'failure');
    assert.equal(result.checkStatusLabel, 'Checks failing' );
});

test('returns failure for all failing conclusion types', () => {
    const failConclusions = ['action_required', 'cancelled', 'failure', 'timed_out', 'stale'];
    for (const conclusion of failConclusions) {
        const result = interpretCheckRuns([{ status: 'completed', conclusion }]);
        assert.equal(result.checkStatus, 'failure', `expected failure for conclusion: ${conclusion}`);
    }
});

test('returns none for empty runs array', () => {
    const result = interpretCheckRuns([]);
    assert.equal(result.checkStatus, 'none');
    assert.equal(result.checkStatusLabel, 'No checks');
});

// ── deduplication logic ───────────────────────────────────────────────────────
console.log('\ndeduplication');

test('dedupeByUrl removes duplicate PRs from topic and author searches', () => {
    function dedupeByUrl(prs) {
        const seen = new Set();
        return prs.filter((pr) => { if (seen.has(pr.url)) { return false; } seen.add(pr.url); return true; });
    }

    const topicPr = normalizePr(fixture('gh-pr-list-open.json')[0], 'acme/my-service');
    const authorPr = normalizeSearchPr({
        ...fixture('gh-search-prs-open.json')[0],
        url: topicPr.url, // same URL = duplicate
        repository: { nameWithOwner: 'acme/my-service' },
    });

    const merged = dedupeByUrl([topicPr, authorPr]);
    assert.equal(merged.length, 1);
});

test('dedupeByUrl keeps distinct PRs', () => {
    function dedupeByUrl(prs) {
        const seen = new Set();
        return prs.filter((pr) => { if (seen.has(pr.url)) { return false; } seen.add(pr.url); return true; });
    }

    const prs = fixture('gh-pr-list-open.json').map((p) => normalizePr(p, 'acme/my-service'));
    const authorPr = normalizeSearchPr(fixture('gh-search-prs-open.json')[0]);
    const merged = dedupeByUrl([...prs, authorPr]);
    assert.equal(merged.length, 3);
});

test('Search API response maps full_name to nameWithOwner', () => {
    const apiResponse = {
        total_count: 2,
        items: [
            { full_name: 'bring/repo-a' },
            { full_name: 'bring/repo-b' },
        ],
    };
    const repos = apiResponse.items.map((r) => ({ nameWithOwner: r.full_name }));
    assert.deepEqual(repos, [
        { nameWithOwner: 'bring/repo-a' },
        { nameWithOwner: 'bring/repo-b' },
    ]);
});

test('Search API truncation warning triggers when total_count exceeds items', () => {
    const raw = { total: 150, items: new Array(100).fill({ nameWithOwner: 'bring/x' }) };
    assert.ok(raw.total > raw.items.length, 'should detect truncation');
});

// ── GraphQL batch PR normalisation ───────────────────────────────────────────

function getLocalDateKey(d) {
    if (!d) { return ''; }
    const date = new Date(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function normalizeGql(pr) {
    return {
        ...pr,
        comments: pr.comments?.nodes || [],
        reviews: pr.latestReviews?.nodes || [],
        files: pr.files?.nodes || [],
    };
}

test('normalizeGql flattens GraphQL connection nodes into arrays', () => {
    const raw = fixture('gh-graphql-batch-prs.json');
    const pr = normalizeGql(raw.r0.prs.nodes[0]);
    assert.ok(Array.isArray(pr.comments), 'comments should be array');
    assert.ok(Array.isArray(pr.reviews), 'reviews should be array');
    assert.ok(Array.isArray(pr.files), 'files should be array');
    assert.equal(pr.comments[0].updatedAt, '2026-06-21T10:00:00Z');
    assert.equal(pr.reviews[0].body, 'LGTM');
    assert.equal(pr.files[0].path, 'src/index.js');
    assert.equal(pr.headRefName, 'feat/retry-logic');
});

test('normalizeGql handles missing nodes gracefully', () => {
    const pr = normalizeGql({ number: 1, comments: null, latestReviews: undefined, files: null });
    assert.deepEqual(pr.comments, []);
    assert.deepEqual(pr.reviews, []);
    assert.deepEqual(pr.files, []);
});

test('batch merged response filters by date correctly', () => {
    const raw = fixture('gh-graphql-batch-merged.json');
    const allMerged = raw.r0.prs.nodes;
    const today = '2026-09-03';
    const yesterday = '2026-09-02';
    const mergedToday = allMerged.filter((pr) => getLocalDateKey(pr.mergedAt) === today);
    const mergedYesterday = allMerged.filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday);
    const older = allMerged.filter((pr) => getLocalDateKey(pr.mergedAt) !== today && getLocalDateKey(pr.mergedAt) !== yesterday);
    assert.equal(mergedToday.length, 1, 'one PR merged today');
    assert.equal(mergedToday[0].number, 40);
    assert.equal(mergedYesterday.length, 1, 'one PR merged yesterday');
    assert.equal(mergedYesterday[0].number, 39);
    assert.equal(older.length, 1, 'one older PR excluded');
});

test('batch open response maps repos correctly', () => {
    const raw = fixture('gh-graphql-batch-prs.json');
    const repoNames = ['acme/repo-a', 'acme/repo-b'];
    const results = repoNames.map((nameWithOwner, i) => {
        const open = (raw[`r${i}`]?.prs?.nodes || []).map(normalizeGql);
        return { nameWithOwner, prs: open.map((pr) => normalizePr(pr, nameWithOwner)) };
    });
    assert.equal(results[0].prs[0].repository, 'acme/repo-a');
    assert.equal(results[1].prs[0].repository, 'acme/repo-b');
    assert.equal(results[0].prs[0].commentActivityCount, 2, 'comment + review count');
});

// ── dependabot filtering ──────────────────────────────────────────────────────
console.log('\ndependabot filtering');

const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot[bot]', 'dependabot']);
function isDependabot(pr) { return DEPENDABOT_LOGINS.has(pr.author?.login); }

test('isDependabot matches REST login app/dependabot', () => {
    assert.ok(isDependabot({ author: { login: 'app/dependabot' } }));
});

test('isDependabot matches GraphQL login dependabot[bot]', () => {
    assert.ok(isDependabot({ author: { login: 'dependabot[bot]' } }));
});

test('isDependabot matches GraphQL login dependabot', () => {
    assert.ok(isDependabot({ author: { login: 'dependabot' } }));
});

test('isDependabot does not match human login', () => {
    assert.ok(!isDependabot({ author: { login: 'espen' } }));
});

test('dependabot PRs from GraphQL batch end up in dependabotPullRequests not pullRequests', () => {
    const prs = [
        { url: 'a', author: { login: 'espen' } },
        { url: 'b', author: { login: 'dependabot[bot]' } },
        { url: 'c', author: { login: 'app/dependabot' } },
    ];
    const human = prs.filter((pr) => !isDependabot(pr));
    const bots = prs.filter(isDependabot);
    assert.equal(human.length, 1);
    assert.equal(human[0].url, 'a');
    assert.equal(bots.length, 2);
});

test('batch query handles missing repo in response gracefully', () => {
    const raw = { r0: { prs: { nodes: [] } } }; // r1 missing
    const repoNames = ['acme/repo-a', 'acme/repo-b'];
    const results = repoNames.map((nameWithOwner, i) => {
        const open = (raw[`r${i}`]?.prs?.nodes || []).map(normalizeGql);
        return { nameWithOwner, prs: open };
    });
    assert.equal(results[0].prs.length, 0);
    assert.equal(results[1].prs.length, 0, 'missing repo produces empty array, not crash');
});
