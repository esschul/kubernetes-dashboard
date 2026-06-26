'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { getLogLineTimestamp } = require('./kubectl-client');

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

function fixture(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', name), 'utf8');
}

// ── Functions under test (extracted from kubectl-client.js) ───────────────────

function parseContexts(stdout) {
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

function parseNamespaces(stdout) {
    return stdout.split(/\s+/).map((s) => s.trim()).filter(Boolean).sort();
}

// ── parseContexts ─────────────────────────────────────────────────────────────
console.log('\nparseContexts');

test('parses all three contexts from fixture', () => {
    const result = parseContexts(fixture('kubectl-get-contexts.txt'));
    assert.equal(result.length, 3);
});

test('identifies current context via * prefix', () => {
    const result = parseContexts(fixture('kubectl-get-contexts.txt'));
    const current = result.filter((c) => c.isCurrent);
    assert.equal(current.length, 1);
    assert.equal(current[0].name, 'qa-cluster');
});

test('non-current contexts have isCurrent=false', () => {
    const result = parseContexts(fixture('kubectl-get-contexts.txt'));
    const nonCurrent = result.filter((c) => !c.isCurrent);
    assert.equal(nonCurrent.length, 2);
    assert.ok(nonCurrent.every((c) => c.isCurrent === false));
});

test('extracts name and cluster for each context', () => {
    const result = parseContexts(fixture('kubectl-get-contexts.txt'));
    const prod = result.find((c) => c.name === 'prod-cluster');
    assert.ok(prod);
    assert.equal(prod.cluster, 'prod-cluster');
    assert.equal(prod.isCurrent, false);
});

test('handles empty output', () => {
    const result = parseContexts('');
    assert.deepEqual(result, []);
});

test('ignores blank lines', () => {
    const result = parseContexts('\n\n  \n');
    assert.deepEqual(result, []);
});

test('single context without star is not current', () => {
    const result = parseContexts('  my-cluster   user@host   my-cluster   default');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'my-cluster');
    assert.equal(result[0].isCurrent, false);
});

test('single context with star is current', () => {
    const result = parseContexts('* my-cluster   user@host   my-cluster   default');
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'my-cluster');
    assert.equal(result[0].isCurrent, true);
});

// ── parseNamespaces ───────────────────────────────────────────────────────────
console.log('\nparseNamespaces');

test('parses space-separated namespaces', () => {
    const result = parseNamespaces(fixture('kubectl-get-namespaces.txt'));
    assert.ok(result.includes('default'));
    assert.ok(result.includes('kube-system'));
    assert.ok(result.includes('production'));
    assert.equal(result.length, 6);
});

test('returns sorted list', () => {
    const result = parseNamespaces(fixture('kubectl-get-namespaces.txt'));
    assert.deepEqual(result, [...result].sort());
});

test('handles single namespace', () => {
    const result = parseNamespaces('default');
    assert.deepEqual(result, ['default']);
});

test('handles newline-separated output', () => {
    const result = parseNamespaces('default\nkube-system\nmonitoring');
    assert.equal(result.length, 3);
    assert.ok(result.includes('kube-system'));
});

test('filters empty strings', () => {
    const result = parseNamespaces('  default  kube-system  ');
    assert.equal(result.length, 2);
});

// ── getLogLineTimestamp ──────────────────────────────────────────────────────
console.log('\ngetLogLineTimestamp');

test('extracts timestamp from normal kubectl log line', () => {
    const ts = getLogLineTimestamp('2026-06-25T12:00:01.000Z request ok');
    assert.equal(ts, new Date('2026-06-25T12:00:01.000Z').getTime());
});

test('extracts timestamp from all-pods prefixed log line', () => {
    const ts = getLogLineTimestamp('[api-pod] 2026-06-25T12:00:02.000Z request ok');
    assert.equal(ts, new Date('2026-06-25T12:00:02.000Z').getTime());
});

test('returns null when log line has no timestamp', () => {
    assert.equal(getLogLineTimestamp('plain log line'), null);
});
