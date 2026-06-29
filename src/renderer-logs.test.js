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
    const el = {
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
        querySelector(sel) {
            const cls = sel.replace('.', '');
            return this.children.find((c) => c.className && c.className.split(' ').includes(cls)) || null;
        },
    };
    return el;
}

function makeClassListWithInitial(...names) {
    const classes = new Set(names);
    return {
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
            if (force) { classes.add(name); }
            else { classes.delete(name); }
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
    logsNetInput: { value: '', addEventListener: () => {}, classList: makeClassListWithInitial() },
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
    logsCatchError: { textContent: '', classList: makeClassListWithInitial('hidden') },
    logsCatchTextBtn: { dataset: { mode: 'text' }, classList: makeClassListWithInitial('is-active') },
    logsCatchRegexBtn: { dataset: { mode: 'regex' }, classList: makeClassListWithInitial() },
};

global.document = {
    createElement: makeElement,
    getElementById: (id) => elements[id] || null,
    querySelector(sel) {
        if (sel === '#logsCatchMode .logs-catch-mode-btn.is-active') {
            return elements.logsCatchTextBtn.classList.contains('is-active') ? elements.logsCatchTextBtn : elements.logsCatchRegexBtn;
        }
        return null;
    },
    querySelectorAll(sel) {
        if (sel === '#logsCatchMode .logs-catch-mode-btn') {
            return [elements.logsCatchTextBtn, elements.logsCatchRegexBtn];
        }
        return [];
    },
    addEventListener: () => {},
    removeEventListener: () => {},
};

const { appendLogLine, formatLogContent, generateRegexFromSelection, buildCatchExtractor, buildCatchMatcher } = require('./renderer-logs');

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

// ── formatLogContent ──────────────────────────────────────────────────────────
console.log('\nformatLogContent');

const jsonLine = '2026-06-25T12:00:00.000Z {"message":"postal code not found","level":"WARN","timestamp":"2026-06-25T12:00:00Z"}';
const accessLine = '2026-06-25T12:00:00.000Z 192.168.1.1 - - [25/Jun/2026:12:00:00 +0000] "GET /api/status HTTP/1.1" 200 1234';
const plainLine = '2026-06-25T12:00:00.000Z No postal code found in cache for 87052 in SE';
const prefixedJsonLine = '[pod/svc-abc/svc] 2026-06-25T12:00:00.000Z {"message":"hello","level":"INFO"}';

test('raw format returns msg as-is', () => {
    const { msg, skip } = formatLogContent(plainLine, 'raw');
    assert.equal(msg, 'No postal code found in cache for 87052 in SE');
    assert.ok(!skip);
});

test('message format extracts message field from JSON', () => {
    const { msg, skip } = formatLogContent(jsonLine, 'message');
    assert.equal(msg, 'postal code not found');
    assert.ok(!skip);
});

test('message format falls back to raw msg when message field is empty', () => {
    const line = '2026-06-25T12:00:00.000Z {"level":"WARN"}';
    const { msg } = formatLogContent(line, 'message');
    assert.ok(msg.includes('{'));
});

test('message format skips non-JSON lines', () => {
    const { skip } = formatLogContent(plainLine, 'message');
    assert.equal(skip, true);
});

test('app format returns raw JSON string', () => {
    const { msg, skip } = formatLogContent(jsonLine, 'app');
    assert.ok(msg.startsWith('{'));
    assert.ok(!skip);
});

test('app format skips non-JSON lines', () => {
    const { skip } = formatLogContent(plainLine, 'app');
    assert.equal(skip, true);
});

test('access format shows non-JSON lines', () => {
    const { msg, skip } = formatLogContent(plainLine, 'access');
    assert.equal(msg, 'No postal code found in cache for 87052 in SE');
    assert.ok(!skip);
});

test('access format skips valid JSON lines', () => {
    const { skip } = formatLogContent(jsonLine, 'access');
    assert.equal(skip, true);
});

test('access format shows lines with invalid JSON (containing {)', () => {
    const partialJsonLine = '2026-06-25T12:00:00.000Z Error processing {bad json here';
    const { skip } = formatLogContent(partialJsonLine, 'access');
    assert.ok(!skip);
});

test('message format works on selector-prefixed lines', () => {
    const { msg, skip } = formatLogContent(prefixedJsonLine, 'message');
    assert.equal(msg, 'hello');
    assert.ok(!skip);
});

test('app format works on selector-prefixed lines', () => {
    const { msg, skip } = formatLogContent(prefixedJsonLine, 'app');
    assert.ok(msg.startsWith('{'));
    assert.ok(!skip);
});

// ── generateRegexFromSelection ────────────────────────────────────────────────
console.log('\ngenerateRegexFromSelection');

test('generalizes integers', () => {
    assert.equal(generateRegexFromSelection('customerId=123456'), 'customerId=\\d+');
});

test('escapes regex punctuation while generalizing ids', () => {
    assert.equal(generateRegexFromSelection('GET /api/orders/98765 HTTP/1.1'), 'GET\\s+/api/orders/\\d+\\s+HTTP/\\d+\\.\\d+');
});

test('generalizes pod-like generated suffixes', () => {
    assert.equal(generateRegexFromSelection('window-shopper-86d87db7c9-bxq7f'), 'window-shopper-[a-f0-9]+-[a-z0-9]+');
});

test('returns empty string for blank selection', () => {
    assert.equal(generateRegexFromSelection('   '), '');
});

// ── buildCatchMatcher ─────────────────────────────────────────────────────────
console.log('\nbuildCatchMatcher');

function setCatchMode(mode) {
    elements.logsCatchTextBtn.classList.toggle('is-active', mode === 'text');
    elements.logsCatchRegexBtn.classList.toggle('is-active', mode === 'regex');
}

test('text catch mode matches case-insensitive substrings', () => {
    setCatchMode('text');
    elements.logsNetInput.value = 'error';
    const matcher = buildCatchMatcher();
    assert.equal(matcher('Request ERROR happened'), true);
    assert.equal(matcher('Request ok'), false);
});

test('regex catch mode matches regular expressions', () => {
    setCatchMode('regex');
    elements.logsNetInput.value = 'customerId=\\d+';
    const matcher = buildCatchMatcher();
    assert.equal(matcher('customerId=12345'), true);
    assert.equal(matcher('customerId=abc'), false);
});

test('regex catch mode returns full match even with capture groups', () => {
    setCatchMode('regex');
    elements.logsNetInput.value = 'customerId=(\\d+)';
    const extractor = buildCatchExtractor();
    assert.deepEqual(extractor('customerId=12345 customerId=67890'), ['customerId=12345', 'customerId=67890']);
});

test('regex catch mode extracts whole matches when there are no capture groups', () => {
    setCatchMode('regex');
    elements.logsNetInput.value = 'customerId=\\d+';
    const extractor = buildCatchExtractor();
    assert.deepEqual(extractor('customerId=12345 customerId=67890'), ['customerId=12345', 'customerId=67890']);
});

test('invalid regex returns no matcher and shows an error', () => {
    setCatchMode('regex');
    elements.logsNetInput.value = '[';
    const matcher = buildCatchMatcher();
    assert.equal(matcher, null);
    assert.equal(elements.logsNetInput.classList.contains('is-invalid'), true);
    assert.notEqual(elements.logsCatchError.textContent, '');
});
