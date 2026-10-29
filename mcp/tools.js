'use strict';

const OPEN_KEYS = ['pullRequests', 'dependabotPullRequests', 'iacPullRequests'];
const MERGED_KEYS = [
    'mergedPullRequests', 'mergedDependabotPullRequests', 'mergedIacPullRequests',
    'mergedYesterdayPullRequests', 'mergedYesterdayDependabotPullRequests', 'mergedYesterdayIacPullRequests',
];
const FAILING_STATUSES = new Set(['error', 'crash-loop', 'failed', 'unavailable']);
const BOT_KEYS = new Set(OPEN_KEYS.concat(MERGED_KEYS).filter((k) => /dependabot|iac/i.test(k)));
const STALE_AFTER_MINUTES = 15;

class ToolInputError extends Error {}

function includes(haystack, needle) {
    return !needle || String(haystack || '').toLowerCase().includes(String(needle).toLowerCase());
}

function trelloShortLink(value) {
    const text = String(value || '').trim();
    const match = /trello\.com\/c\/([A-Za-z0-9]{8})/.exec(text) || /_([A-Za-z0-9]{8})$/.exec(text);
    return match ? match[1] : text;
}

function limited(items, limit) {
    return { total: items.length, returned: Math.min(items.length, limit), items: items.slice(0, limit) };
}

function compactPr(pr) {
    return {
        repository: pr.repository,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login || null,
        branch: pr.headRefName || null,
        isDraft: Boolean(pr.isDraft),
        reviewDecision: pr.reviewDecision || null,
        checkStatus: pr.checkStatus || null,
        createdAt: pr.createdAt || null,
        updatedAt: pr.updatedAt || null,
        mergedAt: pr.mergedAt || null,
        trelloCard: pr.trelloCard || null,
    };
}

function collectPrs(snapshot, { state = 'open', includeBots = false } = {}) {
    const lists = snapshot.pullRequests || {};
    const keys = state === 'open' ? OPEN_KEYS : state === 'merged' ? MERGED_KEYS : OPEN_KEYS.concat(MERGED_KEYS);
    const seen = new Set();
    const out = [];
    for (const key of keys) {
        if (!includeBots && BOT_KEYS.has(key)) { continue; }
        for (const pr of Array.isArray(lists[key]) ? lists[key] : []) {
            if (seen.has(pr.url)) { continue; }
            seen.add(pr.url);
            out.push(pr);
        }
    }
    return out;
}

function listPullRequests(snapshot, { limit = 50, ...args } = {}) {
    const card = args.trelloCard ? trelloShortLink(args.trelloCard) : null;
    const prs = collectPrs(snapshot, args)
        .filter((pr) => includes(pr.repository, args.repo))
        .filter((pr) => includes(pr.author?.login, args.author))
        .filter((pr) => !card || pr.trelloCard?.id === card)
        .map(compactPr);
    return limited(prs, limit);
}

function listTrelloCards(snapshot, { includeMerged = true, limit = 30 } = {}) {
    const groups = new Map();
    let withoutCard = 0;
    for (const pr of collectPrs(snapshot, { state: includeMerged ? 'all' : 'open' })) {
        if (!pr.trelloCard) { withoutCard++; continue; }
        if (!groups.has(pr.trelloCard.id)) { groups.set(pr.trelloCard.id, { card: pr.trelloCard, pullRequests: [] }); }
        groups.get(pr.trelloCard.id).pullRequests.push(compactPr(pr));
    }
    return { ...limited([...groups.values()], limit), pullRequestsWithoutCard: withoutCard };
}

function listPipelineRuns(snapshot, { result, repo, branch, limit = 30 } = {}) {
    const runs = Object.entries(snapshot.pipelines || {}).flatMap(([source, entry]) =>
        (entry.runs || []).map((run) => ({ source, ...run })));
    const wanted = String(result || '').toLowerCase();
    const filtered = runs
        .filter((run) => !wanted || String(run.result).toLowerCase() === wanted || String(run.status).toLowerCase() === wanted)
        .filter((run) => includes(run.repoName || run.name, repo))
        .filter((run) => includes(run.sourceBranch, branch))
        .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
    return limited(filtered, limit);
}

function compactDeployment(source, dep) {
    return {
        source,
        name: dep.name,
        namespace: dep.namespace,
        status: dep.status,
        ready: dep.ready,
        desired: dep.desired,
        image: dep.image,
        gitSha: dep.gitSha || null,
        deployedAt: dep.deployedAt || null,
        failures: dep.failures || [],
    };
}

function deploymentEntries(snapshot, { context, namespace } = {}) {
    return Object.entries(snapshot.deployments || {})
        .filter(([, entry]) => includes(entry.context, context))
        .filter(([, entry]) => !namespace || !entry.namespace || includes(entry.namespace, namespace));
}

function findDeployments(snapshot, args = {}) {
    return deploymentEntries(snapshot, args).flatMap(([source, entry]) =>
        (entry.deployments || [])
            .filter((dep) => includes(dep.namespace, args.namespace))
            .map((dep) => ({ source, dep })));
}

function listDeployments(snapshot, { limit = 100, ...args } = {}) {
    const deps = findDeployments(snapshot, args)
        .filter(({ dep }) => includes(dep.name, args.name))
        .filter(({ dep }) => !args.unhealthyOnly || FAILING_STATUSES.has(dep.status))
        .map(({ source, dep }) => compactDeployment(source, dep));
    return limited(deps, limit);
}

function getDeployment(snapshot, args) {
    const name = args.name.toLowerCase();
    return findDeployments(snapshot, args)
        .filter(({ dep }) => String(dep.name).toLowerCase() === name)
        .map(({ source, dep }) => ({ source, ...dep }));
}

function ageMinutes(iso, now) {
    if (!iso) { return null; }
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? Math.round((now.getTime() - ms) / 60_000) : null;
}

function isStale(age) {
    return age === null || age < -1 || age > STALE_AFTER_MINUTES;
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function freshness(snapshot, { now = new Date(), isAlive = isProcessAlive } = {}) {
    const age = ageMinutes(snapshot.writtenAt, now);
    return {
        writtenAt: snapshot.writtenAt || null,
        ageMinutes: age,
        appRunning: Number.isInteger(snapshot.app?.pid) ? isAlive(snapshot.app.pid) : false,
        stale: isStale(age),
    };
}

function sourceStatus(source, entry, now) {
    return { source, fetchedAt: entry?.fetchedAt || null, ageMinutes: ageMinutes(entry?.fetchedAt, now), lastError: entry?.lastError || null };
}

function sourcesFor(section, snapshot, args, now) {
    if (section === 'pullRequests') { return [sourceStatus('pullRequests', snapshot.pullRequests, now)]; }
    if (section === 'pipelines') {
        return Object.entries(snapshot.pipelines || {}).map(([source, entry]) => sourceStatus(source, entry, now));
    }
    if (section === 'deployments') {
        return deploymentEntries(snapshot, args).map(([source, entry]) => sourceStatus(source, entry, now));
    }
    return [];
}

function sourceWarnings(section, sources) {
    if (section && !sources.length) { return [`No ${section} have been fetched for these filters; the result is empty because there is no data, not because there is nothing.`]; }
    return sources.flatMap((s) => {
        const out = [];
        if (!s.fetchedAt) { out.push(`${s.source}: never fetched, so there is no data for it.`); }
        if (s.lastError) { out.push(`${s.source}: last fetch failed at ${s.lastError.at} (${s.lastError.message}); showing data from ${s.fetchedAt || 'never'}.`); }
        return out;
    });
}

function dashboardStatus(snapshot, _args, { now = new Date() } = {}) {
    const section = (entries) => Object.entries(entries || {}).map(([source, entry]) => ({
        ...sourceStatus(source, entry, now),
        count: (entry.runs || entry.deployments || []).length,
    }));
    const prStatus = sourceStatus('pullRequests', snapshot.pullRequests, now);
    delete prStatus.source;
    return {
        version: snapshot.version,
        app: snapshot.app || null,
        pullRequests: {
            ...prStatus,
            open: collectPrs(snapshot, { state: 'open', includeBots: true }).length,
            merged: collectPrs(snapshot, { state: 'merged', includeBots: true }).length,
        },
        pipelines: section(snapshot.pipelines),
        deployments: section(snapshot.deployments),
    };
}

function checkType(key, value, schema) {
    const expected = schema.type;
    const ok = expected === 'integer' ? Number.isInteger(value)
        : expected === 'string' ? typeof value === 'string'
            : expected === 'boolean' ? typeof value === 'boolean'
                : true;
    if (!ok) { throw new ToolInputError(`"${key}" must be ${expected === 'integer' ? 'an' : 'a'} ${expected}, got ${JSON.stringify(value)}.`); }
    if (schema.enum && !schema.enum.includes(value)) { throw new ToolInputError(`"${key}" must be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}.`); }
    if (schema.minimum !== undefined && value < schema.minimum) { throw new ToolInputError(`"${key}" must be at least ${schema.minimum}.`); }
    if (schema.maximum !== undefined && value > schema.maximum) { throw new ToolInputError(`"${key}" must be at most ${schema.maximum}.`); }
    if (schema.minLength !== undefined && value.length < schema.minLength) { throw new ToolInputError(`"${key}" must not be empty.`); }
}

function validateArgs(tool, args) {
    if (args === undefined || args === null) { args = {}; }
    if (typeof args !== 'object' || Array.isArray(args)) { throw new ToolInputError('Arguments must be an object.'); }
    const { properties = {}, required = [] } = tool.inputSchema;
    for (const key of required) {
        if (args[key] === undefined) { throw new ToolInputError(`"${key}" is required.`); }
    }
    for (const [key, value] of Object.entries(args)) {
        if (!properties[key]) { throw new ToolInputError(`Unknown argument "${key}". Allowed: ${Object.keys(properties).join(', ') || 'none'}.`); }
        checkType(key, value, properties[key]);
    }
    return args;
}

const PR_STATE = { type: 'string', enum: ['open', 'merged', 'all'], description: 'open (default), merged (today and yesterday) or all' };
const limitSchema = (fallback, what) => ({ type: 'integer', minimum: 1, maximum: 500, description: `Max ${what} (default ${fallback})` });
const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

const TOOLS = [
    {
        name: 'dashboard_status',
        description: 'How old each part of the Kubernetes Dashboard snapshot is (PRs, each pipeline source, each context/namespace), the last fetch error per part, and the app version.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        run: dashboardStatus,
    },
    {
        name: 'list_pull_requests',
        section: 'pullRequests',
        description: 'Open or recently merged pull requests in the team\'s repos, with review state, check status and the Trello card from the branch name. Returns { total, returned, items }.',
        inputSchema: {
            type: 'object',
            properties: {
                state: PR_STATE,
                repo: { type: 'string', description: 'Part of the repository name' },
                author: { type: 'string', description: 'Part of the GitHub login' },
                trelloCard: { type: 'string', description: 'Trello card shortLink, card URL or branch name' },
                includeBots: { type: 'boolean', description: 'Include Dependabot and IaC PRs (default false)' },
                limit: limitSchema(50, 'PRs'),
            },
            additionalProperties: false,
        },
        run: listPullRequests,
    },
    {
        name: 'list_trello_cards',
        section: 'pullRequests',
        description: 'Pull requests grouped by the Trello card in their branch name (b branch adds _<shortLink>). Returns { total, returned, items, pullRequestsWithoutCard }.',
        inputSchema: {
            type: 'object',
            properties: {
                includeMerged: { type: 'boolean', description: 'Include PRs merged today and yesterday (default true)' },
                limit: limitSchema(30, 'cards'),
            },
            additionalProperties: false,
        },
        run: listTrelloCards,
    },
    {
        name: 'list_pipeline_runs',
        section: 'pipelines',
        description: 'Azure DevOps pipeline runs from the last 7 days, newest first. Returns { total, returned, items }.',
        inputSchema: {
            type: 'object',
            properties: {
                result: { type: 'string', description: 'succeeded, failed, canceled, or a status such as inProgress' },
                repo: { type: 'string', description: 'Part of the repository or pipeline name' },
                branch: { type: 'string', description: 'Part of the source branch, or "PR #123"' },
                limit: limitSchema(30, 'runs'),
            },
            additionalProperties: false,
        },
        run: listPipelineRuns,
    },
    {
        name: 'list_deployments',
        section: 'deployments',
        description: 'Kubernetes deployments per context and namespace: status, ready replicas, image, git SHA and failures. Returns { total, returned, items }.',
        inputSchema: {
            type: 'object',
            properties: {
                context: { type: 'string', description: 'Part of the kubectl context name, e.g. "qa" or "prod"' },
                namespace: { type: 'string', description: 'Part of the namespace' },
                name: { type: 'string', description: 'Part of the deployment name' },
                unhealthyOnly: { type: 'boolean', description: 'Only error, crash-loop, failed or unavailable' },
                limit: limitSchema(100, 'deployments'),
            },
            additionalProperties: false,
        },
        run: listDeployments,
    },
    {
        name: 'get_deployment',
        section: 'deployments',
        description: 'One deployment with pods, events and rollout history, in every context where it was seen.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1, description: 'Deployment name (exact, case-insensitive)' },
                context: { type: 'string', description: 'Part of the kubectl context name' },
                namespace: { type: 'string', description: 'Part of the namespace' },
            },
            required: ['name'],
            additionalProperties: false,
        },
        run: getDeployment,
    },
].map((tool) => ({ ...tool, annotations: READ_ONLY }));

module.exports = {
    TOOLS, ToolInputError, freshness, validateArgs, sourcesFor, sourceWarnings, trelloShortLink,
    listPullRequests, listTrelloCards, listPipelineRuns, listDeployments, getDeployment, dashboardStatus,
};
