/* global escapeHtml, loadConfig, formatRelativeTime, getAgePillClass */

const TRELLO_HIDDEN_KEY = 'kube-dashboard:trello-hidden-lists';
const TRELLO_SHOW_PRS_KEY = 'kube-dashboard:trello-show-prs';
let trelloShowPrs = (() => { try { return localStorage.getItem(TRELLO_SHOW_PRS_KEY) !== 'false'; } catch { return true; } })();

let trelloBoardData = null;
let trelloHiddenLists = (() => {
    try { return new Set(JSON.parse(localStorage.getItem(TRELLO_HIDDEN_KEY) || '[]')); } catch { return new Set(); }
})();
let trelloSecretsPromise = null;
const TRELLO_REFRESH_MS = 2 * 60 * 1000;
let trelloLastFetch = 0;

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
    const [listsRes, cardsRes, membersRes] = await Promise.all([
        fetch(`https://api.trello.com/1/boards/${boardId}/lists${q}filter=open`),
        fetch(`https://api.trello.com/1/boards/${boardId}/cards${q}filter=open&fields=name,idList,shortUrl,labels,due,dueComplete,dateLastActivity,idMembers&actions=commentCard&action_fields=data`),
        fetch(`https://api.trello.com/1/boards/${boardId}/members${q}fields=fullName`),
    ]);
    if (!listsRes.ok) throw new Error(`Trello lists: ${listsRes.status} ${listsRes.statusText}`);
    if (!cardsRes.ok) throw new Error(`Trello cards: ${cardsRes.status} ${cardsRes.statusText}`);
    if (!membersRes.ok) throw new Error(`Trello members: ${membersRes.status} ${membersRes.statusText}`);
    const lists = await listsRes.json();
    const cards = await cardsRes.json();
    const membersArr = await membersRes.json();
    const members = Object.fromEntries(membersArr.map(m => [m.id, m.fullName.split(/[\s.]/)[0]]));
    return { lists, cards, members };
}

function formatDue(iso) {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d - now;
    if (Math.abs(diffMs) < 20 * 60 * 60 * 1000) return 'Today';
    if (diffMs > 0 && diffMs < 48 * 60 * 60 * 1000) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function cardAgeClass(iso) {
    const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
    if (days < 5)  return 'card-age--fresh';
    if (days < 10) return 'card-age--aging';
    return 'card-age--old';
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

    const { lists, cards, members = {} } = data;
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
            let prs = '';
            if (trelloShowPrs && prLinks.length > 0) {
                if (prLinks.length > 10) {
                    prs = `<span class="trello-pr-overflow">${prLinks.length} PRs</span>`;
                } else {
                    prs = prLinks.map(pr =>
                        `<span class="trello-pr-link trello-pr-link--${escapeHtml(pr.status.cls)} external-link" data-url="${escapeHtml(pr.url)}">${escapeHtml(pr.label)}</span>`
                    ).join('');
                }
            }
            const updatedAt = card.dateLastActivity ? `<span class="trello-card-updated">${formatRelativeTime(card.dateLastActivity)}</span>` : '';
            const ageClass = card.dateLastActivity ? cardAgeClass(card.dateLastActivity) : '';
            const assignees = (card.idMembers || []).map(id => members[id]).filter(Boolean);
            const assigneesHtml = assignees.length ? `<div class="trello-card-members">${assignees.map(n => `<span class="trello-member">${escapeHtml(n)}</span>`).join('')}</div>` : '';
            html += `<div class="trello-card${ageClass ? ` ${ageClass}` : ''}">
                ${labels ? `<div class="trello-card-labels">${labels}</div>` : ''}
                <div class="trello-card-name external-link" data-url="${escapeHtml(card.shortUrl)}">${escapeHtml(card.name)}</div>
                ${due}
                ${prs ? `<div class="trello-card-prs">${prs}</div>` : ''}
                <div class="trello-card-footer">${updatedAt}${assigneesHtml}</div>
            </div>`;
        }
        html += '</div></div>';
    }
    html += '</div>';
    board.innerHTML = html;

    const ageFilter = board.dataset.ageFilter;
    if (ageFilter && ageFilter !== 'all') {
        board.querySelectorAll('.trello-card').forEach(card => {
            card.style.display = card.classList.contains(`card-age--${ageFilter}`) ? '' : 'none';
        });
    }

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
    empty.style.display = 'none';
    if (!data) {
        renderTrelloColumns(null);
        renderListsDropdown(null);
        return;
    }
    renderListsDropdown(data.lists);
    renderTrelloColumns(data);
}

async function refreshTrello() {
    const status = document.getElementById('trelloStatusPanel');
    const btn = document.getElementById('trelloRefreshBtn');
    const config = loadConfig();
    const boardId = extractBoardId(config.trelloBoardUrl);
    if (!boardId) {
        renderTrelloBoard(null);
        return;
    }
    trelloLastFetch = Date.now();
    status.textContent = '';
    btn.classList.add('is-spinning');
    try {
        const { apiKey, apiToken } = await getTrelloSecrets();
        const data = await fetchTrelloBoard(boardId, apiKey, apiToken);
        trelloBoardData = data;
        renderTrelloBoard(data);
        const visibleLists = data.lists.filter(l => !trelloHiddenLists.has(l.id));
        const visibleListIds = new Set(visibleLists.map(l => l.id));
        const visibleCards = data.cards.filter(c => visibleListIds.has(c.idList));
        status.textContent = `${visibleCards.length} cards across ${visibleLists.length} lists`;
    } catch (err) {
        status.textContent = `Error: ${err.message}`;
    } finally {
        btn.classList.remove('is-spinning');
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

const _prsBtn = document.getElementById('trelloPrsBtn');
_prsBtn.classList.toggle('is-active', trelloShowPrs);
_prsBtn.addEventListener('click', () => {
    trelloShowPrs = !trelloShowPrs;
    _prsBtn.classList.toggle('is-active', trelloShowPrs);
    try { localStorage.setItem(TRELLO_SHOW_PRS_KEY, trelloShowPrs); } catch {}
    if (trelloBoardData) renderTrelloColumns(trelloBoardData);
});

document.getElementById('trelloRefreshBtn').addEventListener('click', refreshTrello);

function isTrelloViewVisible() {
    return !document.hidden && !document.getElementById('trelloView').classList.contains('hidden');
}

function refreshTrelloIfStale() {
    if (Date.now() - trelloLastFetch >= TRELLO_REFRESH_MS) refreshTrello();
}

// Only poll while the board is on screen; switching to the view catches up if stale.
setInterval(() => { if (isTrelloViewVisible()) refreshTrelloIfStale(); }, 30 * 1000);

document.getElementById('trelloAgeFilterBar').addEventListener('click', (e) => {
    const chip = e.target.closest('.trello-age-chip');
    if (!chip) return;
    document.querySelectorAll('.trello-age-chip').forEach(c => c.classList.remove('is-active'));
    chip.classList.add('is-active');
    const age = chip.dataset.age;
    const board = document.getElementById('trelloBoard');
    board.dataset.ageFilter = age;
    board.querySelectorAll('.trello-card').forEach(card => {
        const show = age === 'all' || card.classList.contains(`card-age--${age}`);
        card.style.display = show ? '' : 'none';
    });
});

document.getElementById('trelloGoToSettings').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.nav-item[data-view="settings"]').click();
});
