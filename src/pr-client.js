'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

const DEPENDABOT_LOGIN = 'app/dependabot';
// headRefOid = head commit SHA, used to fetch check runs via REST
const OPEN_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,reviewDecision,headRefOid,comments,reviews';
const MERGED_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,mergedAt,reviewDecision';

const RECENT_PUSH_MS = 30 * 60 * 1000; // 30 minutes — only fetch checks for recently updated PRs
const checkRunsCache = new Map(); // key: `${nameWithOwner}/${sha}` → { checkStatus, checkStatusLabel, fetchedAt }

let _callCount = 0;

async function runGh(args) {
    _callCount++;
    const label = args.slice(0, 3).join(' ');
    console.log(`[gh] #${_callCount} ${label} ${args[3] || ''}`);
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const { stdout } = await execFileAsync(ghPath, args, {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
    });
    return JSON.parse(stdout);
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
        // Re-fetch if: still pending (re-check every 60s), or recently pushed (re-check every 2min)
        const shouldRefetch = (isPending && age > 60_000) || (recentlyUpdated && age > 2 * 60_000);
        if (!shouldRefetch) {
            console.log(`[gh] checkRuns cache HIT ${cacheKey} (${cached.checkStatus})`);
            return { checkStatus: cached.checkStatus, checkStatusLabel: cached.checkStatusLabel };
        }
    }

    try {
        const data = await runGh(['api', `repos/${nameWithOwner}/commits/${sha}/check-runs`, '--jq', '[.check_runs[] | {status,conclusion}]']);
        const runs = Array.isArray(data) ? data : [];
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

async function fetchRepoList(org, topic) {
    const key = `${org}/${topic}`;
    const cached = repoListCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < REPO_LIST_TTL_MS) {
        const ageS = Math.round((Date.now() - cached.fetchedAt) / 1000);
        console.log(`[gh] repoList cache HIT (${cached.repos.length} repos, ${ageS}s old)`);
        return cached.repos;
    }
    console.log(`[gh] repoList cache MISS — fetching from GitHub`);
    const repos = await runGh([
        'repo', 'list', org,
        '--topic', topic,
        '--no-archived',
        '--limit', '100',
        '--json', 'nameWithOwner',
    ]);
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

async function fetchPullRequests({ org, topic, watchedRepos = [], namespace }) {
    if (!org || !topic) { throw new Error('GitHub org and topic are required. Set them in Settings.'); }

    const before = _callCount;
    const today = getLocalDateKey();
    const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = getLocalDateKey(yesterdayDate);
    const repositories = await fetchRepoList(org, topic);
    const repoNames = repositories.map((r) => r.nameWithOwner);

    // Watched repos: fetch PRs labelled with the namespace name
    const label = namespace || topic;
    const watchedReposFull = watchedRepos.map((r) => r.includes('/') ? r : `${org}/${r}`);
    const watchedLists = await Promise.all(watchedReposFull.map(async (nameWithOwner) => {
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
    }));

    const lists = await Promise.all(repositories.map(async ({ nameWithOwner }) => {
        const [open, merged, mergedYesterday] = await Promise.all([
            fetchPrList(nameWithOwner, 'open', ['pr', 'list', '--repo', nameWithOwner, '--limit', '100', '--json', OPEN_PR_FIELDS]),
            fetchPrList(nameWithOwner, `merged:${today}`, ['pr', 'list', '--repo', nameWithOwner, '--state', 'merged', '--search', `merged:${today}`, '--limit', '100', '--json', MERGED_PR_FIELDS]),
            fetchPrList(nameWithOwner, `merged:${yesterday}`, ['pr', 'list', '--repo', nameWithOwner, '--state', 'merged', '--search', `merged:${yesterday}`, '--limit', '100', '--json', MERGED_PR_FIELDS]),
        ]);
        return {
            pullRequests: open.map((pr) => normalizePr(pr, nameWithOwner)),
            mergedPullRequests: merged.map((pr) => normalizePr(pr, nameWithOwner)),
            mergedYesterdayPullRequests: mergedYesterday.map((pr) => normalizePr(pr, nameWithOwner)),
        };
    }));

    const allLists = [...lists, ...watchedLists];

    const all = allLists.flatMap((l) => l.pullRequests)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const allMerged = allLists.flatMap((l) => l.mergedPullRequests)
        .filter((pr) => getLocalDateKey(pr.mergedAt) === today)
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
    const allMergedYesterday = allLists.flatMap((l) => l.mergedYesterdayPullRequests || [])
        .filter((pr) => getLocalDateKey(pr.mergedAt) === yesterday)
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));

    // Enrich all open PRs with check status via REST (not GraphQL — no quota cost)
    const prsWithSha = all.filter((pr) => pr.headRefOid);
    console.log(`[gh] enriching ${prsWithSha.length} PRs with check status via REST`);
    await Promise.allSettled(prsWithSha.map(async (pr) => {
        const recentlyUpdated = (Date.now() - new Date(pr.updatedAt).getTime()) < RECENT_PUSH_MS;
        const status = await fetchCheckStatus(pr.repository, pr.headRefOid, recentlyUpdated);
        pr.checkStatus = status.checkStatus;
        pr.checkStatusLabel = status.checkStatusLabel;
    }));

    console.log(`[gh] fetchPullRequests done — ${_callCount - before} gh calls this fetch (${repositories.length} repos), ${_callCount} total this session`);
    return {
        pullRequests: all.filter((pr) => pr.author?.login !== DEPENDABOT_LOGIN),
        mergedPullRequests: allMerged.filter((pr) => pr.author?.login !== DEPENDABOT_LOGIN),
        mergedYesterdayPullRequests: allMergedYesterday.filter((pr) => pr.author?.login !== DEPENDABOT_LOGIN),
        dependabotPullRequests: all.filter((pr) => pr.author?.login === DEPENDABOT_LOGIN)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
        mergedDependabotPullRequests: allMerged.filter((pr) => pr.author?.login === DEPENDABOT_LOGIN),
        mergedYesterdayDependabotPullRequests: allMergedYesterday.filter((pr) => pr.author?.login === DEPENDABOT_LOGIN),
        repositories: [...repoNames, ...watchedReposFull],
        refreshedAt: new Date().toISOString(),
    };
}

function clearPrListCache() {
    prListCache.clear();
    checkRunsCache.clear();
    console.log('[gh] prListCache + checkRunsCache cleared (manual refresh)');
}

module.exports = { fetchPullRequests, clearPrListCache };
