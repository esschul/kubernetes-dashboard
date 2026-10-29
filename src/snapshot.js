'use strict';

const fs = require('node:fs');
const { getTrelloCardFromBranch } = require('./renderer-utils');

const SNAPSHOT_VERSION = 1;

function withTrelloCards(pullRequestResult) {
    const out = {};
    for (const [key, value] of Object.entries(pullRequestResult)) {
        out[key] = /pullRequests$/i.test(key) && Array.isArray(value)
            ? value.map((pr) => ({ ...pr, trelloCard: getTrelloCardFromBranch(pr.headRefName) }))
            : value;
    }
    return out;
}

function createSnapshotStore(filePath, { delayMs = 1000, now = () => new Date(), app = {} } = {}) {
    const startedAt = now().toISOString();
    const state = {
        pullRequests: { fetchedAt: null, lastError: null, data: null },
        pipelines: {},
        deployments: {},
    };
    let timer = null;

    function build() {
        const prs = state.pullRequests;
        return {
            version: SNAPSHOT_VERSION,
            writtenAt: now().toISOString(),
            app: { version: app.version || null, pid: process.pid, startedAt },
            pullRequests: {
                fetchedAt: prs.fetchedAt,
                lastError: prs.lastError,
                ...(prs.data ? withTrelloCards(prs.data) : {}),
            },
            pipelines: state.pipelines,
            deployments: state.deployments,
        };
    }

    async function flush() {
        if (timer) { clearTimeout(timer); timer = null; }
        const tmp = `${filePath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(build(), null, 2), 'utf8');
        await fs.promises.rename(tmp, filePath);
    }

    function schedule() {
        if (timer) { return; }
        timer = setTimeout(() => {
            timer = null;
            flush().catch((err) => console.log(`[snapshot] write failed: ${err.message}`));
        }, delayMs);
        timer.unref?.();
    }

    function errorInfo(err) {
        return { at: now().toISOString(), message: err?.message || String(err) };
    }

    function entry(map, key, extra) {
        if (!map[key]) { map[key] = { ...extra, fetchedAt: null, lastError: null }; }
        return map[key];
    }

    const pipelineKey = ({ org, project }) => `${org}/${project}`;
    const deploymentKey = ({ context, namespace }) => `${context || '(current)'}/${namespace || '(all)'}`;
    const deploymentExtra = ({ context, namespace }) => ({ context: context || null, namespace: namespace || null });

    return {
        filePath,
        build,
        flush,
        touch: schedule,
        setPullRequests(result) {
            state.pullRequests = { fetchedAt: now().toISOString(), lastError: null, data: result };
            schedule();
        },
        applyCheckStatus({ url, checkStatus, checkStatusLabel }) {
            for (const [key, list] of Object.entries(state.pullRequests.data || {})) {
                if (!/pullRequests$/i.test(key) || !Array.isArray(list)) { continue; }
                for (const pr of list) {
                    if (pr.url === url) { Object.assign(pr, { checkStatus, checkStatusLabel }); }
                }
            }
            schedule();
        },
        setPullRequestsError(err) {
            state.pullRequests.lastError = errorInfo(err);
            schedule();
        },
        setPipelines(config, runs) {
            Object.assign(entry(state.pipelines, pipelineKey(config)), { fetchedAt: now().toISOString(), lastError: null, runs });
            schedule();
        },
        setPipelinesError(config, err) {
            entry(state.pipelines, pipelineKey(config)).lastError = errorInfo(err);
            schedule();
        },
        setDeployments(config, deployments) {
            Object.assign(entry(state.deployments, deploymentKey(config), deploymentExtra(config)), { fetchedAt: now().toISOString(), lastError: null, deployments });
            schedule();
        },
        setDeploymentsError(config, err) {
            entry(state.deployments, deploymentKey(config), deploymentExtra(config)).lastError = errorInfo(err);
            schedule();
        },
    };
}

module.exports = { createSnapshotStore, SNAPSHOT_VERSION };
