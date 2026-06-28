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

function getNetFilter() {
    return document.getElementById('logsNetInput')?.value.trim().toLowerCase() || '';
}

function getLiveFilter() {
    return document.getElementById('logsLiveFilterInput')?.value.trim() || '';
}

function renderCaughtLogLines() {
    const netOutput = document.getElementById('logsNetOutput');
    if (!netOutput) { return; }
    const needle = getNetFilter();
    if (!needle) { netOutput.value = ''; return; }
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
    const isLive = document.getElementById('logsTabLive')?.classList?.contains('is-active');
    const inputId = isLive ? 'logsLiveHighlightInput' : 'logsHighlightInput';
    return document.getElementById(inputId)?.value.trim() || '';
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
                    return { ts, msg: message || msg, cls: '' };
                }
                // app: show raw JSON string
                return { ts, msg: msg.slice(jsonStart), cls: '' };
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
    const { ts, msg, level, levelCls, extra, cls } = result;
    const el = document.createElement('div');
    el.className = `log-line${cls ? ` ${cls}` : ''}`;
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
    const pattern = getHighlightPattern();
    if (pattern) {
        const msgEl = el.querySelector('.log-msg');
        if (msgEl) {
            const text = msgEl.textContent;
            msgEl.dataset.text = text;
            let rx;
            try { rx = new RegExp(pattern, 'gi'); } catch { /* invalid regex, skip */ }
            if (rx) {
                msgEl.innerHTML = '';
                let last = 0; let m;
                while ((m = rx.exec(text)) !== null) {
                    if (m.index > last) { msgEl.appendChild(document.createTextNode(text.slice(last, m.index))); }
                    const mark = document.createElement('mark');
                    mark.textContent = m[0];
                    msgEl.appendChild(mark);
                    last = rx.lastIndex;
                    if (m[0].length === 0) { rx.lastIndex++; }
                }
                if (last < text.length) { msgEl.appendChild(document.createTextNode(text.slice(last))); }
            }
        }
    }
    output.appendChild(el);
    const domLimit = countRate ? LOG_MAX_LINES : LOG_SEARCH_MAX_LINES;
    if (output.children.length > domLimit) { output.removeChild(output.firstChild); }
    if (logAutoScroll) { output.scrollTop = output.scrollHeight; }

    const needle = getNetFilter();
    const msgText = el.querySelector('.log-msg')?.dataset.text || el.querySelector('.log-msg')?.textContent || '';
    if (applyLiveFilter && needle && !el.classList.contains('log-line--hidden') && msgText.toLowerCase().includes(needle)) {
        caughtBuffer.push(msgText.trim());
        renderCaughtLogLines();
    }
}

function closeLogsModal() {
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    stopLogRateTimer();
    caughtBuffer = [];
    document.getElementById('logsModal').close();
}

let logsModalContext = null;

function applyHighlight() {
    const pattern = getHighlightPattern();
    document.querySelectorAll('#logsOutput .log-line .log-msg').forEach((el) => {
        const text = el.dataset.text || el.textContent;
        el.dataset.text = text;
        if (!pattern) { el.textContent = text; return; }
        let rx;
        try { rx = new RegExp(pattern, 'gi'); } catch { el.textContent = text; return; }
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

function setLogsMode(mode) {
    const isLive = mode === 'live';
    const isSearch = mode === 'search';
    document.getElementById('logsTabLive').classList.toggle('is-active', isLive);
    document.getElementById('logsTabSearch').classList.toggle('is-active', isSearch);
    document.getElementById('logsLiveControls').classList.toggle('hidden', !isLive);
    document.getElementById('logsSearchControls').classList.toggle('hidden', !isSearch);
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

function startLogsLiveStream(context, namespace, selector) {
    const select = document.getElementById('logsPodSelect');
    const output = document.getElementById('logsOutput');
    const isAll = select.value === '__all__';
    logBuffer = [];
    caughtBuffer = [];
    resetLogRateGauge();
    startLogRateTimer();
    if (output) { output.textContent = ''; }
    document.getElementById('logsNetOutput').value = '';
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.startLogStream({
        context, namespace,
        podName: isAll ? null : select.value,
        selector: isAll ? selector : null,
    });
}

function openLogsModal({ depName, pods, podObjects, context, namespace, selector, initialMode = 'search' }) {
    logBuffer = [];
    caughtBuffer = [];
    logAutoScroll = true;
    stopLogRateTimer();
    resetLogRateGauge();
    logsModalContext = { depName, pods, podObjects, context, namespace, selector };

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
    document.getElementById('logsLiveFilterInput').value = '';
    document.getElementById('logsLiveHighlightInput').value = '';
    document.getElementById('logsSearchInput').value = '';
    document.getElementById('logsNetInput').value = '';
    document.getElementById('logsNetOutput').value = '';

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
    window.kubeDashboard.onLogClosed(() => appendLogLine('[stream closed]', output, { countRate: false, applyLiveFilter: false }));

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
        const maxLines = parseInt(document.getElementById('logsSearchLimit')?.value || '2000', 10);

        btn.disabled = true;
        output.textContent = '';
        logBuffer = [];
        const highlightInput = document.getElementById('logsHighlightInput');
        if (highlightInput) { highlightInput.value = ''; }

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
            const lines = await window.kubeDashboard.searchLogs({
                context, namespace,
                podName: isAll ? null : searchSelect.value,
                selector: isAll ? selector : null,
                sinceTime,
                untilTime,
                searchTerm,
                maxLines,
            });
            window.kubeDashboard.offSearchProgress?.();
            if (lines.length === 0) {
                appendLogLine('[no results]', output, { countRate: false, applyLiveFilter: false });
            } else {
                for (const line of lines) { appendLogLine(line, output, { countRate: false, applyLiveFilter: false }); }
                if (lines.length >= LOG_SEARCH_MAX_LINES) {
                    appendLogLine(`[truncated — showing first ${LOG_SEARCH_MAX_LINES} of ${lines.length} lines]`, output, { countRate: false, applyLiveFilter: false });
                }
                applyHighlight();
            }
        } catch (err) {
            window.kubeDashboard.offSearchProgress?.();
            if (progressEl) { progressEl.style.display = 'none'; }
            appendLogLine(`[error] ${err.message}`, output, { countRate: false, applyLiveFilter: false });
        } finally {
            btn.disabled = false;
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

    document.getElementById('logsHighlightInput')?.addEventListener('input', () => {
        applyHighlight();
    });

    document.getElementById('logsLiveHighlightInput')?.addEventListener('input', () => {
        applyHighlight();
    });

    document.getElementById('logsCopyMatchesBtn')?.addEventListener('click', () => {
        const pattern = document.getElementById('logsHighlightInput')?.value.trim();
        if (!pattern) { return; }
        let rx;
        try { rx = new RegExp(pattern, 'gi'); } catch { return; }
        const matches = [];
        document.querySelectorAll('#logsOutput .log-line:not(.log-line--hidden) .log-msg').forEach((el) => {
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
    });
    document.getElementById('logsNetInput')?.addEventListener('input', () => {
        caughtBuffer = [];
        renderCaughtLogLines();
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
    };
}
