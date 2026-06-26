'use strict';

const assert = require('node:assert/strict');
const {
    escapeHtml,
    getStatusLabel,
    getImageTag,
    formatRelativeTime,
    getAgePillClass,
    formatDuration,
    isFailingStatus,
    getPipelineBranchType,
    getPipelineStatusClass,
    getPipelineStatusLabel,
    parseLogLine,
    logLineMatchesFilter,
} = require('./renderer-utils');

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
    }
}

// ── escapeHtml ────────────────────────────────────────────────────────────────
console.log('\nescapeHtml');

test('escapes & < > "', () => {
    assert.equal(escapeHtml('<b class="x">&</b>'), '&lt;b class=&quot;x&quot;&gt;&amp;&lt;/b&gt;');
});
test('returns empty string for falsy input', () => {
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
});
test('passes through plain text unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
});

// ── getStatusLabel ────────────────────────────────────────────────────────────
console.log('\ngetStatusLabel');

test('returns known label for crash-loop', () => {
    assert.equal(getStatusLabel('crash-loop'), 'CrashLoopBackOff');
});
test('returns known label for scaled-down', () => {
    assert.equal(getStatusLabel('scaled-down'), 'Scaled down');
});
test('returns status itself for unknown values', () => {
    assert.equal(getStatusLabel('unknown-status'), 'unknown-status');
});

// ── getImageTag ───────────────────────────────────────────────────────────────
console.log('\ngetImageTag');

test('returns null for missing image', () => {
    assert.equal(getImageTag(null), null);
    assert.equal(getImageTag(''), null);
});
test('truncates long hex hash to 8 chars', () => {
    assert.equal(getImageTag('registry/app:abcdef1234567890'), 'abcdef12');
});
test('returns plain tag unchanged', () => {
    assert.equal(getImageTag('registry/app:v1.2.3'), 'v1.2.3');
});
test('returns null for image with no colon', () => {
    assert.equal(getImageTag('registryapp'), null);
});

// ── formatRelativeTime ────────────────────────────────────────────────────────
console.log('\nformatRelativeTime');

test('returns "just now" for < 1 minute ago', () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    assert.equal(formatRelativeTime(ts), 'just now');
});
test('returns minutes ago for < 1 hour', () => {
    const ts = new Date(Date.now() - 15 * 60_000).toISOString();
    assert.equal(formatRelativeTime(ts), '15m ago');
});
test('returns hours ago for < 24 hours', () => {
    const ts = new Date(Date.now() - 3 * 3_600_000).toISOString();
    assert.equal(formatRelativeTime(ts), '3h ago');
});
test('returns days ago for >= 24 hours', () => {
    const ts = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    assert.equal(formatRelativeTime(ts), '2d ago');
});

// ── getAgePillClass ───────────────────────────────────────────────────────────
console.log('\ngetAgePillClass');

test('returns is-none for missing value', () => {
    assert.equal(getAgePillClass(null), 'age-pill is-none');
    assert.equal(getAgePillClass(''), 'age-pill is-none');
});
test('returns is-fresh for < 1 hour', () => {
    const ts = new Date(Date.now() - 30 * 60_000).toISOString();
    assert.equal(getAgePillClass(ts), 'age-pill is-fresh');
});
test('returns is-notice for 1-24 hours', () => {
    const ts = new Date(Date.now() - 12 * 3_600_000).toISOString();
    assert.equal(getAgePillClass(ts), 'age-pill is-notice');
});
test('returns is-warning for 24-72 hours', () => {
    const ts = new Date(Date.now() - 48 * 3_600_000).toISOString();
    assert.equal(getAgePillClass(ts), 'age-pill is-warning');
});
test('returns is-critical for > 72 hours', () => {
    const ts = new Date(Date.now() - 96 * 3_600_000).toISOString();
    assert.equal(getAgePillClass(ts), 'age-pill is-critical');
});

// ── formatDuration ────────────────────────────────────────────────────────────
console.log('\nformatDuration');

test('formats seconds only', () => {
    assert.equal(formatDuration(45_000), '45s');
});
test('formats minutes and seconds', () => {
    assert.equal(formatDuration(125_000), '2m 5s');
});
test('formats zero', () => {
    assert.equal(formatDuration(0), '0s');
});

// ── isFailingStatus ───────────────────────────────────────────────────────────
console.log('\nisFailingStatus');

test('returns true for failing statuses', () => {
    assert.equal(isFailingStatus('error'), true);
    assert.equal(isFailingStatus('crash-loop'), true);
    assert.equal(isFailingStatus('failed'), true);
    assert.equal(isFailingStatus('unavailable'), true);
});
test('returns false for non-failing statuses', () => {
    assert.equal(isFailingStatus('healthy'), false);
    assert.equal(isFailingStatus('progressing'), false);
    assert.equal(isFailingStatus('scaled-down'), false);
});

// ── getPipelineBranchType ─────────────────────────────────────────────────────
console.log('\ngetPipelineBranchType');

test('returns branch for PR branches', () => {
    assert.equal(getPipelineBranchType({ sourceBranch: 'PR #42' }), 'branch');
});
test('returns master for main branch', () => {
    assert.equal(getPipelineBranchType({ sourceBranch: 'main' }), 'master');
    assert.equal(getPipelineBranchType({ sourceBranch: 'master' }), 'master');
});
test('returns branch for feature branch with Batched CI trigger', () => {
    assert.equal(getPipelineBranchType({ sourceBranch: 'feature/foo', trigger: 'Batched CI' }), 'branch');
});
test('returns master for main branch with Batched CI trigger', () => {
    assert.equal(getPipelineBranchType({ sourceBranch: 'main', trigger: 'Batched CI' }), 'master');
});
test('returns branch for named feature branch', () => {
    assert.equal(getPipelineBranchType({ sourceBranch: 'feature/my-feature' }), 'branch');
});

// ── getPipelineStatusClass ────────────────────────────────────────────────────
console.log('\ngetPipelineStatusClass');

test('returns is-progressing for inProgress', () => {
    assert.equal(getPipelineStatusClass({ status: 'inProgress' }), 'is-progressing');
});
test('returns is-healthy for succeeded', () => {
    assert.equal(getPipelineStatusClass({ status: 'completed', result: 'succeeded' }), 'is-healthy');
});
test('returns is-failed for failed', () => {
    assert.equal(getPipelineStatusClass({ status: 'completed', result: 'failed' }), 'is-failed');
});
test('returns is-scaled-down for canceled', () => {
    assert.equal(getPipelineStatusClass({ status: 'completed', result: 'canceled' }), 'is-scaled-down');
});

// ── getPipelineStatusLabel ────────────────────────────────────────────────────
console.log('\ngetPipelineStatusLabel');

test('returns Running for inProgress', () => {
    assert.equal(getPipelineStatusLabel({ status: 'inProgress' }), 'Running');
});
test('returns Queued for notStarted', () => {
    assert.equal(getPipelineStatusLabel({ status: 'notStarted' }), 'Queued');
});
test('returns Succeeded for succeeded result', () => {
    assert.equal(getPipelineStatusLabel({ status: 'completed', result: 'succeeded' }), 'Succeeded');
});
test('returns Partial for partiallySucceeded', () => {
    assert.equal(getPipelineStatusLabel({ status: 'completed', result: 'partiallySucceeded' }), 'Partial');
});

// ── parseLogLine ──────────────────────────────────────────────────────────────
console.log('\nparseLogLine');

test('parses ISO timestamp and message', () => {
    const { ts, msg } = parseLogLine('2026-06-25T12:34:56.789012345Z hello world');
    assert.equal(ts, '12:34:56');
    assert.equal(msg, 'hello world');
});
test('returns empty ts for lines without timestamp', () => {
    const { ts, msg } = parseLogLine('plain log line');
    assert.equal(ts, '');
    assert.equal(msg, 'plain log line');
});
test('handles message with spaces and special chars', () => {
    const { ts, msg } = parseLogLine('2026-06-25T08:00:00.000000000Z GET /api/status 200 OK');
    assert.equal(ts, '08:00:00');
    assert.equal(msg, 'GET /api/status 200 OK');
});
test('parses timestamp and retains pod prefix from all-pods stream', () => {
    const { ts, msg } = parseLogLine('[my-pod-abc123] 2026-06-25T12:34:56.789012345Z request received');
    assert.equal(ts, '12:34:56');
    assert.equal(msg, '[my-pod-abc123] request received');
});
test('returns full raw line when prefixed line has no timestamp', () => {
    const { ts, msg } = parseLogLine('[my-pod-abc123] plain log line');
    assert.equal(ts, '');
    assert.equal(msg, '[my-pod-abc123] plain log line');
});

// ── logLineMatchesFilter ─────────────────────────────────────────────────────
console.log('\nlogLineMatchesFilter');

test('empty filter matches every log line', () => {
    assert.equal(logLineMatchesFilter('plain log line', ''), true);
    assert.equal(logLineMatchesFilter('plain log line', '   '), true);
});
test('matches log lines case-insensitively', () => {
    assert.equal(logLineMatchesFilter('GET /api/orders 500 ERROR', 'error'), true);
    assert.equal(logLineMatchesFilter('GET /api/orders 500 ERROR', 'orders'), true);
});
test('hides log lines that do not match the filter', () => {
    assert.equal(logLineMatchesFilter('GET /api/orders 200 OK', 'error'), false);
});
test('matches visible message text after timestamp parsing', () => {
    assert.equal(logLineMatchesFilter('2026-06-25T12:34:56.789012345Z payment failed', 'payment'), true);
});
test('matches all-pods prefix text after timestamp parsing', () => {
    assert.equal(logLineMatchesFilter('[my-pod-abc123] 2026-06-25T12:34:56.789012345Z request received', 'my-pod'), true);
    assert.equal(logLineMatchesFilter('[my-pod-abc123] 2026-06-25T12:34:56.789012345Z request received', 'request'), true);
});
