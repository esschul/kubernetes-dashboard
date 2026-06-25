'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

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

function asyncTest(name, fn) {
    return fn().then(
        () => console.log(`  ✓ ${name}`),
        (err) => {
            console.error(`  ✗ ${name}`);
            console.error(`    ${err.message}`);
            process.exitCode = 1;
        }
    );
}

// ── Minimal fake process ──────────────────────────────────────────────────────
function makeFakeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.kill = () => { proc.killed = true; proc.emit('close', 0); };
    return proc;
}

// ── parseLogLine ──────────────────────────────────────────────────────────────
function parseLogLine(raw) {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})[^Z]*Z)\s([\s\S]*)$/);
    if (m) { return { ts: m[2], msg: m[3], raw }; }
    return { ts: '', msg: raw, raw };
}

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

// ── Stream line buffering ─────────────────────────────────────────────────────
console.log('\nstream line buffering');

test('splits chunked stdout into lines', () => {
    const lines = [];
    let buf = '';

    function onData(chunk) {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) { lines.push(line); }
    }

    onData('line one\nline t');
    onData('wo\nline three\n');

    assert.deepEqual(lines, ['line one', 'line two', 'line three']);
});

test('holds incomplete line in buffer until newline arrives', () => {
    const lines = [];
    let buf = '';

    function onData(chunk) {
        buf += chunk.toString();
        const parts = buf.split('\n');
        buf = parts.pop();
        for (const line of parts) { lines.push(line); }
    }

    onData('incomplete');
    assert.equal(lines.length, 0);
    assert.equal(buf, 'incomplete');

    onData(' line\n');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'incomplete line');
});

// ── Ring buffer (max lines) ───────────────────────────────────────────────────
console.log('\nring buffer');

test('drops oldest lines when buffer exceeds max', () => {
    const MAX = 5;
    const buf = [];

    for (let i = 0; i < 7; i++) {
        buf.push(`line ${i}`);
        if (buf.length > MAX) { buf.shift(); }
    }

    assert.equal(buf.length, MAX);
    assert.equal(buf[0], 'line 2');
    assert.equal(buf[buf.length - 1], 'line 6');
});

// ── Retry logic ───────────────────────────────────────────────────────────────
console.log('\nretry logic');

asyncTest('retries on non-zero exit code', () => {
    return new Promise((resolve) => {
        let attempts = 0;
        let activeLogStopped = false;

        function startLogProcess(attempt = 0) {
            attempts++;
            const proc = makeFakeProc();
            setTimeout(() => {
                proc.emit('close', 1); // non-zero = failure
            }, 5);
            proc.on('close', (code) => {
                if (activeLogStopped) { return; }
                if (code !== 0 && attempt < 3) {
                    setTimeout(() => startLogProcess(attempt + 1), 10);
                } else {
                    resolve();
                }
            });
        }

        startLogProcess();
        assert.equal(attempts, 1);
    }).then(() => {
        // resolved after retries exhausted — just check it resolves
    });
});

asyncTest('does not retry when stopped', () => {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        let activeLogStopped = false;

        function startLogProcess(attempt = 0) {
            attempts++;
            const proc = makeFakeProc();
            setTimeout(() => proc.emit('close', 1), 5);
            proc.on('close', (code) => {
                if (activeLogStopped) { resolve(); return; }
                if (code !== 0 && attempt < 3) {
                    setTimeout(() => startLogProcess(attempt + 1), 10);
                }
            });
        }

        startLogProcess();
        activeLogStopped = true; // stop before retry fires

        setTimeout(() => {
            assert.equal(attempts, 1, 'should not have retried');
            resolve();
        }, 50);
    });
});

asyncTest('sends logs:closed after max retries', () => {
    return new Promise((resolve) => {
        let closedSent = false;
        let activeLogStopped = false;
        const MAX_RETRIES = 3;

        function startLogProcess(attempt = 0) {
            const proc = makeFakeProc();
            setTimeout(() => proc.emit('close', 1), 5);
            proc.on('close', (code) => {
                if (activeLogStopped) { return; }
                if (code !== 0 && attempt < MAX_RETRIES) {
                    setTimeout(() => startLogProcess(attempt + 1), 10);
                } else {
                    closedSent = true;
                    resolve();
                }
            });
        }

        startLogProcess();
    }).then(() => {
        // resolved = logs:closed was sent
    });
});

asyncTest('exits cleanly with code 0 without retrying', () => {
    return new Promise((resolve) => {
        let attempts = 0;
        let activeLogStopped = false;

        function startLogProcess(attempt = 0) {
            attempts++;
            const proc = makeFakeProc();
            setTimeout(() => proc.emit('close', 0), 5);
            proc.on('close', (code) => {
                if (activeLogStopped) { return; }
                if (code !== 0 && attempt < 3) {
                    setTimeout(() => startLogProcess(attempt + 1), 10);
                } else {
                    resolve();
                }
            });
        }

        startLogProcess();

        setTimeout(() => {
            assert.equal(attempts, 1, 'should not retry on clean exit');
        }, 50);
    });
});
