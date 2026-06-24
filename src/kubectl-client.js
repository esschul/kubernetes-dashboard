const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveCommand } = require('./command-paths');

const execFileAsync = promisify(execFile);

async function runKubectl(args, options = {}) {
    const { kubectlPath: configuredKubectlPath, ...execOptions } = options;
    const kubectlPath = configuredKubectlPath || resolveCommand('kubectl', 'KUBECTL_PATH');
    try {
        const { stdout } = await execFileAsync(kubectlPath, args, {
            timeout: 30_000,
            maxBuffer: 20 * 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() },
            ...execOptions,
        });
        return stdout;
    } catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`Could not find kubectl at "${kubectlPath}". Install kubectl in /opt/homebrew/bin or /usr/local/bin.`, { cause: err });
        }
        throw err;
    }
}

async function fetchDeployments({ context, namespace, kubectlPath }) {
    if (!namespace) { throw new Error('Namespace is required. Please set a namespace in Settings.'); }
    const nsArgs = ['--namespace', namespace];
    const ctxArgs = context ? ['--context', context] : [];

    const kubectlOptions = { kubectlPath };
    const [deploymentsRaw, podsRaw, eventsRaw, replicaSetsRaw] = await Promise.all([
        runKubectl([...ctxArgs, 'get', 'deployments', ...nsArgs, '-o', 'json'], kubectlOptions),
        runKubectl([...ctxArgs, 'get', 'pods', ...nsArgs, '-o', 'json'], kubectlOptions),
        runKubectl([...ctxArgs, 'get', 'events', ...nsArgs, '-o', 'json'], kubectlOptions).catch(() => '{"items":[]}'),
        runKubectl([...ctxArgs, 'get', 'replicasets', ...nsArgs, '-o', 'json'], kubectlOptions).catch(() => '{"items":[]}'),
    ]);

    const deployments = JSON.parse(deploymentsRaw).items || [];
    const pods = JSON.parse(podsRaw).items || [];
    const events = JSON.parse(eventsRaw).items || [];
    const replicaSets = JSON.parse(replicaSetsRaw).items || [];

    return normalizeDeployments(deployments, pods, events, replicaSets);
}

function normalizeDeployments(deployments, pods, events, replicaSets) {
    const podsByOwner = groupPodsByOwner(pods, replicaSets);
    const eventsByName = groupEventsByName(events);

    const normalized = deployments.map((dep) => {
        const name = dep.metadata.name;
        const namespace = dep.metadata.namespace;
        const labels = dep.spec.selector?.matchLabels || {};

        const deployedAt = getDeployedAt(dep, replicaSets);
        const depPods = podsByOwner[`${namespace}/${name}`] || [];
        const depEvents = [
            ...(eventsByName[`${namespace}/${name}`] || []),
            ...depPods.flatMap((p) => eventsByName[`${namespace}/${p.name}`] || []),
        ];

        const status = getDeploymentStatus(dep, depPods);
        const podSummary = summarizePods(depPods);
        const failures = collectFailures(dep, depPods, depEvents);
        const image = getImage(dep);

        const lastPodStart = depPods.reduce((latest, p) => {
            if (!p.startTime) { return latest; }
            return !latest || new Date(p.startTime) > new Date(latest) ? p.startTime : latest;
        }, null);

        const gitSha = depPods[0]?.labels?.['tags.datadoghq.com/version'] || null;
        const imageRepoName = image ? image.split('/').pop().split(':')[0] : null;

        const ownedRS = replicaSets.filter((rs) =>
            rs.metadata.namespace === namespace &&
            (rs.metadata.ownerReferences || []).some((ref) => ref.kind === 'Deployment' && ref.name === name)
        );
        const rollouts = ownedRS
            .map((rs) => {
                const changeReason = rs.metadata.annotations?.['kubernetes.io/change-cause'] || null;
                const deployedAtMatch = changeReason?.match(/Deployed:\s*([^,]+)/);
                const deployedAt = deployedAtMatch
                    ? new Date(deployedAtMatch[1].trim()).toISOString()
                    : rs.metadata.creationTimestamp;
                const imageTagMatch = changeReason?.match(/ImageTag:\s*([^,]+)/);
                const imageTag = imageTagMatch ? imageTagMatch[1].trim() : null;
                const releaseCommitMatch = changeReason?.match(/ReleaseCommit:\s*([^,\s]+)/);
                const releaseCommit = releaseCommitMatch ? releaseCommitMatch[1].trim() : null;
                const branchMatch = changeReason?.match(/Branch:\s*([^,]+)/);
                const branch = branchMatch ? branchMatch[1].trim() : null;
                const deployedByMatch = changeReason?.match(/DeployedBy:\s*([^,\s]+)/);
                const deployedBy = deployedByMatch ? deployedByMatch[1].trim() : null;
                return {
                    revision: rs.metadata.annotations?.['deployment.kubernetes.io/revision'] || null,
                    deployedAt,
                    isCurrent: (rs.spec.replicas ?? 0) > 0,
                    imageTag,
                    releaseCommit,
                    branch,
                    deployedBy,
                    changeReason,
                };
            })
            .sort((a, b) => new Date(b.deployedAt) - new Date(a.deployedAt));

        return {
            name,
            namespace,
            image,
            deployedAt: lastPodStart || deployedAt,
            rollouts,
            status,
            podSummary,
            pods: depPods.map((p) => normalizePod(p)),
            failures,
            desired: dep.spec.replicas ?? 1,
            ready: dep.status.readyReplicas ?? 0,
            labels,
            gitSha,
            imageRepoName,
        };
    });

    return normalized.sort((a, b) => {
        if (!a.deployedAt) { return 1; }
        if (!b.deployedAt) { return -1; }
        return new Date(b.deployedAt) - new Date(a.deployedAt);
    });
}

function getImage(dep) {
    const containers = dep.spec.template?.spec?.containers || [];
    if (containers.length === 0) { return null; }
    return containers[0].image || null;
}

function getDeployedAt(dep, replicaSets) {
    const depName = dep.metadata.name;
    const depNs = dep.metadata.namespace;

    // Find the most recently created replicaset owned by this deployment
    const ownedRS = replicaSets.filter((rs) =>
        rs.metadata.namespace === depNs &&
        (rs.metadata.ownerReferences || []).some(
            (ref) => ref.kind === 'Deployment' && ref.name === depName
        )
    );

    if (ownedRS.length > 0) {
        ownedRS.sort((a, b) =>
            new Date(b.metadata.creationTimestamp) - new Date(a.metadata.creationTimestamp)
        );
        const newest = ownedRS[0];
        // Only count RS as the deploy time if it has at least 1 replica configured
        if ((newest.spec.replicas ?? 0) > 0) {
            return newest.metadata.creationTimestamp;
        }
    }

    return dep.metadata.creationTimestamp;
}

function groupPodsByOwner(pods, replicaSets) {
    const rsByName = {};
    for (const rs of replicaSets) {
        rsByName[`${rs.metadata.namespace}/${rs.metadata.name}`] = rs;
    }

    const result = {};
    for (const pod of pods) {
        const ns = pod.metadata.namespace;
        const owners = pod.metadata.ownerReferences || [];
        const rsOwner = owners.find((o) => o.kind === 'ReplicaSet');
        if (!rsOwner) { continue; }

        const rs = rsByName[`${ns}/${rsOwner.name}`];
        if (!rs) { continue; }

        const depOwner = (rs.metadata.ownerReferences || []).find((o) => o.kind === 'Deployment');
        if (!depOwner) { continue; }

        const key = `${ns}/${depOwner.name}`;
        if (!result[key]) { result[key] = []; }
        result[key].push({
            name: pod.metadata.name,
            namespace: ns,
            phase: pod.status.phase,
            conditions: pod.status.conditions || [],
            containerStatuses: pod.status.containerStatuses || [],
            startTime: pod.status.startTime,
            labels: pod.metadata.labels || {},
        });
    }
    return result;
}

function normalizePod(pod) {
    const cs = pod.containerStatuses[0] || {};
    const restarts = cs.restartCount || 0;
    const ready = cs.ready || false;

    let podStatus = pod.phase || 'Unknown';
    if (cs.state?.waiting?.reason) { podStatus = cs.state.waiting.reason; }
    else if (cs.state?.terminated?.reason) { podStatus = cs.state.terminated.reason; }

    return {
        name: pod.name,
        status: podStatus,
        ready,
        restarts,
        startTime: pod.startTime || null,
    };
}

function groupEventsByName(events) {
    const result = {};
    for (const ev of events) {
        const ns = ev.metadata.namespace;
        const name = ev.involvedObject?.name;
        if (!name) { continue; }
        const key = `${ns}/${name}`;
        if (!result[key]) { result[key] = []; }
        result[key].push({
            type: ev.type,
            reason: ev.reason,
            message: ev.message,
            count: ev.count || 1,
            lastTimestamp: ev.lastTimestamp || ev.metadata.creationTimestamp,
        });
    }
    return result;
}

function getDeploymentStatus(dep, pods) {
    const desired = dep.spec.replicas ?? 1;
    const ready = dep.status.readyReplicas ?? 0;
    const available = dep.status.availableReplicas ?? 0;
    const updated = dep.status.updatedReplicas ?? 0;

    const conditions = dep.status.conditions || [];
    const progressing = conditions.find((c) => c.type === 'Progressing');
    const available_ = conditions.find((c) => c.type === 'Available');

    if (desired === 0) { return 'scaled-down'; }

    const hasCrashLoop = pods.some((p) =>
        p.containerStatuses.some((cs) => cs.state?.waiting?.reason === 'CrashLoopBackOff')
    );
    if (hasCrashLoop) { return 'crash-loop'; }

    const hasError = pods.some((p) =>
        p.containerStatuses.some((cs) => {
            const reason = cs.state?.waiting?.reason;
            return reason && reason !== 'ContainerCreating' && reason !== 'PodInitializing';
        })
    );
    if (hasError) { return 'error'; }

    if (progressing?.reason === 'ProgressDeadlineExceeded') { return 'failed'; }
    if (available_?.status === 'False') { return 'unavailable'; }

    if (ready < desired || updated < desired) { return 'progressing'; }
    if (available < desired) { return 'progressing'; }

    return 'healthy';
}

function summarizePods(pods) {
    const total = pods.length;
    const running = pods.filter((p) => p.phase === 'Running').length;
    const pending = pods.filter((p) => p.phase === 'Pending').length;
    const failed = pods.filter((p) => p.phase === 'Failed').length;
    const crashLoop = pods.filter((p) =>
        p.containerStatuses.some((cs) => cs.state?.waiting?.reason === 'CrashLoopBackOff')
    ).length;
    return { total, running, pending, failed, crashLoop };
}

function collectFailures(dep, pods, events) {
    const failures = [];

    // Deployment-level condition failures (e.g. ProgressDeadlineExceeded)
    // Only surface if the condition is currently active (status=False or reason=ProgressDeadlineExceeded
    // AND not subsequently recovered — i.e. Progressing is not True/NewReplicaSetAvailable)
    const conditions = dep.status.conditions || [];
    const progressing = conditions.find((c) => c.type === 'Progressing');
    const progressingRecovered = progressing?.status === 'True' && progressing?.reason === 'NewReplicaSetAvailable';
    if (!progressingRecovered) {
        for (const condition of conditions) {
            if (condition.status === 'False' || condition.reason === 'ProgressDeadlineExceeded') {
                const msg = condition.message || condition.reason;
                if (msg) { failures.push({ type: 'condition', message: msg }); }
            }
        }
    }

    for (const pod of pods) {
        for (const cs of pod.containerStatuses) {
            if (cs.state?.waiting?.reason === 'CrashLoopBackOff') {
                failures.push({
                    type: 'crash-loop',
                    pod: pod.name,
                    container: cs.name,
                    message: cs.state.waiting.message || 'CrashLoopBackOff',
                    restarts: cs.restartCount || 0,
                });
            } else if (cs.state?.waiting?.reason === 'OOMKilled' || cs.lastState?.terminated?.reason === 'OOMKilled') {
                failures.push({
                    type: 'oom',
                    pod: pod.name,
                    container: cs.name,
                    message: 'Out of memory',
                    restarts: cs.restartCount || 0,
                });
            } else if (cs.state?.waiting?.reason === 'ImagePullBackOff' || cs.state?.waiting?.reason === 'ErrImagePull') {
                failures.push({
                    type: 'image-pull',
                    pod: pod.name,
                    container: cs.name,
                    message: cs.state.waiting.message || cs.state.waiting.reason,
                    restarts: 0,
                });
            } else if (cs.state?.waiting && cs.state.waiting.reason && cs.state.waiting.reason !== 'ContainerCreating' && cs.state.waiting.reason !== 'PodInitializing') {
                failures.push({
                    type: 'waiting',
                    pod: pod.name,
                    container: cs.name,
                    message: `${cs.state.waiting.reason}: ${cs.state.waiting.message || ''}`.trim(),
                    restarts: cs.restartCount || 0,
                });
            }
        }
    }

    // Add warning events (deduplicated by reason)
    const seen = new Set();
    for (const ev of events) {
        if (ev.type !== 'Warning') { continue; }
        const key = ev.reason;
        if (seen.has(key)) { continue; }
        seen.add(key);
        failures.push({
            type: 'event',
            message: `${ev.reason}: ${ev.message}`,
            count: ev.count,
        });
    }

    return failures;
}

async function fetchNamespaces(config = {}) {
    const context = typeof config === 'string' ? config : config.context;
    const kubectlPath = typeof config === 'string' ? '' : config.kubectlPath;
    const ctxArgs = context ? ['--context', context] : [];
    const stdout = await runKubectl([...ctxArgs, 'get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}'], { kubectlPath });
    return stdout.split(/\s+/).map((s) => s.trim()).filter(Boolean).sort();
}

async function fetchContexts(config = {}) {
    const stdout = await runKubectl(['config', 'get-contexts', '--no-headers'], { kubectlPath: config.kubectlPath });
    return stdout.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const isCurrent = line.startsWith('*');
            const cols = line.replace(/^\*\s*/, '').trim().split(/\s{2,}/);
            const name = cols[0] || '';
            const cluster = cols[1] || '';
            return { name, cluster, isCurrent };
        });
}

async function rolloutUndo({ context, namespace, name, revision, kubectlPath }) {
    const ctxArgs = context ? ['--context', context] : [];
    const { stdout, stderr } = await execFileAsync(
        kubectlPath || resolveCommand('kubectl', 'KUBECTL_PATH'),
        [...ctxArgs, '--namespace', namespace, 'rollout', 'undo', `deployment/${name}`, `--to-revision=${revision}`],
        { timeout: 30_000, env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() } }
    ).catch((err) => { throw new Error(err.stderr || err.message); });
    return { stdout, stderr };
}

async function rolloutStatus({ context, namespace, name, kubectlPath }) {
    const ctxArgs = context ? ['--context', context] : [];
    const { stdout } = await execFileAsync(
        kubectlPath || resolveCommand('kubectl', 'KUBECTL_PATH'),
        [...ctxArgs, '--namespace', namespace, 'rollout', 'status', `deployment/${name}`, '--timeout=60s'],
        { timeout: 70_000, env: { ...process.env, HOME: process.env.HOME || require('node:os').homedir() } }
    ).catch((err) => { throw new Error(err.stderr || err.message); });
    return stdout;
}

module.exports = { fetchDeployments, fetchContexts, fetchNamespaces, rolloutUndo, rolloutStatus };
