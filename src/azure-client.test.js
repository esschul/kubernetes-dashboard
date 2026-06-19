const assert = require('node:assert/strict');
const { extractLogErrors } = require('./azure-client');

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

console.log('extractLogErrors');

test('matches [ERROR] lines', () => {
    const lines = ['2026-06-17T06:30:41Z [ERROR] something went wrong', 'normal line'];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('[ERROR] something went wrong'));
});

test('matches ##[error] lines', () => {
    const lines = ['##[error]Code analysis failed. Gradle exit code: -1.'];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes('Code analysis failed'));
});

test('matches npm error lines with timestamp prefix', () => {
    const lines = [
        '2026-06-17T06:30:41.392Z npm error code ERESOLVE',
        '2026-06-17T06:30:41.392Z npm error ERESOLVE could not resolve',
        '2026-06-17T06:30:41.392Z npm warn overriding peer dependency',
    ];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 2, 'should match npm error but not npm warn');
    assert.ok(result[0].includes('npm error code ERESOLVE'));
    assert.ok(result[1].includes('npm error ERESOLVE could not resolve'));
});

test('matches npm error lines without timestamp', () => {
    const lines = ['npm error code ERESOLVE', 'npm warn something'];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 1);
    assert.ok(result[0].startsWith('npm error'));
});

test('matches FAILURE: and BUILD FAILED', () => {
    const lines = [
        'FAILURE: Build failed with an exception.',
        'BUILD FAILED in 1m 25s',
        'some normal line',
    ];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 2);
});

test('matches * What went wrong: lines', () => {
    const lines = ['* What went wrong:', '  Execution failed for task'];
    const result = extractLogErrors(lines);
    assert.ok(result.some((l) => l.includes('What went wrong')));
});

test('matches > indented gradle detail lines', () => {
    const lines = ['> Process \'command npm\' finished with non-zero exit value 1'];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 1);
});

test('strips timestamp prefix from output', () => {
    const lines = ['2026-06-17T06:30:41.392Z npm error code ERESOLVE'];
    const result = extractLogErrors(lines);
    assert.ok(!result[0].startsWith('2026'), 'timestamp should be stripped');
    assert.ok(result[0].startsWith('npm error'));
});

test('excludes npm warn lines', () => {
    const lines = [
        'npm warn ERESOLVE overriding peer dependency',
        'npm warn While resolving: something',
    ];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 0);
});

test('filters empty lines after stripping', () => {
    const lines = ['', '   ', '2026-06-17T06:30:41Z '];
    const result = extractLogErrors(lines);
    assert.equal(result.length, 0);
});

test('real gradle npm error log sample', () => {
    const lines = [
        '> Task :processResources',
        '> Task :prepareFrontendStuff FAILED',
        'npm warn ERESOLVE overriding peer dependency',
        'npm error code ERESOLVE',
        'npm error ERESOLVE could not resolve',
        'npm error',
        'npm error While resolving: @babel/plugin-proposal-class-properties@7.18.6',
        'FAILURE: Build failed with an exception.',
        '* What went wrong:',
        '> Process \'command \'npm\'\' finished with non-zero exit value 1',
        '##[error]Code analysis failed. Gradle exit code: -1.',
    ];
    const result = extractLogErrors(lines);
    assert.ok(result.some((l) => l.includes('npm error code ERESOLVE')), 'npm error code');
    assert.ok(result.some((l) => l.includes('FAILURE:')), 'FAILURE line');
    assert.ok(result.some((l) => l.includes('What went wrong')), 'What went wrong');
    assert.ok(result.some((l) => l.includes('Code analysis failed')), '##[error] line');
    assert.ok(!result.some((l) => l.includes('npm warn')), 'no npm warn lines');
});

test('catches bare Error: and ERROR in lines (webpack/babel style)', () => {
    const lines = [
        '2024-01-01T00:00:00.000Z ERROR in ./app/main.tsx',
        '2024-01-01T00:00:00.000Z Error: [BABEL] /home/vsts/work/1/s/frontend/src/app/main.tsx: Invalid Option: The version passed to `corejs` is invalid.',
        '2024-01-01T00:00:00.000Z   at normalizeCoreJSOption (node_modules/@babel/preset-env/lib/index.js:8956:15)',
        '2024-01-01T00:00:00.000Z webpack compiled with 1 error',
    ];
    const result = extractLogErrors(lines);
    assert.ok(result.some((l) => l.includes('ERROR in ./app/main.tsx')), 'ERROR in line');
    assert.ok(result.some((l) => l.includes('Error: [BABEL]')), 'bare Error: line');
    assert.ok(!result.some((l) => l.includes('at normalizeCoreJSOption')), 'no stack frames');
});

test('catches Jest test failures', () => {
    const lines = [
        '2024-01-01T00:00:00.000Z FAIL src/app/components/webshops/test/CreateWebshop.test.tsx',
        '2024-01-01T00:00:00.000Z   ● Test suite failed to run',
        '2024-01-01T00:00:00.000Z     Cannot find module \'../CreateWebshop\' from \'CreateWebshop.test.tsx\'',
        '2024-01-01T00:00:00.000Z PASS src/app/components/other/test/Other.test.tsx',
    ];
    const result = extractLogErrors(lines);
    assert.ok(result.some((l) => l.includes('FAIL src/app/components')), 'FAIL line');
    assert.ok(result.some((l) => l.includes('● Test suite failed to run')), 'bullet error');
    assert.ok(!result.some((l) => l.includes('PASS ')), 'no passing tests');
});
