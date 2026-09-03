'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

// REST API returns 'app/dependabot', GraphQL returns 'dependabot'
const DEPENDABOT_LOGINS = new Set(['app/dependabot', 'dependabot[bot]', 'dependabot']);
function isDependabot(pr) { return DEPENDABOT_LOGINS.has(pr.author?.login); }
// headRefOid = head commit SHA, used to fetch check runs via REST
const OPEN_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,reviewDecision,headRefOid,headRefName,comments,reviews,files';
const MERGED_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,mergedAt,reviewDecision';

const RECENT_PUSH_MS = 24 * 60 * 60 * 1000; // 24 hours — controls cache TTL aggressiveness
const CHECK_RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // skip check-runs for PRs older than 7 days
const checkRunsCache = new Map(); // key: `${nameWithOwner}/${sha}` → { checkStatus, checkStatusLabel, fetchedAt }

let _callCount = 0;

// Send a GraphQL query via a temp file (stdin via execFile has encoding issues with gh).
async function runGhGraphql(query) {
    _callCount++;
    console.log(`[gh] #${_callCount} api graphql (${query.length} chars, ${query.match(/r\d+:/g)?.length || 0} repos)`);
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const tmpFile = path.join(os.tmpdir(), `gh-query-${process.pid}-${_callCount}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ query }));
    try {
        const opts = {
            timeout: 60_000,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME || os.homedir() },
        };
        let stdout;
        try {
            ({ stdout } = await execFileAsync(ghPath, ['api', 'graphql', '--input', tmpFile], opts));
        } catch (execErr) {
            console.error('[gh] execFile error stdout:', execErr.stdout?.slice(0, 300));
            console.error('[gh] execFile error stderr:', execErr.stderr?.slice(0, 300));
            throw execErr;
        }
        let parsed;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            console.error('[gh] JSON.parse failed, stdout was:', stdout?.slice(0, 300));
            throw new Error(`GraphQL response was not JSON (got: ${stdout?.slice(0, 100)})`);
        }
        if (parsed.errors) { console.error('[gh] GraphQL errors:', JSON.stringify(parsed.errors)); }
        return parsed.data;
    } finally {
        fs.unlink(tmpFile, () => {});
    }
}

async function runGh(args, { retry = true } = {}) {
    _callCount++;
    const label = args.slice(0, 3).join(' ');
    console.log(`[gh] #${_callCount} ${label} ${args[3] || ''}`);
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const opts = {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
    };
    try {
        const { stdout } = await execFileAsync(ghPath, args, opts);
        return JSON.parse(stdout);
    } catch (err) {
        const msg = err.stderr || err.message || '';
        if (retry && (msg.includes('401') || msg.includes('Bad credentials'))) {
            console.log(`[gh] token error, retrying once after refresh…`);
            await execFileAsync(ghPath, ['auth', 'token'], opts).catch(() => {});
            await new Promise((r) => setTimeout(r, 1000));
            return runGh(args, { retry: false });
        }
        throw err;
    }
}

function getLocalDateKey(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) { return ''; }
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
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

async function fetchCheckStatus(nameWithOwner, sha, recentlyUpdated) {
    const cacheKey = `${nameWithOwner}/${sha}`;
    const cached = checkRunsCache.get(cacheKey);

    if (cached) {
        const isPending = cached.checkStatus === 'pending';
        const age = Date.now() - cached.fetchedAt;
        // Re-fetch if: still pending (every 60s), or recently updated (every 2min regardless of status)
        const shouldRefetch = (isPending && age > 60_000) || (recentlyUpdated && age > 2 * 60_000);
        if (!shouldRefetch) {
            console.log(`[gh] checkRuns cache HIT ${cacheKey} (${cached.checkStatus})`);
            return { checkStatus: cached.checkStatus, checkStatusLabel: cached.checkStatusLabel };
        }
    }

    try {
        const data = await runGh(['api', `repos/${nameWithOwner}/commits/${sha}/check-runs`, '--jq', '[.check_runs[] | {name,status,conclusion,started_at}]']);
        const allRuns = Array.isArray(data) ? data : [];
        // Keep only the latest run per check name (re-runs produce duplicates with old cancelled entries)
        const latestByName = new Map();
        for (const r of allRuns) {
            const existing = latestByName.get(r.name);
            if (!existing || r.started_at > existing.started_at) { latestByName.set(r.name, r); }
        }
        // Exclude AI code-review bots — their quota failures aren't real CI failures
        const botReviewers = ['copilot-pull-request-reviewer'];
        const runs = [...latestByName.values()].filter((r) => !botReviewers.includes(r.name));
        const result = { ...interpretCheckRuns(runs), fetchedAt: Date.now() };
        checkRunsCache.set(cacheKey, result);
        return result;
    } catch {
        // On error, return previous cached status if we have one — don't wipe known state
        if (cached) { return { checkStatus: cached.checkStatus, checkStatusLabel: cached.checkStatusLabel }; }
        return { checkStatus: 'none', checkStatusLabel: 'No checks' };
    }
}

function getLatestCommentActivity(pr) {
    const timestamps = [
        ...(pr.comments || []).map((c) => c.updatedAt || c.createdAt),
        ...(pr.reviews || []).filter((r) => String(r.body || '').trim()).map((r) => r.submittedAt || r.updatedAt || r.createdAt),
    ].filter(Boolean);
    if (!timestamps.length) { return { commentActivityAt: null, commentActivityCount: 0 }; }
    return { commentActivityAt: timestamps.sort().at(-1), commentActivityCount: timestamps.length };
}

function normalizePr(pr, repository) {
    // checkStatus filled in later by enrichWithCheckStatus for recently-updated PRs
    return { ...pr, ...getLatestCommentActivity(pr), checkStatus: 'none', checkStatusLabel: 'No checks', repository };
}

// Cache the repo list — it rarely changes and costs a GraphQL API call each time
const repoListCache = new Map(); // key: `${org}/${topic}` → { repos, fetchedAt }
const REPO_LIST_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Cache pr list per repo — valid for 5 minutes
const prListCache = new Map(); // key: `${nameWithOwner}/${state}` → { prs, fetchedAt }
const PR_LIST_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Delta cache: stores last known PRs per repo so we can skip repos that haven't been pushed to
const perRepoPrCache = new Map(); // key: nameWithOwner → { openNodes: [], mergedNodes: [], mergedYesterdayNodes: [], cachedAt: ms, today: string, yesterday: string }

async function fetchRepoList(org, topic) {
    const key = `${org}/${topic}`;
    const cached = repoListCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < REPO_LIST_TTL_MS) {
        const ageS = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.log(`[gh] repoList cache HIT (${cached.repos.length} repos, ${ageS}s old)`);
        return cached.repos;
    }
    console.log(`[gh] repoList cache MISS — fetching from GitHub`);
    // Use Search API (REST) instead of gh repo list which uses GraphQL (lower rate limits).
    // Search API has its own rate limit (30 req/min authenticated) but this call is cached 30 min
    // so it fires at most twice per hour — well within budget.
    const raw = await runGh([
        'api', 'search/repositories',
        '--method', 'GET',
        '-f', `q=topic:${topic} org:${org} archived:false`,
        '-f', 'per_page=100',
        '--jq', '{total: .total_count, items: [.items[] | {nameWithOwner: .full_name, pushedAt: .pushed_at}]}',
    ]);
    if (raw.total > raw.items.length) {
        console.warn(`[gh] repoList: topic "${topic}" has ${raw.total} repos but only ${raw.items.length} returned (Search API max 100). Some repos will be missing.`);
    }
    const repos = raw.items;
    repoListCache.set(key, { repos, fetchedAt: Date.now() });
    console.log(`[gh] repoList fetched ${repos.length} repos, cached for 30 min`);
    return repos;
}

async function fetchPrList(nameWithOwner, cacheKey, args) {
    const key = `${nameWithOwner}/${cacheKey}`;
    const cached = prListCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < PR_LIST_TTL_MS) {
        const ageS = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.log(`[gh] prList cache HIT ${nameWithOwner} (${cacheKey}, ${ageS}s old)`);
        return cached.prs;
    }
    const prs = await runGh(args);
    prListCache.set(key, { prs, fetchedAt: Date.now() });
    return prs;
}

function dedupeByUrl(prs) {
    const seen = new Set();
    return prs.filter((pr) => { if (seen.has(pr.url)) { return false; } seen.add(pr.url); return true; });
}

// Build a GraphQL query that fetches open or merged PRs for all repos in one request.
function buildBatchQuery(name, repoNames, state, fields) {
    const aliases = repoNames.map((nameWithOwner, i) => {
        const slash = nameWithOwner.indexOf('/');
        const owner = nameWithOwner.slice(0, slash);
        const repoName = nameWithOwner.slice(slash + 1);
        const stateArg = state === 'OPEN'
            ? 'states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}'
            : 'states: MERGED, first: 25, orderBy: {field: UPDATED_AT, direction: DESC}';
        return `r${i}: repository(owner: "${owner}", name: "${repoName}") {
            prs: pullRequests(${stateArg}) { nodes { ${fields} } }
        }`;
    }).join('\n');
    return `query ${name} { ${aliases} }`;
}

const BATCH_SIZE = 4; // repos per GraphQL request — keeps query complexity below GitHub's 502 threshold

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) { out.push(arr.slice(i, i + size)); }
    return out;
}

const normalizeGql = (pr) => ({
    ...pr,
    comments: pr.comments?.nodes || [],
    reviews: pr.latestReviews?.nodes || [],
    files: [],
});

const OPEN_GQL_FIELDS = `number title url isDraft createdAt updatedAt reviewDecision headRefOid headRefName author { login }`;
const MERGED_GQL_FIELDS = `number title url isDraft createdAt updatedAt mergedAt reviewDecision author { login }`;

// Fetch one state (OPEN or MERGED) across all repo chunks in parallel.
async function fetchBatchPhase(repoNames, state, fields, { onProgress, onChunk } = {}) {
    const chunks = chunk(repoNames, BATCH_SIZE);
    const results = repoNames.map((nameWithOwner) => ({ nameWithOwner, nodes: [] }));
    let completed = 0;

    await Promise.all(chunks.map(async (chunkRepos, i) => {
        const raw = await runGhGraphql(buildBatchQuery(`${state}PRs`, chunkRepos, state, fields));
        chunkRepos.forEach((nameWithOwner, localIdx) => {
            results[i * BATCH_SIZE + localIdx].nodes = (raw[`r${localIdx}`]?.prs?.nodes || []).map(normalizeGql);
        });
        completed++;
        onProgress?.(Math.round((completed / chunks.length) * 100));
        onChunk?.(results.filter((r) => r.nodes.length > 0 || completed === chunks.length));
    }));

    return results;
}

// Batch-fetch all PR states in three phases: open → dependabot → merged.
// `repositories` is an array of { nameWithOwner, pushedAt } from fetchRepoList.
// Repos whose pushedAt predates the last successful fetch are served from perRepoPrCache.
async function batchFetchPrs(repositories, today, yesterday, onProgress, onPartialResults) {
    if (!repositories.length) { return { results: [], staleRepos: new Set() }; }

    const now = Date.now();

    // Split into stale (needs fetch) vs cached (no new pushes since last fetch, same date)
    const stale = [];
    const fromCache = [];
    for (const repo of repositories) {
        const cached = perRepoPrCache.get(repo.nameWithOwner);
        const pushedMs = repo.pushedAt ? new Date(repo.pushedAt).getTime() : Infinity;
        const dayChanged = cached && (cached.today !== today || cached.yesterday !== yesterday);
        const noCacheHit = !cached || dayChanged;
        const repoUpdatedSinceCache = !cached || pushedMs > cached.cachedAt;
        if (noCacheHit || repoUpdatedSinceCache) {
            stale.push(repo.nameWithOwner);
        } else {
            fromCache.push({ nameWithOwner: repo.nameWithOwner, ...cached });
        }
    }

    console.log(`[gh] batchFetchPrs — ${stale.length} stale repos to fetch, ${fromCache.length} served from delta cache`);

    // Immediately emit cached repos as a partial so the UI isn't blank
    if (onPartialResults && fromCache.length) {
        const cachedHuman = dedupeByUrl(fromCache.flatMap((r) => r.openNodes.filter((pr) => !isDependabot(pr)).map((pr) => normalizePr(pr, r.nameWithOwner))))
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
        onPartialResults({ type: 'open', pullRequests: cachedHuman, repositories: fromCache.map((r) => r.nameWithOwner) });
    }

    let openPhase = [];
    let mergedPhase = [];

    if (stale.length) {
        const chunks = chunk(stale, BATCH_SIZE);
        console.log(`[gh] batchFetchPrs — ${chunks.length * 2} GraphQL calls for ${stale.length} stale repos (open+merged in parallel)`);

        // Open phase — await this, it feeds the Open tab
        openPhase = await fetchBatchPhase(stale, 'OPEN', OPEN_GQL_FIELDS, {
            onProgress,
            onChunk: onPartialResults ? (fetched) => {
                const freshHuman = dedupeByUrl(fetched.flatMap((r) => r.nodes.filter((pr) => !isDependabot(pr)).map((pr) => normalizePr(pr, r.nameWithOwner))));
                const cachedHuman = fromCache.flatMap((r) => r.openNodes.filter((pr) => !isDependabot(pr)).map((pr) => normalizePr(pr, r.nameWithOwner)));
                const all = dedupeByUrl([...freshHuman, ...cachedHuman]).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
                const allRepos = [...fetched.map((r) => r.nameWithOwner), ...fromCache.map((r) => r.nameWithOwner)];
                onPartialResults({ type: 'open', pullRequests: all, repositories: allRepos });
            } : null,
        });

        // Merged phase — fire in background, don't block returning open results
        fetchBatchPhase(stale, 'MERGED', MERGED_GQL_FIELDS).then((fetched) => {
            mergedPhase = fetched;
            for (const r of fetched) {
                const existing = perRepoPrCache.get(r.nameWithOwner) || {};
                perRepoPrCache.set(r.nameWithOwner, { ...existing, mergedNodes: r.nodes });
            }
            if (onPartialResults) {
                const freshMerged = fetched.flatMap((r) => r.nodes.filter((pr) => getLocalDateKey(pr.mergedAt) === today).map((pr) => normalizePr(pr, r.nameWithOwner)));
                const cachedMerged = fromCache.flatMap((r) => r.mergedNodes.filter((pr) => getLocalDateKey(pr.mergedAt) === today).map((pr) => normalizePr(pr, r.nameWithOwner)));
                const mergedPrs = dedupeByUrl([...freshMerged, ...cachedMerged]).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
                const freshMergedYday = fetched.flatMap((r) => r.nodes.filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday).map((pr) => normalizePr(pr, r.nameWithOwner)));
                const cachedMergedYday = fromCache.flatMap((r) => r.mergedNodes.filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday).map((pr) => normalizePr(pr, r.nameWithOwner)));
                const mergedYesterdayPrs = dedupeByUrl([...freshMergedYday, ...cachedMergedYday]).sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
                onPartialResults({ type: 'merged', mergedPullRequests: mergedPrs, mergedYesterdayPullRequests: mergedYesterdayPrs });
            }
        });
    }

    // Update perRepoPrCache with fresh data
    for (const r of openPhase) {
        const existing = perRepoPrCache.get(r.nameWithOwner) || {};
        perRepoPrCache.set(r.nameWithOwner, {
            openNodes: r.nodes,
            mergedNodes: existing.mergedNodes || [],
            cachedAt: now,
            today,
            yesterday,
        });
    }
    // Dependabot — emit from open results (merged runs in background separately)
    if (onPartialResults) {
        const freshDep = openPhase.flatMap((r) => r.nodes.filter(isDependabot).map((pr) => normalizePr(pr, r.nameWithOwner)));
        const cachedDep = fromCache.flatMap((r) => r.openNodes.filter(isDependabot).map((pr) => normalizePr(pr, r.nameWithOwner)));
        const dependabotPrs = dedupeByUrl([...freshDep, ...cachedDep]).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        onPartialResults({ type: 'dependabot', dependabotPullRequests: dependabotPrs });
    }

    // Build final result list in original repo order
    const staleSet = new Set(stale);
    const results = repositories.map(({ nameWithOwner }) => {
        const c = perRepoPrCache.get(nameWithOwner) || { openNodes: [], mergedNodes: [] };
        // Don't include merged from stale repos — their merged phase is still running in background
        // and old mergedNodes may be from a previous day. Let the partial handle it.
        const mergedNodes = staleSet.has(nameWithOwner) ? [] : c.mergedNodes;
        return {
            nameWithOwner,
            pullRequests: c.openNodes.map((pr) => normalizePr(pr, nameWithOwner)),
            mergedPullRequests: mergedNodes.filter((pr) => getLocalDateKey(pr.mergedAt) === today).map((pr) => normalizePr(pr, nameWithOwner)),
            mergedYesterdayPullRequests: mergedNodes.filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday).map((pr) => normalizePr(pr, nameWithOwner)),
        };
    });
    return { results, staleRepos: staleSet };
}

async function fetchPullRequests({ org, topic, watchedRepos = [], namespace }, onProgress, onPartialResults) {
    if (!org || !topic) { throw new Error('GitHub org and topic are required. Set them in Settings.'); }

    const before = _callCount;
    const today = getLocalDateKey();
    const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = getLocalDateKey(yesterdayDate);
    const repositories = await fetchRepoList(org, topic);
    const repoNames = repositories.map((r) => r.nameWithOwner);

    // Run all independent fetches in parallel:
    // - batch GraphQL (open + dependabot + merged phases)
    // - watched repos (REST)
    // - author search (REST)
    const label = namespace || topic;
    const watchedReposFull = watchedRepos.map((r) => r.includes('/') ? r : `${org}/${r}`);
    const AUTHOR_FIELDS = `number,title,url,author,isDraft,createdAt,updatedAt,reviewDecision,repository`;
    const AUTHOR_MERGED_FIELDS = `number,title,url,author,isDraft,createdAt,updatedAt,mergedAt,reviewDecision,repository`;

    const [batchResult, watchedSettled, authorOpen, authorMergedToday, authorMergedYesterday] = await Promise.all([
        batchFetchPrs(repositories, today, yesterday, onProgress, onPartialResults),
        Promise.allSettled(watchedReposFull.map(async (nameWithOwner) => {
            const [open, merged, mergedYesterday] = await Promise.all([
                fetchPrList(nameWithOwner, `open:label:${label}`, ['pr', 'list', '--repo', nameWithOwner, '--label', label, '--limit', '100', '--json', OPEN_PR_FIELDS]),
                fetchPrList(nameWithOwner, `merged:${today}:label:${label}`, ['pr', 'list', '--repo', nameWithOwner, '--label', label, '--state', 'merged', '--search', `merged:${today}`, '--limit', '100', '--json', MERGED_PR_FIELDS]),
                fetchPrList(nameWithOwner, `merged:${yesterday}:label:${label}`, ['pr', 'list', '--repo', nameWithOwner, '--label', label, '--state', 'merged', '--search', `merged:${yesterday}`, '--limit', '100', '--json', MERGED_PR_FIELDS]),
            ]);
            return {
                pullRequests: open.map((pr) => normalizePr(pr, nameWithOwner)),
                mergedPullRequests: merged.map((pr) => normalizePr(pr, nameWithOwner)),
                mergedYesterdayPullRequests: mergedYesterday.map((pr) => normalizePr(pr, nameWithOwner)),
            };
        })),
        runGh(['search', 'prs', '--author=@me', `--owner=${org}`, '--state=open', '--limit=100', '--json', AUTHOR_FIELDS]).catch(() => []),
        runGh(['search', 'prs', '--author=@me', `--owner=${org}`, '--state=merged', `--merged-at=${today}`, '--limit=100', '--json', AUTHOR_MERGED_FIELDS]).catch(() => []),
        runGh(['search', 'prs', '--author=@me', `--owner=${org}`, '--state=merged', `--merged-at=${yesterday}`, '--limit=100', '--json', AUTHOR_MERGED_FIELDS]).catch(() => []),
    ]);
    const watchedLists = watchedSettled.filter((r) => r.status === 'fulfilled').map((r) => r.value);

    function normalizeSearchPr(pr) {
        const repo = pr.repository?.nameWithOwner || pr.repository?.fullName || '';
        return normalizePr({ ...pr, headRefOid: pr.headRefOid || '' }, repo);
    }

    const authorOpenPrs = (authorOpen || []).map(normalizeSearchPr);
    const authorMergedTodayPrs = (authorMergedToday || []).map(normalizeSearchPr);
    const authorMergedYesterdayPrs = (authorMergedYesterday || []).map(normalizeSearchPr);

    const { results: lists, staleRepos } = batchResult;
    const allLists = [...lists, ...watchedLists];

    const all = dedupeByUrl([...allLists.flatMap((l) => l.pullRequests), ...authorOpenPrs])
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const allMerged = dedupeByUrl([...allLists.flatMap((l) => l.mergedPullRequests), ...authorMergedTodayPrs])
        .filter((pr) => getLocalDateKey(pr.mergedAt) === today)
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    const allMergedYesterday = dedupeByUrl([...allLists.flatMap((l) => l.mergedYesterdayPullRequests || []), ...authorMergedYesterdayPrs])
        .filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday)
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));

    // Enrich check status only for PRs from repos that had new pushes (stale repos), plus any pending ones
    // PRs from cached repos have unchanged SHAs — their check-run results can't have changed
    const prsWithSha = all.filter((pr) => {
        if (!pr.headRefOid) { return false; }
        if ((Date.now() - new Date(pr.updatedAt).getTime()) >= CHECK_RUNS_MAX_AGE_MS) { return false; }
        const cached = checkRunsCache.get(`${pr.repository}/${pr.headRefOid}`);
        const isPending = cached?.checkStatus === 'pending';
        return staleRepos.has(pr.repository) || isPending;
    });
    const skipped = all.filter((pr) => pr.headRefOid).length - prsWithSha.length;
    console.log(`[gh] enriching ${prsWithSha.length} PRs with check status via REST (background, skipping ${skipped} from unchanged repos)`);

    const result = {
        pullRequests: all.filter((pr) => !isDependabot(pr)),
        mergedPullRequests: allMerged.filter((pr) => !isDependabot(pr)),
        mergedYesterdayPullRequests: allMergedYesterday.filter((pr) => !isDependabot(pr)),
        dependabotPullRequests: all.filter(isDependabot)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
        mergedDependabotPullRequests: allMerged.filter(isDependabot),
        mergedYesterdayDependabotPullRequests: allMergedYesterday.filter(isDependabot),
        repositories: [...repoNames, ...watchedReposFull],
        refreshedAt: new Date().toISOString(),
    };

    // Fire check enrichment in the background — don't await it before returning
    // Each resolved PR emits pr:partial { type: 'checks' } so the UI patches the pill in-place
    Promise.allSettled(prsWithSha.map(async (pr) => {
        const recentlyUpdated = (Date.now() - new Date(pr.updatedAt).getTime()) < RECENT_PUSH_MS;
        const status = await fetchCheckStatus(pr.repository, pr.headRefOid, recentlyUpdated);
        if (pr.checkStatus === status.checkStatus && pr.checkStatusLabel === status.checkStatusLabel) { return; }
        pr.checkStatus = status.checkStatus;
        pr.checkStatusLabel = status.checkStatusLabel;
        onPartialResults?.({ type: 'checks', pr: { url: pr.url, checkStatus: pr.checkStatus, checkStatusLabel: pr.checkStatusLabel } });
    })).then(() => {
        console.log(`[gh] check enrichment done — ${_callCount - before} gh calls total this fetch`);
    });

    console.log(`[gh] fetchPullRequests returning (check enrichment still running) — ${repositories.length} repos`);
    return result;
}

function clearPrListCache() {
    prListCache.clear();
    checkRunsCache.clear();
    // perRepoPrCache intentionally NOT cleared — delta cache survives manual refresh
    // so only repos with new pushes are re-fetched. Clear it only on hard reset.
    console.log('[gh] prListCache + checkRunsCache cleared (manual refresh), delta cache preserved');
}

function clearAllCaches() {
    prListCache.clear();
    checkRunsCache.clear();
    perRepoPrCache.clear();
    repoListCache.clear();
    console.log('[gh] all caches cleared (hard reset)');
}

async function fetchCommitMessage(nameWithOwner, sha) {
    const data = await runGh(['api', `repos/${nameWithOwner}/commits/${sha}`, '--jq', '{message: .commit.message, author: .commit.author.name, date: .commit.author.date}']);
    return data;
}

async function fetchMergedPrsForRange({ org, topic, watchedRepos = [], namespace, from, to, text, repo, limit = 50 }) {
    if (!org || !topic) { throw new Error('GitHub org and topic are required.'); }
    const dateRange = to ? `${from}..${to}` : `>=${from}`;
    const repositories = await fetchRepoList(org, topic);
    const repoNames = repositories.map((r) => r.nameWithOwner);
    const watchedReposFull = (watchedRepos || []).map((r) => r.includes('/') ? r : `${org}/${r}`);
    const allRepos = repo ? [repo] : [...new Set([...repoNames, ...watchedReposFull])];
    const perRepo = repo ? limit : Math.max(1, Math.ceil(limit / allRepos.length));

    const results = await Promise.allSettled(allRepos.map(async (nameWithOwner) => {
        const searchQuery = [text ? `${text} in:title` : null, `merged:${dateRange}`].filter(Boolean).join(' ');
        const args = ['pr', 'list', '--repo', nameWithOwner, '--state', 'merged', '--search', searchQuery, '--limit', String(perRepo), '--json', MERGED_PR_FIELDS];
        const prs = await runGh(args);
        return prs.map((pr) => normalizePr(pr, nameWithOwner));
    }));

    const prs = results.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    return { mergedRangePullRequests: prs.slice(0, limit) };
}

module.exports = { fetchPullRequests, clearPrListCache, clearAllCaches, fetchCommitMessage, fetchMergedPrsForRange, fetchRepoList };
