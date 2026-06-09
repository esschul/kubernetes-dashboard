'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

const DEPENDABOT_LOGIN = 'app/dependabot';
const OPEN_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,reviewDecision,statusCheckRollup,comments,reviews';
const MERGED_PR_FIELDS = 'number,title,url,author,isDraft,createdAt,updatedAt,mergedAt,reviewDecision,statusCheckRollup';

async function runGh(args) {
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

function normalizeCheckStatus(pr) {
    const checks = pr.statusCheckRollup || [];
    if (!checks.length) { return { checkStatus: 'none', checkStatusLabel: 'No checks' }; }
    const failed = ['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'];
    const hasFailure = checks.some((c) => failed.includes(c.conclusion || c.state));
    if (hasFailure) { return { checkStatus: 'failure', checkStatusLabel: 'Checks failing' }; }
    const hasPending = checks.some((c) => {
        if (c.conclusion) { return false; }
        const s = c.state || c.status;
        return s && s !== 'SUCCESS' && s !== 'COMPLETED';
    });
    if (hasPending) { return { checkStatus: 'pending', checkStatusLabel: 'Checks pending' }; }
    return { checkStatus: 'success', checkStatusLabel: 'Checks passing' };
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
    return { ...pr, ...getLatestCommentActivity(pr), ...normalizeCheckStatus(pr), repository };
}

// Cache the repo list — it rarely changes and costs a GraphQL API call each time
const repoListCache = new Map(); // key: `${org}/${topic}` → { repos, fetchedAt }
const REPO_LIST_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function fetchRepoList(org, topic) {
    const key = `${org}/${topic}`;
    const cached = repoListCache.get(key);
    if (cached && (Date.now() - cached.fetchedAt) < REPO_LIST_TTL_MS) {
        return cached.repos;
    }
    const repos = await runGh([
        'repo', 'list', org,
        '--topic', topic,
        '--no-archived',
        '--limit', '100',
        '--json', 'nameWithOwner',
    ]);
    repoListCache.set(key, { repos, fetchedAt: Date.now() });
    return repos;
}

async function fetchPullRequests({ org, topic }) {
    if (!org || !topic) { throw new Error('GitHub org and topic are required. Set them in Settings.'); }

    const today = getLocalDateKey();
    const repositories = await fetchRepoList(org, topic);

    const lists = await Promise.all(repositories.map(async ({ nameWithOwner }) => {
        const [open, merged] = await Promise.all([
            runGh(['pr', 'list', '--repo', nameWithOwner, '--limit', '100', '--json', OPEN_PR_FIELDS]),
            runGh(['pr', 'list', '--repo', nameWithOwner, '--state', 'merged', '--search', `merged:${today}`, '--limit', '100', '--json', MERGED_PR_FIELDS]),
        ]);
        return {
            pullRequests: open.map((pr) => normalizePr(pr, nameWithOwner)),
            mergedPullRequests: merged.map((pr) => normalizePr(pr, nameWithOwner)),
        };
    }));

    const all = lists.flatMap((l) => l.pullRequests)
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const allMerged = lists.flatMap((l) => l.mergedPullRequests)
        .filter((pr) => getLocalDateKey(pr.mergedAt) === today)
        .sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));

    return {
        pullRequests: all.filter((pr) => pr.author?.login !== DEPENDABOT_LOGIN),
        mergedPullRequests: allMerged.filter((pr) => pr.author?.login !== DEPENDABOT_LOGIN),
        dependabotPullRequests: all.filter((pr) => pr.author?.login === DEPENDABOT_LOGIN)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
        mergedDependabotPullRequests: allMerged.filter((pr) => pr.author?.login === DEPENDABOT_LOGIN),
        repositories: repositories.map((r) => r.nameWithOwner),
        refreshedAt: new Date().toISOString(),
    };
}

module.exports = { fetchPullRequests };
