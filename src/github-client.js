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

async function runGh(args) {
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

    const repoFullName = await resolveRepo(repoName, sha, org);
    if (!repoFullName) { return null; }

    const pulls = await runGh([
        'api',
        `repos/${repoFullName}/commits/${sha}/pulls`,
        '-H', 'Accept: application/vnd.github.groot-preview+json',
    ]);

    const pr = pulls?.[0];
    if (!pr) { return null; }

    const trelloUrl = await fetchTrelloUrl(repoFullName, pr.number);

    return {
        number: pr.number,
        title: pr.title,
        author: pr.user?.login,
        url: pr.html_url,
        mergedAt: pr.merged_at,
        state: pr.state,
        trelloUrl,
    };
}

async function fetchTrelloUrl(repoFullName, prNumber) {
    try {
        const comments = await runGh(['api', `repos/${repoFullName}/issues/${prNumber}/comments`]);
        for (const comment of comments) {
            const match = comment.body?.match(/https?:\/\/trello\.com\/[^\s<>"']+/);
            if (match) { return cleanTrailingUrlPunctuation(match[0]); }
        }
    } catch { /* ignore */ }
    return null;
}

function cleanTrailingUrlPunctuation(url) {
    return url.replace(/[),.;:!?]+$/g, '');
}

module.exports = { fetchPrForSha };
