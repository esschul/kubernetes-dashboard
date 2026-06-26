'use strict';

const assert = require('node:assert/strict');
const { logLineMatchesFilter, parseLogLine } = require('./renderer-utils');

global.logLineMatchesFilter = logLineMatchesFilter;
global.parseLogLine = parseLogLine;

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

function makeClassList() {
    const classes = new Set();
    return {
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
            if (force) { classes.add(name); }
            else { classes.delete(name); }
        },
    };
}

function makeElement(tagName) {
    return {
        tagName,
        children: [],
        dataset: {},
        className: '',
        classList: makeClassList(),
        textContent: '',
        appendChild(child) {
            this.children.push(child);
            this.textContent += child.textContent || '';
        },
    };
}

function makeOutput() {
    return {
        children: [],
        scrollTop: 0,
        scrollHeight: 100,
        appendChild(child) { this.children.push(child); },
        removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    };
}

const elements = {
    logsLiveFilterInput: { value: '', addEventListener: () => {} },
    logsSearchInput: { value: '', addEventListener: () => {} },
    logsNetInput: { value: '', addEventListener: () => {} },
    logsNetOutput: { value: '', scrollTop: 0, scrollHeight: 0 },
    logsOutput: { addEventListener: () => {} },
    logsNetClear: { addEventListener: () => {} },
    logsNetDivider: { addEventListener: () => {} },
    logsCloseBtn: { addEventListener: () => {} },
    logsModal: { addEventListener: () => {} },
    logsCopyBtn: { addEventListener: () => {} },
    logsTabLive: { addEventListener: () => {} },
    logsTabSearch: { addEventListener: () => {} },
    logsSearchBtn: { addEventListener: () => {} },
};

global.document = {
    createElement: makeElement,
    getElementById: (id) => elements[id] || null,
    addEventListener: () => {},
    removeEventListener: () => {},
};

const { appendLogLine } = require('./renderer-logs');

console.log('\nrenderer live logs');

test('live log append does not hide non-matching rows', () => {
    const output = makeOutput();
    appendLogLine('2026-06-25T12:00:01.000Z payment failed', output, { countRate: false, applyLiveFilter: false });

    assert.equal(output.children.length, 1);
    assert.equal(output.children[0].classList.contains('log-line--hidden'), false);
});

test('live log append keeps raw line for copy/search buffers', () => {
    const output = makeOutput();
    appendLogLine('[api-pod] 2026-06-25T12:00:02.000Z request received', output, { countRate: false, applyLiveFilter: false });

    assert.equal(output.children[0].dataset.raw, '[api-pod] 2026-06-25T12:00:02.000Z request received');
});

test('live log append applies the live filter when streaming', () => {
    const output = makeOutput();
    elements.logsLiveFilterInput.value = 'error';
    appendLogLine('2026-06-25T12:00:03.000Z request ok', output, { countRate: false, applyLiveFilter: true });
    appendLogLine('2026-06-25T12:00:04.000Z request error', output, { countRate: false, applyLiveFilter: true });

    assert.equal(output.children[0].classList.contains('log-line--hidden'), true);
    assert.equal(output.children[1].classList.contains('log-line--hidden'), false);
    elements.logsLiveFilterInput.value = '';
});
