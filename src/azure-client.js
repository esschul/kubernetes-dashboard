const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

async function runAz(args) {
    const { stdout } = await execFileAsync(resolveCommand('az', 'AZ_PATH'), args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
    });
    return JSON.parse(stdout);
}

async function fetchPipelineRuns({ org, project }) {
    if (!org || !project) { throw new Error('Azure DevOps org and project are required.'); }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    cutoff.setHours(0, 0, 0, 0);

    const runs = await runAz([
        'pipelines', 'runs', 'list',
        '--org', org,
        '--project', project,
        '--query-order', 'QueueTimeDesc',
        '--top', '500',
        '-o', 'json',
    ]);

    return runs
        .filter((r) => new Date(r.startTime || r.queueTime) >= cutoff)
        .map((r) => {
            const sourceBranch = (r.sourceBranch || '').replace('refs/heads/', '');
            const prNumber = r.sourceBranch?.match(/refs\/pull\/(\d+)\/merge/)?.[1] || null;
            const trigger = normalizeTrigger(r.reason, r.requestedFor?.displayName, prNumber);
            const team = (r.definition?.path || '\\').replace(/\\/g, '').trim() || null;


            return {
                id: r.id,
                name: r.definition?.name || 'Unknown',
                buildNumber: r.buildNumber,
                status: r.status,
                result: r.result,
                sourceBranch: prNumber ? `PR #${prNumber}` : sourceBranch,
                trigger,
                startTime: r.startTime || r.queueTime || null,
                finishTime: r.finishTime || null,
                url: `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_build/results?buildId=${r.id}`,
                team,
                sourceVersion: r.sourceVersion || null,
                repoName: normalizeRepoName(r.repository?.name || r.definition?.name) || null,
            };
        });
}

// Pipeline definition names often include a team/org folder prefix, e.g. "acme.my-service"
// Strip it so we end up with just the repo name part, e.g. "my-service"
function normalizeRepoName(name) {
    if (!name) { return null; }
    // Strip org-prefix like "acme." from repo/definition names
    return name.replace(/^[^.]+\./, '');
}

function deriveRepoName(definitionName) {
    return normalizeRepoName(definitionName);
}

function normalizeTrigger(reason, requestedBy, prNumber) {
    if (reason === 'pullRequest' || prNumber) { return prNumber ? `PR #${prNumber}` : 'Pull request'; }
    if (reason === 'batchedCI') { return 'Batched CI'; }
    if (reason === 'individualCI') { return 'Commit'; }
    if (reason === 'schedule') { return 'Scheduled'; }
    if (reason === 'manual') {
        // Show real user name if it's a human
        const isBot = !requestedBy || requestedBy.includes('Microsoft') || requestedBy === 'GitHub';
        return isBot ? 'Manual' : requestedBy;
    }
    // Fall back to a cleaned-up requestedBy if it's a real name
    if (requestedBy && !requestedBy.includes('Microsoft') && requestedBy !== 'GitHub') {
        return requestedBy;
    }
    return reason || '—';
}

async function fetchFailedStep({ org, project, buildId }) {
    try {
        const timeline = await runAz([
            'rest', '--method', 'get',
            '--resource', '499b84ac-1321-427f-aa17-267ca6975798',
            '--url', `${org.replace(/\/$/, '')}/${encodeURIComponent(project)}/_apis/build/builds/${buildId}/timeline?api-version=7.0`,
        ]);

        const records = timeline.records || [];
        // Prefer Task-level failures (most specific), fall back to Job
        const tasks = records.filter((r) => r.result === 'failed' && r.type === 'Task' && r.name);
        const jobs = records.filter((r) => r.result === 'failed' && r.type === 'Job' && r.name);
        const failed = tasks.length > 0 ? tasks : jobs;

        if (failed.length === 0) { return null; }
        return {
            stepName: failed.map((r) => r.name).join(', '),
            logUrl: failed[0].log?.url || null,
        };
    } catch {
        return null;
    }
}

function extractLogErrors(lines) {
    return lines
        .filter((l) => {
            const t = l.trimStart();
            return l.includes('[ERROR]')
                || l.includes('##[error]')
                || l.toLowerCase().includes('npm error')
                || l.includes('FAILURE:')
                || l.includes('BUILD FAILED')
                || l.includes('Error:')
                || l.includes('ERROR in ')
                || l.includes('FAIL ')
                || l.includes('● ')
                || t.startsWith('* What went wrong:')
                || t.startsWith('> ');
        })
        .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.Z]+ /, '').trim())
        .filter(Boolean);
}

async function fetchLogErrors({ org, logUrl }) {
    if (!logUrl) { return []; }
    try {
        const url = logUrl.startsWith('http') ? logUrl : `${org.replace(/\/$/, '')}/${logUrl}`;
        // Log content is plain text — az rest returns it as a JSON string, so parse accordingly
        const { stdout } = await execFileAsync(
            resolveCommand('az', 'AZ_PATH'),
            ['rest', '--method', 'get', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--url', url],
            {
                timeout: 30_000,
                maxBuffer: 10 * 1024 * 1024,
                env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
            }
        );
        // az rest returns the log as a quoted JSON string or raw text depending on content-type
        let text = stdout;
        try { text = JSON.parse(stdout); } catch { /* raw text, use as-is */ }
        const lines = String(text).split('\n');
        return extractLogErrors(lines);
    } catch {
        return [];
    }
}

async function rerunFailedJobs({ org, project, buildId }) {
    const orgUrl = org.replace(/\/$/, '');
    const url = `${orgUrl}/${encodeURIComponent(project)}/_apis/build/builds/${buildId}?retry=true&api-version=7.1`;
    const { stdout: token } = await execFileAsync(resolveCommand('az', 'AZ_PATH'), [
        'account', 'get-access-token',
        '--resource', '499b84ac-1321-427f-aa17-267ca6975798',
        '--query', 'accessToken', '-o', 'tsv',
    ], { env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() } });
    return runAz(['rest', '--method', 'patch', '--url', url,
        '--headers', `Authorization=Bearer ${token.trim()}`,
        '--body', `{"id":${buildId},"retry":true}`]);
}

module.exports = { fetchPipelineRuns, fetchFailedStep, fetchLogErrors, extractLogErrors, rerunFailedJobs };
