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

// ── Functions under test (extracted from github-client.js) ───────────────────

function cleanTrailingUrlPunctuation(url) {
    return url.replace(/[),.;:!?]+$/g, '');
}

function extractTrelloUrl(body) {
    const match = body?.match(/https?:\/\/trello\.com\/[^\s<>"']+/);
    return match ? cleanTrailingUrlPunctuation(match[0]) : null;
}

function normalizePrResult(pr, trelloUrl) {
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

// ── cleanTrailingUrlPunctuation ───────────────────────────────────────────────
console.log('\ncleanTrailingUrlPunctuation');

test('strips trailing period', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123.'), 'https://trello.com/c/abc123');
});

test('strips trailing parenthesis', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123)'), 'https://trello.com/c/abc123');
});

test('strips multiple trailing punctuation chars', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123).'), 'https://trello.com/c/abc123');
});

test('strips trailing comma', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123,'), 'https://trello.com/c/abc123');
});

test('strips trailing semicolon', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123;'), 'https://trello.com/c/abc123');
});

test('leaves clean URL unchanged', () => {
    assert.equal(cleanTrailingUrlPunctuation('https://trello.com/c/abc123'), 'https://trello.com/c/abc123');
});

test('does not strip punctuation mid-URL', () => {
    assert.equal(
        cleanTrailingUrlPunctuation('https://trello.com/c/abc-123/my-card'),
        'https://trello.com/c/abc-123/my-card'
    );
});

// ── extractTrelloUrl ──────────────────────────────────────────────────────────
console.log('\nextractTrelloUrl from PR comment body');

test('extracts trello URL from plain comment', () => {
    const body = 'See the card: https://trello.com/c/abc123/my-card';
    assert.equal(extractTrelloUrl(body), 'https://trello.com/c/abc123/my-card');
});

test('extracts and cleans trailing punctuation', () => {
    const body = 'Trello: https://trello.com/c/abc123).';
    assert.equal(extractTrelloUrl(body), 'https://trello.com/c/abc123');
});

test('returns null when no trello URL present', () => {
    const body = 'No trello link here, just text.';
    assert.equal(extractTrelloUrl(body), null);
});

test('returns null for empty body', () => {
    assert.equal(extractTrelloUrl(''), null);
});

test('returns null for null body', () => {
    assert.equal(extractTrelloUrl(null), null);
});

test('does not match non-trello URLs', () => {
    const body = 'See https://github.com/org/repo/pull/1 for details';
    assert.equal(extractTrelloUrl(body), null);
});

test('picks first trello URL when multiple present', () => {
    const body = 'https://trello.com/c/first and https://trello.com/c/second';
    assert.equal(extractTrelloUrl(body), 'https://trello.com/c/first');
});

// ── normalizePrResult ─────────────────────────────────────────────────────────
console.log('\nnormalizePrResult');

test('maps GitHub REST API fields to internal shape', () => {
    const pr = {
        number: 42,
        title: 'Fix the thing',
        user: { login: 'espen' },
        html_url: 'https://github.com/acme/my-service/pull/42',
        merged_at: '2026-06-25T10:00:00Z',
        state: 'closed',
    };
    const result = normalizePrResult(pr, 'https://trello.com/c/abc');
    assert.equal(result.number, 42);
    assert.equal(result.title, 'Fix the thing');
    assert.equal(result.author, 'espen');
    assert.equal(result.url, 'https://github.com/acme/my-service/pull/42');
    assert.equal(result.mergedAt, '2026-06-25T10:00:00Z');
    assert.equal(result.state, 'closed');
    assert.equal(result.trelloUrl, 'https://trello.com/c/abc');
});

test('handles missing user gracefully', () => {
    const pr = { number: 1, title: 'Bot PR', user: null, html_url: '', merged_at: null, state: 'open' };
    const result = normalizePrResult(pr, null);
    assert.equal(result.author, undefined);
    assert.equal(result.trelloUrl, null);
});
