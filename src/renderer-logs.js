'use strict';
/* exported openLogsModal, closeLogsModal */

// Log modal state
const LOG_MAX_LINES = 500;
let logBuffer = [];
let logAutoScroll = true;

function appendLogLine(raw, output) {
    logBuffer.push(raw);
    if (logBuffer.length > LOG_MAX_LINES) { logBuffer.shift(); }

    const filter = document.getElementById('logsFilterInput')?.value.trim().toLowerCase();
    const { ts, msg } = parseLogLine(raw);
    const visible = !filter || raw.toLowerCase().includes(filter);

    const el = document.createElement('div');
    el.className = 'log-line' + (visible ? '' : ' log-line--hidden');
    const tsEl = document.createElement('span');
    tsEl.className = 'log-ts';
    tsEl.textContent = ts;
    const msgEl = document.createElement('span');
    msgEl.className = 'log-msg';
    msgEl.textContent = msg;
    el.appendChild(tsEl);
    el.appendChild(msgEl);
    output.appendChild(el);
    if (output.children.length > LOG_MAX_LINES) { output.removeChild(output.firstChild); }
    if (logAutoScroll) { output.scrollTop = output.scrollHeight; }

    if (visible) {
        const needle = document.getElementById('logsNetInput')?.value.trim();
        if (needle && raw.toLowerCase().includes(needle.toLowerCase())) {
            const netOutput = document.getElementById('logsNetOutput');
            netOutput.value += (netOutput.value ? '\n' : '') + raw;
            netOutput.scrollTop = netOutput.scrollHeight;
        }
    }
}

function closeLogsModal() {
    window.kubeDashboard.stopLogStream();
    window.kubeDashboard.offLogListeners();
    document.getElementById('logsModal').close();
}

function openLogsModal({ depName, pods, context, namespace }) {
    logBuffer = [];
    logAutoScroll = true;

    const modal = document.getElementById('logsModal');
    const output = document.getElementById('logsOutput');
    const select = document.getElementById('logsPodSelect');
    const title = document.getElementById('logsModalTitle');

    title.textContent = depName;
    const envLabel = getCurrentEnvLabel(loadConfig());
    const pill = document.getElementById('logsEnvPill');
    if (pill) {
        pill.textContent = envLabel ? envLabel.toUpperCase() : '';
        pill.className = `logs-env-pill${envLabel ? ` is-env-${envLabel}` : ''}`;
    }
    output.textContent = '';
    document.getElementById('logsFilterInput').value = '';
    document.getElementById('logsNetInput').value = '';
    document.getElementById('logsNetOutput').value = '';
    select.innerHTML = pods.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

    window.kubeDashboard.offLogListeners();
    window.kubeDashboard.onLogLine((line) => appendLogLine(line, output));
    window.kubeDashboard.onLogError((msg) => appendLogLine(`[error] ${msg}`, output));
    window.kubeDashboard.onLogClosed(() => appendLogLine('[stream closed]', output));

    function startStream() {
        logBuffer = [];
        output.textContent = '';
        window.kubeDashboard.startLogStream({ context, namespace, podName: select.value });
    }

    select.onchange = () => {
        window.kubeDashboard.stopLogStream();
        startStream();
    };

    output.addEventListener('scroll', () => {
        logAutoScroll = output.scrollTop + output.clientHeight >= output.scrollHeight - 20;
    });

    startStream();
    modal.showModal();
}

// Event listeners
document.getElementById('logsFilterInput')?.addEventListener('input', () => {
    const filter = document.getElementById('logsFilterInput').value.trim().toLowerCase();
    document.querySelectorAll('#logsOutput .log-line').forEach((el) => {
        const text = el.textContent.toLowerCase();
        el.classList.toggle('log-line--hidden', !!filter && !text.includes(filter));
    });
    document.getElementById('logsNetOutput').value = '';
});
document.getElementById('logsNetInput')?.addEventListener('input', () => {
    document.getElementById('logsNetOutput').value = '';
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
});
document.getElementById('logsCopyBtn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(logBuffer.join('\n'));
    const btn = document.getElementById('logsCopyBtn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy all'; }, 1500);
});
