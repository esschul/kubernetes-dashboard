'use strict';
/* exported openLogsModal, closeLogsModal */

// Log modal state
const LOG_MAX_LINES = 500;
const LOG_RATE_WINDOW_MS = 10_000;
const LOG_RATE_GAUGE_MAX = 100;
let logBuffer = [];
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
    if (!needle) {
        netOutput.value = '';
        return;
    }
    netOutput.value = logBuffer
        .filter((raw) => logLineMatchesFilter(raw, getLiveFilter()) && raw.toLowerCase().includes(needle))
        .join('\n');
    netOutput.scrollTop = netOutput.scrollHeight;
}

function refreshLiveLogLines() {
    document.querySelectorAll('#logsOutput .log-line').forEach((el) => {
        el.classList.toggle('log-line--hidden', !logLineMatchesFilter(el.dataset.raw, getLiveFilter()));
    });
    renderCaughtLogLines();
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

function appendLogLine(raw, output, options = {}) {
    const { countRate = true, applyLiveFilter = countRate } = options;
    logBuffer.push(raw);
    if (logBuffer.length > LOG_MAX_LINES) { logBuffer.shift(); }
    if (countRate) {
        logLineTimestamps.push(Date.now());
        updateLogRateGauge();
    }

    const { ts, msg } = parseLogLine(raw);

    const el = document.createElement('div');
    el.className = 'log-line';
    el.dataset.raw = raw;
    const tsEl = document.createElement('span');
    tsEl.className = 'log-ts';
    tsEl.textContent = ts;
    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg';
    msgEl.textContent = msg;
    el.appendChild(tsEl);
    el.appendChild(msgEl);
    if (applyLiveFilter) {
        el.classList.toggle('log-line--hidden', !logLineMatchesFilter(raw, getLiveFilter()));
    }
    output.appendChild(el);
    if (output.children.length > LOG_MAX_LINES) { output.removeChild(output.firstChild); }
    if (logAutoScroll) { output.scrollTop = output.scrollHeight; }

    const needle = getNetFilter();
    if (applyLiveFilter && needle && raw.toLowerCase().includes(needle)) { renderCaughtLogLines(); }
}

function closeLogsModal() {
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    stopLogRateTimer();
    document.getElementById('logsModal').close();
}

let logsModalContext = null;

function setLogsMode(mode) {
    const isLive = mode === 'live';
    const isSearch = mode === 'search';
    document.getElementById('logsTabLive').classList.toggle('is-active', isLive);
    document.getElementById('logsTabSearch').classList.toggle('is-active', isSearch);
    document.getElementById('logsLiveControls').classList.toggle('hidden', !isLive);
    document.getElementById('logsSearchControls').classList.toggle('hidden', !isSearch);
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

function openLogsModal({ depName, pods, podObjects, context, namespace, selector }) {
    logBuffer = [];
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
    const envLabel = getCurrentEnvLabel(loadConfig());
    const pill = document.getElementById('logsEnvPill');
    if (pill) {
        pill.textContent = envLabel ? envLabel.toUpperCase() : '';
        pill.className = `logs-env-pill${envLabel ? ` is-env-${envLabel}` : ''}`;
    }
    output.textContent = '';
    document.getElementById('logsLiveFilterInput').value = '';
    document.getElementById('logsSearchInput').value = '';
    document.getElementById('logsNetInput').value = '';
    document.getElementById('logsNetOutput').value = '';

    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    setLogsMode('search');

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

    // Set min datetime on search picker to oldest pod start time
    const fromInput = document.getElementById('logsSearchFrom');
    const toInput = document.getElementById('logsSearchTo');
    if (fromInput && podObjects && podObjects.length > 0) {
        const oldest = podObjects
            .map((p) => p.startTime)
            .filter(Boolean)
            .sort()[0];
        if (oldest) {
            fromInput.min = getLocalDatetimeValue(new Date(oldest));
            fromInput.value = getLocalDatetimeValue(new Date(oldest));
        }
    }
    if (toInput) { toInput.value = getLocalDatetimeValue(); }

    window.kubeDashboard.offLogListeners();
    window.kubeDashboard.onLogLine((line) => appendLogLine(line, output));
    window.kubeDashboard.onLogError((msg) => appendLogLine(`[error] ${msg}`, output, { countRate: false, applyLiveFilter: false }));
    window.kubeDashboard.onLogClosed(() => appendLogLine('[stream closed]', output, { countRate: false, applyLiveFilter: false }));

    function startStream() {
        logBuffer = [];
        resetLogRateGauge();
        output.textContent = '';
        const isAll = select.value === '__all__';
        window.kubeDashboard.startLogStream({
            context, namespace,
            podName: isAll ? null : select.value,
            selector: isAll ? selector : null,
        });
    }

    select.onchange = () => {
        window.kubeDashboard.stopLogStream();
        startStream();
    };

    modal.showModal();
}

function bindLogEventListeners() {
    document.getElementById('logsTabLive')?.addEventListener('click', () => {
        setLogsMode('live');
        if (logsModalContext) {
            const { context, namespace, selector } = logsModalContext;
            const select = document.getElementById('logsPodSelect');
            const output = document.getElementById('logsOutput');
            const isAll = select.value === '__all__';
            logBuffer = [];
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
    });

    document.getElementById('logsTabSearch')?.addEventListener('click', () => {
        window.kubeDashboard.stopLogStream();
        stopLogRateTimer();
        logBuffer = [];
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

        btn.disabled = true;
        btn.textContent = 'Searching…';
        output.textContent = '';
        logBuffer = [];

        try {
            const lines = await window.kubeDashboard.searchLogs({
                context, namespace,
                podName: isAll ? null : searchSelect.value,
                selector: isAll ? selector : null,
                sinceTime,
                untilTime,
                searchTerm,
            });
            if (lines.length === 0) {
                appendLogLine('[no results]', output, { countRate: false, applyLiveFilter: false });
            } else {
                for (const line of lines) { appendLogLine(line, output, { countRate: false, applyLiveFilter: false }); }
            }
        } catch (err) {
            appendLogLine(`[error] ${err.message}`, output, { countRate: false, applyLiveFilter: false });
        } finally {
            btn.disabled = false;
            btn.textContent = 'Search';
        }
    });

    document.getElementById('logsSearchInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { document.getElementById('logsSearchBtn')?.click(); }
    });
    document.getElementById('logsLiveFilterInput')?.addEventListener('input', () => {
        refreshLiveLogLines();
    });

    document.getElementById('logsOutput')?.addEventListener('scroll', (e) => {
        const output = e.currentTarget;
        logAutoScroll = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
    });
    document.getElementById('logsNetInput')?.addEventListener('input', () => {
        renderCaughtLogLines();
    });
    document.getElementById('logsNetClear')?.addEventListener('click', () => {
        document.getElementById('logsNetInput').value = '';
        document.getElementById('logsNetOutput').value = '';
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

    document.getElementById('logsCloseBtn')?.addEventListener('click', closeLogsModal);
    document.getElementById('logsModal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('logsModal')) { closeLogsModal(); }
    });
    document.getElementById('logsModal')?.addEventListener('close', () => {
        window.kubeDashboard.stopLogStream();
        window.kubeDashboard.offLogListeners();
        stopLogRateTimer();
    });
    document.getElementById('logsCopyBtn')?.addEventListener('click', () => {
        navigator.clipboard.writeText(logBuffer.join('\n'));
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
    };
}
