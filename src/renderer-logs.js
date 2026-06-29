'use strict';
/* exported openLogsModal, closeLogsModal */

// Log modal state
const LOG_MAX_LINES = 500;
const LOG_SEARCH_MAX_LINES = 5000;
const LOG_RATE_WINDOW_MS = 10_000;
const LOG_RATE_GAUGE_MAX = 100;
let logBuffer = [];
let caughtBuffer = [];
let logAutoScroll = true;
let logLineTimestamps = [];
let logPeakRate = 0;
let logRateTimer = null;
let pendingRegexSelection = '';
let logStreamPaused = false;

function escapeRegexLiteral(text) {
    return String(text).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function consumeRegexPattern(text, index) {
    const rest = text.slice(index);
    const patterns = [
        [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/, '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?'],
        [/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i, '[a-f0-9-]{36}'],
        [/^\s+/, '\\s+'],
        [/^[a-f0-9]{7,}\b/i, '[a-f0-9]+'],
        [/^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]+\b/i, '[a-z0-9]+'],
        [/^\d+/, '\\d+'],
    ];
    for (const [rx, replacement] of patterns) {
        const match = rest.match(rx);
        if (match) { return { pattern: replacement, length: match[0].length }; }
    }
    return { pattern: escapeRegexLiteral(text[index]), length: 1 };
}

function generateRegexFromSelection(text) {
    const selected = String(text || '').trim();
    if (!selected) { return ''; }
    let regex = '';
    for (let index = 0; index < selected.length;) {
        const token = consumeRegexPattern(selected, index);
        regex += token.pattern;
        index += token.length;
    }
    return regex;
}

function getActiveHighlightInput() {
    const isLive = document.getElementById('logsTabLive')?.classList?.contains('is-active');
    return document.getElementById(isLive ? 'logsLiveHighlightInput' : 'logsHighlightInput');
}

function getActiveHighlightError() {
    const isLive = document.getElementById('logsTabLive')?.classList?.contains('is-active');
    return document.getElementById(isLive ? 'logsLiveHighlightError' : 'logsHighlightError');
}

function setHighlightError(message = '') {
    const input = getActiveHighlightInput();
    const error = getActiveHighlightError();
    input?.classList.toggle('is-invalid', Boolean(message));
    if (!error) { return; }
    error.textContent = message;
    error.classList.toggle('hidden', !message);
}

function buildHighlightRegex() {
    const pattern = getHighlightPattern();
    if (!pattern) {
        setHighlightError('');
        return null;
    }
    try {
        const rx = new RegExp(pattern, 'gi');
        setHighlightError('');
        return rx;
    } catch (err) {
        setHighlightError(err.message || 'Invalid regex');
        return null;
    }
}

function getNetFilter() {
    return document.getElementById('logsNetInput')?.value.trim() || '';
}

function getCatchMode() {
    return document.querySelector('#logsCatchMode .logs-catch-mode-btn.is-active')?.dataset.mode || 'text';
}

function setCatchError(message = '') {
    const input = document.getElementById('logsNetInput');
    const error = document.getElementById('logsCatchError');
    input?.classList.toggle('is-invalid', Boolean(message));
    if (!error) { return; }
    error.textContent = message;
    error.classList.toggle('hidden', !message);
}

function buildCatchExtractor() {
    const filter = getNetFilter();
    if (!filter) {
        setCatchError('');
        return null;
    }
    if (getCatchMode() === 'regex') {
        try {
            const rx = new RegExp(filter, 'gi');
            setCatchError('');
            return (text) => {
                const values = [];
                rx.lastIndex = 0;
                let match;
                while ((match = rx.exec(text)) !== null) {
                    values.push(match[0]);
                    if (match[0].length === 0) { rx.lastIndex++; }
                }
                return values;
            };
        } catch (err) {
            setCatchError(err.message || 'Invalid regex');
            return null;
        }
    }
    setCatchError('');
    const needle = filter.toLowerCase();
    return (text) => (text.toLowerCase().includes(needle) ? [text.trim()] : []);
}

function buildCatchMatcher() {
    const extractor = buildCatchExtractor();
    return extractor ? (text) => extractor(text).length > 0 : null;
}

function getLiveFilter() {
    return document.getElementById('logsLiveFilterInput')?.value.trim() || '';
}

function renderCaughtLogLines() {
    const netOutput = document.getElementById('logsNetOutput');
    if (!netOutput) { return; }
    if (!getNetFilter()) {
        setCatchError('');
        netOutput.value = '';
        return;
    }
    netOutput.value = caughtBuffer.join('\n');
    netOutput.scrollTop = netOutput.scrollHeight;
}

function refreshLiveLogLines() {
    document.querySelectorAll('#logsOutput .log-line').forEach((el) => {
        el.classList.toggle('log-line--hidden', !logLineMatchesFilter(el.dataset.raw, getLiveFilter()));
    });
    renderCaughtLogLines();
}

function getHighlightPattern() {
    return getActiveHighlightInput()?.value.trim() || '';
}

function pruneLogRateTimestamps(now = Date.now()) {
    logLineTimestamps = logLineTimestamps.filter((ts) => now - ts <= LOG_RATE_WINDOW_MS);
}

function getCurrentLogRate(now = Date.now()) {
    pruneLogRateTimestamps(now);
    return logLineTimestamps.length / (LOG_RATE_WINDOW_MS / 1000);
}

function updateLogRateGauge() {
    const rate = getCurrentLogRate();
    logPeakRate = Math.max(logPeakRate, rate);

    const value = document.getElementById('logsRateValue');
    const peak = document.getElementById('logsRatePeak');
    const needle = document.getElementById('logsRateNeedle');
    if (value) { value.textContent = rate.toFixed(1); }
    if (peak) { peak.textContent = logPeakRate.toFixed(1); }
    if (needle) {
        const pct = Math.min(rate / LOG_RATE_GAUGE_MAX, 1);
        const angle = -90 + (pct * 180);
        needle.style.transform = `translateX(-50%) rotate(${angle}deg)`;
    }
}

function resetLogRateGauge() {
    logLineTimestamps = [];
    logPeakRate = 0;
    updateLogRateGauge();
}

function startLogRateTimer() {
    stopLogRateTimer();
    logRateTimer = setInterval(updateLogRateGauge, 500);
}

function updatePauseButton() {
    const btn = document.getElementById('logsPauseBtn');
    if (!btn) { return; }
    btn.textContent = logStreamPaused ? 'Resume' : 'Pause';
    btn.classList.toggle('is-active', logStreamPaused);
}

function stopLogRateTimer() {
    if (logRateTimer) {
        clearInterval(logRateTimer);
        logRateTimer = null;
    }
}

function getLogFormat() {
    const isLive = document.getElementById('logsTabLive')?.classList?.contains('is-active');
    const inputId = isLive ? 'logsLiveFormatSelect' : 'logsFormatSelect';
    return document.getElementById(inputId)?.value || 'raw';
}

function formatLogContent(raw, format) {
    const { ts, msg } = parseLogLine(raw);

    if (format === 'message' || format === 'app') {
        const jsonStart = msg.indexOf('{');
        if (jsonStart !== -1) {
            try {
                const obj = JSON.parse(msg.slice(jsonStart));
                if (format === 'message') {
                    const message = obj.message || obj.msg || obj.Message || '';
                    const errObj = obj.err || obj.error || obj.exception || null;
                    const stack = obj.stackTrace || obj.stack_trace || obj.stack
                        || errObj?.stack || errObj?.stackTrace || errObj?.stack_trace
                        || null;
                    const errMsg = errObj?.message && errObj.message !== message ? errObj.message : null;
                    return { ts, msg: message || msg, stack: stack || null, errMsg, cls: '' };
                }
                return { ts, msg: msg.slice(jsonStart), cls: '' };
            } catch { /* fall through */ }
        }
        return { skip: true };
    }

    if (format === 'errors') {
        const jsonStart = msg.indexOf('{');
        if (jsonStart !== -1) {
            try {
                const obj = JSON.parse(msg.slice(jsonStart));
                const errObj = obj.err || obj.error || obj.exception || null;
                const stack = obj.stackTrace || obj.stack_trace || obj.stack
                    || errObj?.stack || errObj?.stackTrace || errObj?.stack_trace || null;
                if (!stack) { return { skip: true }; }
                const message = obj.message || obj.msg || obj.Message || '';
                const errMsg = errObj?.message && errObj.message !== message ? errObj.message : null;
                return { ts, msg: message || msg, stack, errMsg, cls: '' };
            } catch { /* fall through */ }
        }
        return { skip: true };
    }

    if (format === 'access') {
        const jsonStart = msg.indexOf('{');
        if (jsonStart !== -1) {
            try { JSON.parse(msg.slice(jsonStart)); return { skip: true }; } catch { /* not json */ }
        }
        return { ts, msg, cls: '' };
    }

    return { ts, msg, cls: '' };
}

function renderLogEl(raw, format) {
    const result = formatLogContent(raw, format);
    if (result.skip) {
        const el = document.createElement('div');
        el.className = 'log-line log-line--hidden';
        el.dataset.raw = raw;
        return el;
    }
    const { ts, msg, level, levelCls, extra, cls, stack, errMsg } = result;
    const el = document.createElement('div');
    el.className = `log-line${cls ? ` ${cls}` : ''}${stack ? ' log-line--has-stack' : ''}`;
    el.dataset.raw = raw;
    const tsEl = document.createElement('span');
    tsEl.className = 'log-ts';
    tsEl.textContent = ts;
    el.appendChild(tsEl);
    if (level) {
        const lvEl = document.createElement('span');
        lvEl.className = `log-level ${levelCls || ''}`;
        lvEl.textContent = level;
        el.appendChild(lvEl);
    }
    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg';
    msgEl.textContent = msg;
    el.appendChild(msgEl);
    if (extra) {
        const exEl = document.createElement('span');
        exEl.className = 'log-extra';
        exEl.textContent = extra;
        el.appendChild(exEl);
    }
    if (stack) {
        const details = document.createElement('details');
        details.className = 'log-stack';
        const summary = document.createElement('summary');
        summary.className = 'log-stack-summary';
        summary.textContent = errMsg ? `Error: ${errMsg}` : 'Stack trace';
        details.appendChild(summary);
        const pre = document.createElement('pre');
        pre.className = 'log-stack-body';
        pre.textContent = typeof stack === 'string' ? stack : JSON.stringify(stack, null, 2);
        details.appendChild(pre);
        const copyBtn = document.createElement('button');
        copyBtn.className = 'log-stack-copy-btn';
        copyBtn.textContent = 'Copy for AI';
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const { depName, deployMeta } = logsModalContext || {};
            const stackText = typeof stack === 'string' ? stack : JSON.stringify(stack, null, 2);
            const lines = [
                `Application: ${depName || 'unknown'}`,
                deployMeta?.branch ? `Branch: ${deployMeta.branch}` : null,
                deployMeta?.imageTag && deployMeta.imageTag !== deployMeta.gitSha ? `Version: ${deployMeta.imageTag}` : null,
                deployMeta?.gitSha ? `Commit: ${deployMeta.gitSha}` : null,
                `Time: ${ts}`,
                ``,
                `Error: ${msg}`,
                errMsg ? `Cause: ${errMsg}` : null,
                ``,
                `Stack trace:`,
                stackText,
            ].filter((l) => l !== null).join('\n');
            navigator.clipboard.writeText(lines).catch(() => {});
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy for AI'; }, 1500);
        });
        details.appendChild(copyBtn);
        el.appendChild(details);
    }
    return el;
}

function reRenderLogOutput() {
    const output = document.getElementById('logsOutput');
    if (!output) { return; }
    const format = getLogFormat();
    output.querySelectorAll('.log-line').forEach((el) => {
        const raw = el.dataset.raw;
        if (!raw) { return; }
        const result = formatLogContent(raw, format);
        const newEl = renderLogEl(raw, format);
        if (el.classList.contains('log-line--hidden') && !result.skip) {
            newEl.classList.add('log-line--hidden');
        }
        output.replaceChild(newEl, el);
    });
    caughtBuffer = [];
    applyHighlight();
}

function appendLogLine(raw, output, options = {}) {
    const { countRate = true, applyLiveFilter = countRate } = options;
    logBuffer.push(raw);
    if (logBuffer.length > LOG_MAX_LINES) { logBuffer.shift(); }
    if (countRate) {
        logLineTimestamps.push(Date.now());
        updateLogRateGauge();
    }

    const format = getLogFormat();
    const el = renderLogEl(raw, format);
    if (applyLiveFilter) {
        el.classList.toggle('log-line--hidden', !logLineMatchesFilter(raw, getLiveFilter()));
    }
    const highlightRx = buildHighlightRegex();
    if (highlightRx) {
        const msgEl = el.querySelector('.log-msg');
        if (msgEl) {
            const text = msgEl.textContent;
            msgEl.dataset.text = text;
            msgEl.innerHTML = '';
            let last = 0; let m;
            while ((m = highlightRx.exec(text)) !== null) {
                if (m.index > last) { msgEl.appendChild(document.createTextNode(text.slice(last, m.index))); }
                const mark = document.createElement('mark');
                mark.textContent = m[0];
                msgEl.appendChild(mark);
                last = highlightRx.lastIndex;
                if (m[0].length === 0) { highlightRx.lastIndex++; }
            }
            if (last < text.length) { msgEl.appendChild(document.createTextNode(text.slice(last))); }
        }
    }
    output.appendChild(el);
    const domLimit = countRate ? LOG_MAX_LINES : LOG_SEARCH_MAX_LINES;
    if (output.children.length > domLimit) { output.removeChild(output.firstChild); }
    if (logAutoScroll) { output.scrollTop = output.scrollHeight; }

    const catchExtractor = buildCatchExtractor();
    const msgText = el.querySelector('.log-msg')?.dataset.text || el.querySelector('.log-msg')?.textContent || '';
    if (applyLiveFilter && catchExtractor && !el.classList.contains('log-line--hidden')) {
        caughtBuffer.push(...catchExtractor(msgText));
        renderCaughtLogLines();
    }
}

function closeLogsModal() {
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    stopLogRateTimer();
    caughtBuffer = [];
    logStreamPaused = false;
    updatePauseButton();
    document.getElementById('logsModal').close();
}

let logsModalContext = null;

function applyHighlight() {
    const rx = buildHighlightRegex();
    document.querySelectorAll('#logsOutput .log-line .log-msg').forEach((el) => {
        const text = el.dataset.text || el.textContent;
        el.dataset.text = text;
        if (!rx) { el.textContent = text; return; }
        rx.lastIndex = 0;
        el.innerHTML = '';
        let last = 0;
        let m;
        while ((m = rx.exec(text)) !== null) {
            if (m.index > last) { el.appendChild(document.createTextNode(text.slice(last, m.index))); }
            const mark = document.createElement('mark');
            mark.textContent = m[0];
            el.appendChild(mark);
            last = rx.lastIndex;
            if (m[0].length === 0) { rx.lastIndex++; }
        }
        if (last < text.length) { el.appendChild(document.createTextNode(text.slice(last))); }
    });
}

function getLogsRegexMenu() {
    let menu = document.getElementById('logsRegexMenu');
    if (menu) { return menu; }
    const modal = document.getElementById('logsModal');
    menu = document.createElement('div');
    menu.id = 'logsRegexMenu';
    menu.className = 'logs-regex-menu hidden';
    menu.innerHTML = '<button type="button" id="logsGenerateRegexBtn">Generate regex</button>';
    (modal || document.body).appendChild(menu);
    menu.querySelector('button')?.addEventListener('click', () => {
        const regex = generateRegexFromSelection(pendingRegexSelection);
        const input = getActiveHighlightInput();
        if (regex && input) {
            input.value = regex;
            input.focus();
            input.select?.();
            applyHighlight();
        }
        hideLogsRegexMenu();
    });
    return menu;
}

function hideLogsRegexMenu() {
    document.getElementById('logsRegexMenu')?.classList.add('hidden');
    pendingRegexSelection = '';
}

function showLogsRegexMenu(event) {
    const output = document.getElementById('logsOutput');
    const selection = window.getSelection?.();
    const selected = selection?.toString().trim() || '';
    const targetIsInOutput = output && (event.target === output || output.contains(event.target));
    if (!selected || !targetIsInOutput) {
        hideLogsRegexMenu();
        return;
    }
    event.preventDefault();
    pendingRegexSelection = selected;
    const menu = getLogsRegexMenu();
    menu.classList.remove('hidden');
    const left = Math.min(event.clientX, window.innerWidth - 180);
    const top = Math.min(event.clientY, window.innerHeight - 44);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
}

function setLogsMode(mode) {
    const isLive = mode === 'live';
    const isSearch = mode === 'search';
    document.getElementById('logsTabLive').classList.toggle('is-active', isLive);
    document.getElementById('logsTabSearch').classList.toggle('is-active', isSearch);
    document.getElementById('logsLiveControls').classList.toggle('hidden', !isLive);
    document.getElementById('logsSearchControls').classList.toggle('hidden', !isSearch);
    document.getElementById('logsPauseBtn')?.classList.toggle('hidden', !isLive);
    applyHighlight();
    const net = document.getElementById('logsNet');
    const divider = document.getElementById('logsNetDivider');
    if (net) { net.classList.toggle('hidden', !isLive); }
    if (divider) { divider.classList.toggle('hidden', !isLive); }
}

function getLocalDatetimeValue(date = new Date()) {
    const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60_000));
    return local.toISOString().slice(0, 16);
}

function buildPodOptions(pods, selector) {
    const allPodsOption = pods.length > 1 && selector
        ? `<option value="__all__">All pods (${pods.length})</option>`
        : '';
    return pods.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('') + allPodsOption;
}

function startLogsLiveStream(context, namespace, selector, options = {}) {
    const { preserveOutput = false } = options;
    const select = document.getElementById('logsPodSelect');
    const output = document.getElementById('logsOutput');
    const isAll = select.value === '__all__';
    if (!preserveOutput) {
        logBuffer = [];
        caughtBuffer = [];
    }
    logStreamPaused = false;
    resetLogRateGauge();
    startLogRateTimer();
    if (output && !preserveOutput) { output.textContent = ''; }
    if (!preserveOutput) { document.getElementById('logsNetOutput').value = ''; }
    updatePauseButton();
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.startLogStream({
        context, namespace,
        podName: isAll ? null : select.value,
        selector: isAll ? selector : null,
    });
}

function pauseLogsLiveStream() {
    logStreamPaused = true;
    window.kubeDashboard.stopLogStream();
    stopLogRateTimer();
    updatePauseButton();
}

function resumeLogsLiveStream() {
    if (!logsModalContext) { return; }
    const { context, namespace, selector } = logsModalContext;
    startLogsLiveStream(context, namespace, selector, { preserveOutput: true });
}

function openLogsModal({ depName, pods, podObjects, context, namespace, selector, deployMeta = {}, initialMode = 'search' }) {
    logBuffer = [];
    caughtBuffer = [];
    logAutoScroll = true;
    stopLogRateTimer();
    resetLogRateGauge();
    logsModalContext = { depName, pods, podObjects, context, namespace, selector, deployMeta };

    const modal = document.getElementById('logsModal');
    const output = document.getElementById('logsOutput');
    const select = document.getElementById('logsPodSelect');
    const searchSelect = document.getElementById('logsSearchPodSelect');
    const title = document.getElementById('logsModalTitle');

    title.textContent = depName;
    const envLabel = getCurrentEnvLabel({ ...loadConfig(), context });
    const pill = document.getElementById('logsEnvPill');
    if (pill) {
        pill.textContent = envLabel ? envLabel.toUpperCase() : '';
        pill.className = `logs-env-pill${envLabel ? ` is-env-${envLabel}` : ''}`;
    }
    output.textContent = '';
    document.getElementById('logsGroupBtn')?.classList.add('hidden');
    document.getElementById('logsLiveFilterInput').value = '';
    document.getElementById('logsLiveHighlightInput').value = '';
    document.getElementById('logsSearchInput').value = '';
    document.getElementById('logsNetInput').value = '';
    document.getElementById('logsNetOutput').value = '';
    logStreamPaused = false;
    updatePauseButton();
    setHighlightError('');
    setCatchError('');
    document.querySelectorAll('#logsCatchMode .logs-catch-mode-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.mode === 'text');
    });

    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    setLogsMode(initialMode === 'live' ? 'live' : 'search');

    if (pods.length === 0) {
        select.innerHTML = '<option value="">No pods</option>';
        select.disabled = true;
        searchSelect.innerHTML = '<option value="">No pods</option>';
        searchSelect.disabled = true;
        appendLogLine('[no pods available for this deployment]', output, { countRate: false, applyLiveFilter: false });
        modal.showModal();
        return;
    }

    const podOptionHtml = buildPodOptions(pods, selector);
    select.disabled = false;
    select.innerHTML = podOptionHtml;
    searchSelect.disabled = false;
    searchSelect.innerHTML = podOptionHtml;
    if (selector && pods.length > 1) { searchSelect.value = '__all__'; }

    const fromInput = document.getElementById('logsSearchFrom');
    const toInput = document.getElementById('logsSearchTo');
    if (fromInput && podObjects && podObjects.length > 0) {
        const oldest = podObjects.map((p) => p.startTime).filter(Boolean).sort()[0];
        if (oldest) { fromInput.min = getLocalDatetimeValue(new Date(oldest)); }
    }
    if (fromInput) { fromInput.value = getLocalDatetimeValue(new Date(Date.now() - 30 * 60 * 1000)); }
    if (toInput) { toInput.value = getLocalDatetimeValue(); }

    window.kubeDashboard.offLogListeners();
    window.kubeDashboard.onLogLine((line) => appendLogLine(line, output));
    window.kubeDashboard.onLogError((msg) => appendLogLine(`[error] ${msg}`, output, { countRate: false, applyLiveFilter: false }));
    window.kubeDashboard.onLogClosed(() => {
        if (!logStreamPaused) { appendLogLine('[stream closed]', output, { countRate: false, applyLiveFilter: false }); }
    });

    select.onchange = () => {
        window.kubeDashboard.stopLogStream();
        startLogsLiveStream(context, namespace, selector);
    };

    modal.showModal();
    if (initialMode === 'live') { startLogsLiveStream(context, namespace, selector); }
}

function bindLogEventListeners() {
    document.getElementById('logsTabLive')?.addEventListener('click', () => {
        if (document.getElementById('logsTabLive').classList.contains('is-active')) { return; }
        setLogsMode('live');
        if (logsModalContext) {
            const { context, namespace, selector } = logsModalContext;
            startLogsLiveStream(context, namespace, selector);
        }
    });

    document.getElementById('logsTabSearch')?.addEventListener('click', () => {
        if (document.getElementById('logsTabSearch').classList.contains('is-active')) { return; }
        window.kubeDashboard.stopLogStream();
        stopLogRateTimer();
        logBuffer = [];
        caughtBuffer = [];
        logStreamPaused = false;
        updatePauseButton();
        document.getElementById('logsOutput').textContent = '';
        setLogsMode('search');
    });

    document.getElementById('logsSearchBtn')?.addEventListener('click', async () => {
        if (!logsModalContext) { return; }
        const { context, namespace, selector } = logsModalContext;
        const searchSelect = document.getElementById('logsSearchPodSelect');
        const fromInput = document.getElementById('logsSearchFrom');
        const toInput = document.getElementById('logsSearchTo');
        const termInput = document.getElementById('logsSearchInput');
        const output = document.getElementById('logsOutput');
        const btn = document.getElementById('logsSearchBtn');

        const isAll = searchSelect.value === '__all__';
        const sinceTime = fromInput.value ? new Date(fromInput.value).toISOString() : null;
        const untilTime = toInput.value ? new Date(toInput.value).toISOString() : null;
        const searchTerm = termInput.value.trim();
        const searchIsRegex = document.querySelector('#logsSearchMode .logs-catch-mode-btn.is-active')?.dataset.mode === 'regex';
        const maxLines = parseInt(document.getElementById('logsSearchLimit')?.value || '2000', 10);

        btn.disabled = true;
        output.textContent = '';
        logBuffer = [];
        const highlightInput = document.getElementById('logsHighlightInput');
        if (highlightInput) { highlightInput.value = ''; }
        setHighlightError('');

        const progressEl = document.getElementById('logsSearchProgress');
        const progressText = document.getElementById('logsSearchProgressText');
        if (progressEl) { progressEl.style.display = 'flex'; }
        document.getElementById('logsSearchCancelBtn').style.display = '';

        window.kubeDashboard.offSearchProgress?.();
        const cancelBtn = document.getElementById('logsSearchCancelBtn');
        window.kubeDashboard.onSearchProgress?.((p) => {
            if (progressText) {
                progressText.textContent = p.done
                    ? `Done — ${p.scanned.toLocaleString()} lines scanned, ${p.matched.toLocaleString()} matched`
                    : `Scanning… ${p.scanned.toLocaleString()} lines, ${p.matched.toLocaleString()} matched`;
            }
            if (p.done && cancelBtn) { cancelBtn.style.display = 'none'; }
        });

        try {
            const format = document.getElementById('logsFormatSelect')?.value || 'raw';
            const lines = await window.kubeDashboard.searchLogs({
                context, namespace,
                podName: isAll ? null : searchSelect.value,
                selector: isAll ? selector : null,
                sinceTime,
                untilTime,
                searchTerm,
                searchIsRegex,
                isErrors: format === 'errors',
                maxLines,
            });
            window.kubeDashboard.offSearchProgress?.();
            const groupBtn = document.getElementById('logsGroupBtn');
            if (lines.length === 0) {
                appendLogLine('[no results]', output, { countRate: false, applyLiveFilter: false });
                if (groupBtn) { groupBtn.classList.add('hidden'); }
            } else {
                for (const line of lines) { appendLogLine(line, output, { countRate: false, applyLiveFilter: false }); }
                if (lines.length >= LOG_SEARCH_MAX_LINES) {
                    appendLogLine(`[truncated — showing first ${LOG_SEARCH_MAX_LINES} of ${lines.length} lines]`, output, { countRate: false, applyLiveFilter: false });
                }
                applyHighlight();
                if (groupBtn) { groupBtn.classList.remove('hidden'); groupBtn.classList.remove('is-active'); groupBtn.textContent = 'Group'; }
            }
        } catch (err) {
            window.kubeDashboard.offSearchProgress?.();
            if (progressEl) { progressEl.style.display = 'none'; }
            appendLogLine(`[error] ${err.message}`, output, { countRate: false, applyLiveFilter: false });
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('logsGroupBtn')?.addEventListener('click', () => {
        const output = document.getElementById('logsOutput');
        const btn = document.getElementById('logsGroupBtn');
        const isGrouped = btn.classList.toggle('is-active');
        btn.textContent = isGrouped ? 'Ungroup' : 'Group';

        if (isGrouped) {
            // group: count identical messages, collapse into single rows
            const counts = new Map();
            const order = [];
            output.querySelectorAll('.log-line:not(.log-line--hidden)').forEach((el) => {
                const key = el.querySelector('.log-msg')?.textContent?.trim() || '';
                if (!key) { return; }
                if (!counts.has(key)) { counts.set(key, { el, count: 0 }); order.push(key); }
                counts.get(key).count++;
                if (counts.get(key).el !== el) { el.dataset.grouped = 'hide'; el.style.display = 'none'; }
            });
            order.forEach((key) => {
                const { el, count } = counts.get(key);
                let badge = el.querySelector('.log-group-count');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'log-group-count';
                    el.appendChild(badge);
                }
                badge.textContent = count > 1 ? `×${count}` : '';
                badge.style.display = count > 1 ? '' : 'none';
            });
        } else {
            // ungroup: restore all hidden lines, remove badges
            output.querySelectorAll('[data-grouped="hide"]').forEach((el) => {
                el.style.display = '';
                delete el.dataset.grouped;
            });
            output.querySelectorAll('.log-group-count').forEach((el) => el.remove());
        }
    });

    document.getElementById('logsSearchCancelBtn')?.addEventListener('click', () => {
        window.kubeDashboard.cancelSearch?.();
        window.kubeDashboard.offSearchProgress?.();
        const progressEl = document.getElementById('logsSearchProgress');
        const progressText = document.getElementById('logsSearchProgressText');
        if (progressText) { progressText.textContent = 'Cancelled'; }
        document.getElementById('logsSearchBtn').disabled = false;
        setTimeout(() => { if (progressEl) { progressEl.style.display = 'none'; } }, 1500);
    });

    document.getElementById('logsSearchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { document.getElementById('logsSearchBtn')?.click(); }
    });

    function toLocalDatetimeValue(date) {
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    document.getElementById('logsShortcutToday')?.addEventListener('click', () => {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0);
        document.getElementById('logsSearchFrom').value = toLocalDatetimeValue(startOfDay);
        document.getElementById('logsSearchTo').value = toLocalDatetimeValue(now);
    });

    document.getElementById('logsShortcutSincePod')?.addEventListener('click', () => {
        const { podObjects } = logsModalContext || {};
        const searchSelect = document.getElementById('logsSearchPodSelect');
        const selectedPod = searchSelect?.value === '__all__' ? null : searchSelect?.value;
        const pod = selectedPod
            ? podObjects?.find((p) => p.name === selectedPod)
            : podObjects?.[0];
        const startTime = pod?.startTime;
        if (!startTime) { return; }
        document.getElementById('logsSearchFrom').value = toLocalDatetimeValue(new Date(startTime));
        document.getElementById('logsSearchTo').value = toLocalDatetimeValue(new Date());
    });

    document.getElementById('logsModal')?.addEventListener('keydown', (e) => {
        if (e.key === 'f' && e.metaKey) {
            e.preventDefault();
            const isLive = document.getElementById('logsTabLive')?.classList.contains('is-active');
            const input = document.getElementById(isLive ? 'logsLiveHighlightInput' : 'logsHighlightInput');
            input?.focus();
            input?.select();
        }
    });

    document.getElementById('logsHighlightInput')?.addEventListener('input', () => {
        applyHighlight();
    });

    document.getElementById('logsLiveHighlightInput')?.addEventListener('input', () => {
        applyHighlight();
    });

    document.getElementById('logsPauseBtn')?.addEventListener('click', () => {
        if (logStreamPaused) { resumeLogsLiveStream(); }
        else { pauseLogsLiveStream(); }
    });

    document.getElementById('logsCopyMatchesBtn')?.addEventListener('click', () => {
        const rx = buildHighlightRegex();
        if (!rx) { return; }
        const matches = [];
        document.querySelectorAll('#logsOutput .log-line:not(.log-line--hidden) .log-msg').forEach((el) => {
            rx.lastIndex = 0;
            const found = el.dataset.text?.match(rx) || [];
            matches.push(...found);
        });
        if (matches.length > 0) {
            navigator.clipboard.writeText(matches.join('\n'));
            const btn = document.getElementById('logsCopyMatchesBtn');
            btn.textContent = `Copied ${matches.length}`;
            setTimeout(() => { btn.textContent = 'Copy matches'; }, 1500);
        }
    });
    document.getElementById('logsLiveFilterInput')?.addEventListener('input', () => {
        refreshLiveLogLines();
    });

    document.getElementById('logsOutput')?.addEventListener('scroll', (e) => {
        const output = e.currentTarget;
        logAutoScroll = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
        hideLogsRegexMenu();
    });
    document.addEventListener('contextmenu', showLogsRegexMenu, true);
    document.addEventListener('click', (e) => {
        if (!e.target.closest?.('#logsRegexMenu')) { hideLogsRegexMenu(); }
    });
    document.getElementById('logsNetInput')?.addEventListener('input', () => {
        caughtBuffer = [];
        buildCatchMatcher();
        renderCaughtLogLines();
    });
    document.getElementById('logsSearchMode')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.logs-catch-mode-btn[data-mode]');
        if (!btn) { return; }
        document.querySelectorAll('#logsSearchMode .logs-catch-mode-btn').forEach((item) => item.classList.toggle('is-active', item === btn));
    });
    document.getElementById('logsCatchMode')?.addEventListener('click', (e) => {
        const btn = e.target.closest('.logs-catch-mode-btn[data-mode]');
        if (!btn) { return; }
        document.querySelectorAll('#logsCatchMode .logs-catch-mode-btn').forEach((item) => item.classList.toggle('is-active', item === btn));
        caughtBuffer = [];
        buildCatchMatcher();
        renderCaughtLogLines();
        document.getElementById('logsNetInput')?.focus();
    });
    document.getElementById('logsNetClear')?.addEventListener('click', () => {
        caughtBuffer = [];
        document.getElementById('logsNetInput').value = '';
        document.getElementById('logsNetOutput').value = '';
    });
    document.getElementById('logsNetCopy')?.addEventListener('click', () => {
        const output = document.getElementById('logsNetOutput');
        const text = output?.value || '';
        if (!text) { return; }
        navigator.clipboard.writeText(text);
        const btn = document.getElementById('logsNetCopy');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
    document.getElementById('logsNetDivider')?.addEventListener('mousedown', (e) => {
        const divider = e.currentTarget;
        const net = document.getElementById('logsNet');
        const startX = e.clientX;
        const startWidth = net.offsetWidth;
        divider.classList.add('is-dragging');

        function onMove(ev) {
            const delta = startX - ev.clientX;
            net.style.width = `${Math.max(120, startWidth + delta)}px`;
        }
        function onUp() {
            divider.classList.remove('is-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    document.getElementById('logsFormatSelect')?.addEventListener('change', () => reRenderLogOutput());
    document.getElementById('logsLiveFormatSelect')?.addEventListener('change', () => reRenderLogOutput());

    document.getElementById('logsCloseBtn')?.addEventListener('click', closeLogsModal);
    document.getElementById('logsModal')?.addEventListener('close', () => {
        window.kubeDashboard.stopLogStream();
        window.kubeDashboard.offLogListeners();
        stopLogRateTimer();
    });
    document.getElementById('logsCopyBtn')?.addEventListener('click', () => {
        const output = document.getElementById('logsOutput');
        const format = getLogFormat();
        const lines = [...(output?.querySelectorAll('.log-line:not(.log-line--hidden)') || [])]
            .filter((el) => el.dataset.raw)
            .map((el) => {
                const raw = el.dataset.raw;
                if (format === 'raw') { return el.querySelector('.log-msg')?.dataset.text || el.textContent.trim(); }
                const { ts, msg, level } = formatLogContent(raw, format);
                return [ts, level, msg].filter(Boolean).join(' ');
            });
        navigator.clipboard.writeText(lines.join('\n'));
        const btn = document.getElementById('logsCopyBtn');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy all'; }, 1500);
    });
}

if (typeof document !== 'undefined') {
    bindLogEventListeners();
}

if (typeof module !== 'undefined') {
    module.exports = {
        appendLogLine,
        renderCaughtLogLines,
        refreshLiveLogLines,
        formatLogContent,
        generateRegexFromSelection,
        buildCatchExtractor,
        buildCatchMatcher,
    };
}
