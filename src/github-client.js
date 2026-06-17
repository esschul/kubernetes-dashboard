const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

// Persist repoName → repoFullName to disk so we never search the same deployment twice
let repoCache = new Map();
let repoCacheFile = null;

// In-memory caches (session-lived)
const prForShaCache = new Map();    // sha → pr object or null
const trelloUrlCache = new Map();   // `${repoFullName}/${prNumber}` → url or null

function getRepoCacheFile() {
    if (!repoCacheFile) {
        repoCacheFile = path.join(app.getPath('userData'), 'repo-cache.json');
    }
    return repoCacheFile;
}

function loadRepoCache() {
    try {
        const raw = fs.readFileSync(getRepoCacheFile(), 'utf8');
        repoCache = new Map(Object.entries(JSON.parse(raw)));
    } catch {
        repoCache = new Map();
    }
}

function saveRepoCache() {
    try {
        fs.writeFileSync(getRepoCacheFile(), JSON.stringify(Object.fromEntries(repoCache)));
    } catch { /* ignore */ }
}

loadRepoCache();

let _callCount = 0;

async function runGh(args) {
    _callCount++;
    const label = args.slice(0, 3).join(' ');
    console.log(`[gh/github-client] #${_callCount} ${label} ${args[3] || ''}`);
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const { stdout } = await execFileAsync(ghPath, args, {
        timeout: 15_000,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
    });
    return JSON.parse(stdout);
}

async function resolveRepo(repoName, sha, org) {
    const cacheKey = `${org}/${repoName}`;
    if (repoCache.has(cacheKey)) { return repoCache.get(cacheKey); }

    // Fast path: try the repo name directly before doing an expensive search
    try {
        await runGh(['api', `repos/${org}/${repoName}/commits/${sha}`, '--jq', '.sha']);
        // If that didn't throw, the commit exists in this repo
        const repoFullName = `${org}/${repoName}`;
        repoCache.set(cacheKey, repoFullName);
        saveRepoCache();
        return repoFullName;
    } catch { /* repo doesn't exist or SHA not found — fall through to search */ }

    // Slow path: search across all repos in the org
    const results = await runGh([
        'search', 'commits', sha,
        '--owner', org,
        '--json', 'repository',
        '--limit', '1',
    ]);

    const repoFullName = results?.[0]?.repository?.fullName || null;
    if (repoFullName) {
        repoCache.set(cacheKey, repoFullName);
        saveRepoCache();
    }
    return repoFullName;
}

async function fetchPrForSha(sha, repoName, org) {
    if (!sha || !repoName || !org) { return null; }

    if (prForShaCache.has(sha)) {
        console.log(`[gh/github-client] prForSha cache HIT ${sha.slice(0, 7)}`);
        return prForShaCache.get(sha);
    }

    const repoFullName = await resolveRepo(repoName, sha, org);
    if (!repoFullName) { prForShaCache.set(sha, null); return null; }

    const pulls = await runGh([
        'api',
        `repos/${repoFullName}/commits/${sha}/pulls`,
        '-H', 'Accept: application/vnd.github.groot-preview+json',
    ]);

    const pr = pulls?.[0];
    if (!pr) { prForShaCache.set(sha, null); return null; }

    const trelloUrl = await fetchTrelloUrl(repoFullName, pr.number);

    const result = {
        number: pr.number,
        title: pr.title,
        author: pr.user?.login,
        url: pr.html_url,
        mergedAt: pr.merged_at,
        state: pr.state,
        trelloUrl,
    };
    prForShaCache.set(sha, result);
    return result;
}

async function fetchTrelloUrl(repoFullName, prNumber) {
    const cacheKey = `${repoFullName}/${prNumber}`;
    if (trelloUrlCache.has(cacheKey)) {
        console.log(`[gh/github-client] trelloUrl cache HIT ${cacheKey}`);
        return trelloUrlCache.get(cacheKey);
    }
    let url = null;
    try {
        const comments = await runGh(['api', `repos/${repoFullName}/issues/${prNumber}/comments`]);
        for (const comment of comments) {
            const match = comment.body?.match(/https?:\/\/trello\.com\/[^\s<>"']+/);
            if (match) { url = cleanTrailingUrlPunctuation(match[0]); break; }
        }
    } catch { /* ignore */ }
    trelloUrlCache.set(cacheKey, url);
    return url;
}

function cleanTrailingUrlPunctuation(url) {
    return url.replace(/[),.;:!?]+$/g, '');
}

// Fetch PR info directly by PR number (used when we have no commit SHA, e.g. running pipelines)
const prByNumberCache = new Map(); // key: `${org}/${repoName}/${prNumber}`

async function fetchPrByNumber(prNumber, repoName, org) {
    if (!prNumber || !repoName || !org) { return null; }
    const cacheKey = `${org}/${repoName}/${prNumber}`;
    if (prByNumberCache.has(cacheKey)) { return prByNumberCache.get(cacheKey); }

    // Need to resolve the full repo name first
    const repos = [...repoCache.entries()]
        .filter(([k]) => k.startsWith(`${org}/`))
        .find(([, v]) => v?.toLowerCase().endsWith(`/${repoName.toLowerCase()}`));
    let repoFullName = repos?.[1] || null;

    // If not in cache, try direct lookup
    if (!repoFullName) {
        repoFullName = `${org}/${repoName}`;
    }

    try {
        const pr = await runGh(['api', `repos/${repoFullName}/pulls/${prNumber}`]);
        const trelloUrl = await fetchTrelloUrl(repoFullName, prNumber);
        const result = {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login,
            url: pr.html_url,
            mergedAt: pr.merged_at,
            state: pr.state,
            trelloUrl,
        };
        prByNumberCache.set(cacheKey, result);
        return result;
    } catch {
        prByNumberCache.set(cacheKey, null);
        return null;
    }
}

async function approvePr({ repoFullName, prNumber }) {
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const opts = { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() } };
    await execFileAsync(ghPath, ['pr', 'review', String(prNumber), '--approve', '--repo', repoFullName], opts);
}

async function mergePr({ repoFullName, prNumber, method }) {
    const ghPath = resolveCommand('gh', 'GH_PATH');
    const opts = { timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() } };
    const flag = method === 'rebase' ? '--rebase' : method === 'merge' ? '--merge' : '--squash';
    await execFileAsync(ghPath, ['pr', 'merge', String(prNumber), flag, '--repo', repoFullName, '--admin'], opts);
}

module.exports = { fetchPrForSha, fetchPrByNumber, approvePr, mergePr };
