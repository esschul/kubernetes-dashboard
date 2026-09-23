'use strict';

const assert = require('node:assert/strict');

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

// Inlined from renderer.js renderDeploymentTab
function resolveDisplayTag(dep) {
    const latestRollout = dep.rollouts?.[0];
    const actualImageTag = dep.image?.includes(':') ? dep.image.split(':').pop() : null;
    const annotationTag = latestRollout?.imageTag || null;
    const displayTag = actualImageTag || annotationTag;
    const displayBranch = (annotationTag && actualImageTag && annotationTag !== actualImageTag)
        ? null
        : latestRollout?.branch;
    return { displayTag, displayBranch };
}

// ── renderDeploymentTab image tag / branch resolution ────────────────────────

test('normal deploy: shows annotation tag and branch', () => {
    const dep = {
        image: 'registry.io/my-app:abc123def456',
        rollouts: [{ imageTag: 'abc123def456', branch: 'main', deployedBy: 'alice' }],
    };
    const { displayTag, displayBranch } = resolveDisplayTag(dep);
    assert.equal(displayTag, 'abc123def456');
    assert.equal(displayBranch, 'main');
});

test('after kubectl set image: actual tag replaces stale annotation tag', () => {
    const dep = {
        image: 'registry.io/my-app:newsha9876543210',
        rollouts: [{ imageTag: 'local-build-add-chat_3pGhPSpS', branch: 'add-chat_3pGhPSpS', deployedBy: 'esschul' }],
    };
    const { displayTag, displayBranch } = resolveDisplayTag(dep);
    assert.equal(displayTag, 'newsha9876543210', 'should show actual image tag, not stale annotation');
    assert.equal(displayBranch, null, 'stale branch should be hidden when annotation and image mismatch');
});

test('local build where annotation and image match: shows tag and branch', () => {
    const sha = 'local-build-my-feature';
    const dep = {
        image: `registry.io/my-app:${sha}`,
        rollouts: [{ imageTag: sha, branch: 'my-feature', deployedBy: 'esschul' }],
    };
    const { displayTag, displayBranch } = resolveDisplayTag(dep);
    assert.equal(displayTag, sha);
    assert.equal(displayBranch, 'my-feature');
});

test('no rollout annotation: falls back to actual image tag', () => {
    const dep = {
        image: 'registry.io/my-app:sha-only-no-annotation',
        rollouts: [],
    };
    const { displayTag, displayBranch } = resolveDisplayTag(dep);
    assert.equal(displayTag, 'sha-only-no-annotation');
    assert.equal(displayBranch, undefined);
});

test('no image at all: tag is null', () => {
    const dep = { image: null, rollouts: [] };
    const { displayTag } = resolveDisplayTag(dep);
    assert.equal(displayTag, null);
});
