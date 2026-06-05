const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function runAz(args) {
    const { stdout } = await execFileAsync('az', args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
}

async function fetchPipelineRuns({ org, project }) {
    if (!org || !project) { throw new Error('Azure DevOps org and project are required.'); }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const runs = await runAz([
        'pipelines', 'runs', 'list',
        '--org', org,
        '--project', project,
        '--query-order', 'QueueTimeDesc',
        '--top', '100',
        '-o', 'json',
    ]);

    return runs
        .filter((r) => new Date(r.startTime || r.queueTime) >= today)
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
            };
        });
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
        return failed.map((r) => r.name).join(', ');
    } catch {
        return null;
    }
}

module.exports = { fetchPipelineRuns, fetchFailedStep };
