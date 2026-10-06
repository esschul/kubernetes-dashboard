/* global escapeHtml, loadConfig */

const TRELLO_HIDDEN_KEY = 'kube-dashboard:trello-hidden-lists';

let trelloBoardData = null;
let trelloHiddenLists = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(TRELLO_HIDDEN_KEY) || '[]')); } catch { return new Set(); }
})();
let trelloSecretsPromise = null;

function saveTrelloHiddenLists() {
    try { localStorage.setItem(TRELLO_HIDDEN_KEY, JSON.stringify([...trelloHiddenLists])); } catch { /* ignore */ }
}

function extractBoardId(url) {
    if (!url) return null;
    const m = url.match(/trello\.com\/b\/([a-zA-Z0-9]+)/);
    return m ? m[1] : null;
}

async function getTrelloSecrets() {
    if (!trelloSecretsPromise) {
        trelloSecretsPromise = window.kubeDashboard.fetchTrelloSecrets().catch(() => ({ apiKey: null, apiToken: null }));
    }
    return trelloSecretsPromise;
}

async function fetchTrelloBoard(boardId, apiKey, apiToken) {
    const authParams = apiKey && apiToken ? `key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(apiToken)}` : '';
    const q = authParams ? `?${authParams}&` : '?';
    const [listsRes, cardsRes] = await Promise.all([
        fetch(`https://api.trello.com/1/boards/${boardId}/lists${q}filter=open`),
        fetch(`https://api.trello.com/1/boards/${boardId}/cards${q}filter=open&fields=name,idList,shortUrl,labels,due,dueComplete&actions=commentCard&action_fields=data`),
    ]);
    if (!listsRes.ok) throw new Error(`Trello lists: ${listsRes.status} ${listsRes.statusText}`);
    if (!cardsRes.ok) throw new Error(`Trello cards: ${cardsRes.status} ${cardsRes.statusText}`);
    const lists = await listsRes.json();
    const cards = await cardsRes.json();
    return { lists, cards };
}

function formatDue(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d - now;
    if (Math.abs(diffMs) < 20 * 60 * 60 * 1000) return 'Today';
    if (diffMs > 0 && diffMs < 48 * 60 * 60 * 1000) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const PULL_RE = /https:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/pull\/(\d+)/g;
const STATUS_RE = /\*\*Status:\*\*\s*([\p{Emoji}])\s*(\w+)/u;

function prStatus(text) {
    const m = text.match(STATUS_RE);
    if (!m) return { label: 'Open', cls: 'open' };
    const emoji = m[1], word = m[2].toLowerCase();
    if (word === 'merged') return { label: 'Merged', cls: 'merged' };
    if (word === 'closed') return { label: 'Closed', cls: 'closed' };
    if (word === 'approved') return { label: 'Approved', cls: 'approved' };
    if (word === 'reviewed') return { label: 'In review', cls: 'review' };
    return { label: m[2], cls: 'review' };
}

function extractPrLinks(card) {
    const seen = new Set();
    const results = [];
    for (const action of (card.actions || [])) {
        const text = action?.data?.text || '';
        const status = prStatus(text);
        for (const m of text.matchAll(PULL_RE)) {
            if (!seen.has(m[0])) {
                seen.add(m[0]);
                results.push({ url: m[0], label: `${m[2]} #${m[3]}`, status });
            }
        }
    }
    return results;
}

// --- Dropdown ---

function renderListsDropdown(lists) {
    const dropdown = document.getElementById('trelloListsDropdown');
    if (!lists || lists.length === 0) { dropdown.hidden = true; return; }

    dropdown.innerHTML = lists.map(list => {
        const checked = !trelloHiddenLists.has(list.id);
        return `<label class="trello-dropdown-item">
            <input type="checkbox" data-list-id="${escapeHtml(list.id)}"${checked ? ' checked' : ''}>
            <span>${escapeHtml(list.name)}</span>
        </label>`;
    }).join('');

    dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = cb.dataset.listId;
            if (cb.checked) {
                trelloHiddenLists.delete(id);
            } else {
                trelloHiddenLists.add(id);
            }
            saveTrelloHiddenLists();
            renderTrelloColumns(trelloBoardData);
        });
    });
}

function toggleListsDropdown(e) {
    e.stopPropagation();
    const dropdown = document.getElementById('trelloListsDropdown');
    dropdown.hidden = !dropdown.hidden;
}

document.getElementById('trelloListsBtn').addEventListener('click', toggleListsDropdown);

document.addEventListener('click', (e) => {
    const wrap = document.getElementById('trelloListsDropdownWrap');
    if (wrap && !wrap.contains(e.target)) {
        document.getElementById('trelloListsDropdown').hidden = true;
    }
});

// --- Board rendering ---

function renderTrelloColumns(data) {
    const board = document.getElementById('trelloBoard');
    if (!data) { board.innerHTML = ''; return; }

    const { lists, cards } = data;
    const cardsByList = {};
    for (const c of cards) {
        if (!cardsByList[c.idList]) cardsByList[c.idList] = [];
        cardsByList[c.idList].push(c);
    }

    let html = '<div class="trello-columns">';
    for (const list of lists) {
        if (trelloHiddenLists.has(list.id)) continue;
        const listCards = cardsByList[list.id] || [];
        html += `<div class="trello-column">
            <div class="trello-column-header">${escapeHtml(list.name)} <span class="trello-column-count">${listCards.length}</span></div>
            <div class="trello-column-cards">`;
        for (const card of listCards) {
            const labels = (card.labels || []).filter(l => l.color).map(l => {
                const baseColor = l.color.replace(/_(dark|light)$/, '');
                return `<span class="trello-label trello-label--${escapeHtml(baseColor)}">${escapeHtml(l.name || '')}</span>`;
            }).join('');
            const overdue = card.due && !card.dueComplete && new Date(card.due) < new Date();
            const due = card.due ? `<span class="trello-due${card.dueComplete ? ' trello-due--done' : overdue ? ' trello-due--overdue' : ''}">${formatDue(card.due)}</span>` : '';
            const prLinks = extractPrLinks(card);
            const prs = prLinks.map(pr =>
                `<span class="trello-pr-link trello-pr-link--${escapeHtml(pr.status.cls)} external-link" data-url="${escapeHtml(pr.url)}">${escapeHtml(pr.label)}</span>`
            ).join('');
            html += `<div class="trello-card">
                ${labels ? `<div class="trello-card-labels">${labels}</div>` : ''}
                <div class="trello-card-name external-link" data-url="${escapeHtml(card.shortUrl)}">${escapeHtml(card.name)}</div>
                ${due}
                ${prs ? `<div class="trello-card-prs">${prs}</div>` : ''}
            </div>`;
        }
        html += '</div></div>';
    }
    html += '</div>';
    board.innerHTML = html;

    board.querySelectorAll('.external-link[data-url]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.kubeDashboard.openExternal(el.dataset.url);
        });
    });
}

function renderTrelloBoard(data) {
    const empty = document.getElementById('trelloEmptyState');
    if (!data) {
        empty.style.display = '';
        renderTrelloColumns(null);
        renderListsDropdown(null);
        return;
    }
    empty.style.display = 'none';
    renderListsDropdown(data.lists);
    renderTrelloColumns(data);
}

async function refreshTrello() {
    const status = document.getElementById('trelloStatusPanel');
    const config = loadConfig();
    const boardId = extractBoardId(config.trelloBoardUrl);
    if (!boardId) {
        status.textContent = 'No board configured — add a board URL in Settings';
        renderTrelloBoard(null);
        return;
    }
    status.textContent = 'Loading…';
    try {
        const { apiKey, apiToken } = await getTrelloSecrets();
        const data = await fetchTrelloBoard(boardId, apiKey, apiToken);
        trelloBoardData = data;
        renderTrelloBoard(data);
        status.textContent = `${data.cards.length} cards across ${data.lists.length} lists`;
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
    }
}

let _trelloKvAvailable = null; // cached per session

async function updateTrelloNavVisibility() {
    const nav = document.getElementById('trelloNavItem');
    const section = document.getElementById('trelloSettingsSection');

    // Check keyvault once per session
    if (_trelloKvAvailable === null) {
        try {
            const { apiKey, apiToken } = await window.kubeDashboard.fetchTrelloSecrets();
            _trelloKvAvailable = !!(apiKey && apiToken);
        } catch {
            _trelloKvAvailable = false;
        }
    }

    section.hidden = !_trelloKvAvailable;

    const config = loadConfig();
    nav.hidden = !_trelloKvAvailable || !config.trelloBoardUrl;

    // If currently on trello view but nav is now hidden, switch away
    if (nav.hidden && !document.getElementById('trelloView').classList.contains('hidden')) {
        document.querySelector('.nav-item[data-view="pull-requests"]').click();
    }
}

window.updateTrelloNavVisibility = updateTrelloNavVisibility;
updateTrelloNavVisibility();

document.getElementById('trelloRefreshBtn').addEventListener('click', refreshTrello);

document.getElementById('trelloGoToSettings').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.nav-item[data-view="settings"]').click();
});
