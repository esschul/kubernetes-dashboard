/* global escapeHtml, loadConfig, formatRelativeTime, getAgePillClass, groupTrelloCards, latestPrData, refreshPullRequests, prRefreshInProgress, renderCardGroupHeader, renderPrCard, fillPrAvatars, showPrCommentsModal */

const TRELLO_HIDDEN_KEY = 'kube-dashboard:trello-hidden-lists';
const TRELLO_SHOW_PRS_KEY = 'kube-dashboard:trello-show-prs';
const TRELLO_MODE_KEY = 'kube-dashboard:trello-mode';
let trelloMode = (() => { try { return localStorage.getItem(TRELLO_MODE_KEY) === 'cards' ? 'cards' : 'board'; } catch { return 'board'; } })();
const trelloExpandedCards = new Set();
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
            renderTrelloView(trelloBoardData);
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
            const labels = renderTrelloLabels(card);
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

    applyTrelloAgeFilter();

    board.querySelectorAll('.external-link[data-url]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.kubeDashboard.openExternal(el.dataset.url);
        });
    });
}

function renderTrelloLabels(card) {
    return (card.labels || []).filter(l => l.color).map(l => {
        const baseColor = l.color.replace(/_(dark|light)$/, '');
        return `<span class="trello-label trello-label--${escapeHtml(baseColor)}">${escapeHtml(l.name || '')}</span>`;
    }).join('');
}

function renderLinkedPrRows(linked) {
    const byStatus = new Map();
    for (const link of linked) {
        const cls = link.status?.cls || 'open';
        if (!byStatus.has(cls)) byStatus.set(cls, { label: link.status?.label || 'Open', links: [] });
        byStatus.get(cls).links.push(link);
    }
    return [...byStatus].map(([cls, { label, links }]) => `<div class="trello-cards-linked">
        <span class="trello-cards-linked-prs">${links.map(l => `<span class="trello-pr-link trello-pr-link--${escapeHtml(cls)} external-link" data-url="${escapeHtml(l.url)}">${escapeHtml(l.label)}</span>`).join('')}</span>
        <span class="status-pill trello-cards-linked-status trello-cards-linked-status--${escapeHtml(cls)}">${escapeHtml(label)}</span>
    </div>`).join('');
}

function renderTrelloCardGroup({ card, open, merged, linked }, members) {
    const total = open.length + merged.length + linked.length;
    const collapsible = open.length === 0 && total > 0;
    const expanded = !collapsible || trelloExpandedCards.has(card.id);
    const repos = new Set([...open, ...merged].map(p => p.repository)).size;
    const meta = [`${total} PR${total !== 1 ? 's' : ''}`];
    if (repos > 1) meta.push(`${repos} repos`);
    if (collapsible) meta.push(linked.every(l => l.status?.cls === 'merged') ? 'all merged' : 'none open');
    const assignees = (card.idMembers || []).map(id => members[id]).filter(Boolean);
    if (assignees.length) meta.push(assignees.join(', '));
    if (card.dateLastActivity) meta.push(formatRelativeTime(card.dateLastActivity));
    const labels = renderTrelloLabels(card);
    const toggle = collapsible ? `<button class="trello-cards-toggle" data-card-id="${escapeHtml(card.id)}" title="${expanded ? 'Collapse' : 'Show PRs'}">${expanded ? '▾' : '▸'}</button>` : '';
    const header = renderCardGroupHeader({ url: card.shortUrl }, open, false, {
        name: card.name,
        badgesHtml: labels ? `<span class="trello-card-labels">${labels}</span>` : '',
        meta: meta.join(' · '),
        endHtml: toggle,
    });
    const rows = expanded ? [
        ...open.map(pr => renderPrCard(pr, false, false, { variant: 'row' })),
        ...merged.map(pr => renderPrCard(pr, true, false, { variant: 'row' })),
        renderLinkedPrRows(linked),
    ].join('') : '';
    const ageClass = card.dateLastActivity ? cardAgeClass(card.dateLastActivity) : '';
    return `<div class="trello-cards-group ${ageClass}">${header}${rows}</div>`;
}

function renderTrelloCards(data) {
    const container = document.getElementById('trelloCards');
    if (!data) { container.innerHTML = ''; return; }
    if (!latestPrData && !prRefreshInProgress) refreshPullRequests();
    const prs = {
        open: latestPrData?.pullRequests || [],
        merged: [...(latestPrData?.mergedPullRequests || []), ...(latestPrData?.mergedYesterdayPullRequests || [])],
    };
    const sections = groupTrelloCards(data, prs, { hiddenListIds: trelloHiddenLists, commentLinks: extractPrLinks });
    const members = data.members || {};
    const loading = latestPrData ? '' : '<p class="trello-cards-loading">Loading pull requests…</p>';
    container.innerHTML = loading + sections.map(({ list, groups }) => {
        const withPrs = groups.filter(g => g.open.length + g.merged.length + g.linked.length > 0);
        const without = groups.filter(g => !withPrs.includes(g));
        const empty = without.length ? `<div class="trello-cards-empty"><span>No PRs:</span> ${without.map(g =>
            `<span class="trello-cards-empty-card external-link ${g.card.dateLastActivity ? cardAgeClass(g.card.dateLastActivity) : ''}" data-url="${escapeHtml(g.card.shortUrl)}">${escapeHtml(g.card.name)}</span>`).join('')}</div>` : '';
        return `<section class="trello-cards-section">
            <div class="trello-cards-section-title">${escapeHtml(list.name)} <span class="trello-column-count">${groups.length}</span></div>
            ${withPrs.map(g => renderTrelloCardGroup(g, members)).join('')}
            ${empty}
        </section>`;
    }).join('');
    fillPrAvatars(container);
    applyTrelloAgeFilter();
}

function applyTrelloAgeFilter() {
    const age = document.getElementById('trelloBoard').dataset.ageFilter || 'all';
    document.querySelectorAll('#trelloBoard .trello-card, #trelloCards .trello-cards-group, #trelloCards .trello-cards-empty-card').forEach(el => {
        el.style.display = age === 'all' || el.classList.contains(`card-age--${age}`) ? '' : 'none';
    });
}

function applyTrelloMode() {
    document.querySelectorAll('.trello-mode-btn').forEach(b => b.classList.toggle('is-active', b.dataset.trelloMode === trelloMode));
    document.getElementById('trelloBoard').hidden = trelloMode !== 'board';
    document.getElementById('trelloCards').hidden = trelloMode !== 'cards';
    document.getElementById('trelloPrsBtn').hidden = trelloMode !== 'board';
    if (trelloBoardData) renderTrelloView(trelloBoardData);
}

function renderTrelloView(data) {
    if (trelloMode === 'cards') renderTrelloCards(data);
    else renderTrelloColumns(data);
}

let trelloCardsRenderQueued = false;
window.renderTrelloCardsIfVisible = () => {
    if (trelloMode !== 'cards' || !trelloBoardData || !isTrelloViewVisible() || trelloCardsRenderQueued) return;
    trelloCardsRenderQueued = true;
    requestAnimationFrame(() => {
        trelloCardsRenderQueued = false;
        renderTrelloCards(trelloBoardData);
    });
};

document.getElementById('trelloModeSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('.trello-mode-btn');
    if (!btn) return;
    trelloMode = btn.dataset.trelloMode;
    try { localStorage.setItem(TRELLO_MODE_KEY, trelloMode); } catch { /* ignore */ }
    applyTrelloMode();
});

document.getElementById('trelloCards').addEventListener('click', (e) => {
    const toggle = e.target.closest('.trello-cards-toggle');
    if (toggle) {
        const id = toggle.dataset.cardId;
        if (trelloExpandedCards.has(id)) trelloExpandedCards.delete(id); else trelloExpandedCards.add(id);
        renderTrelloCards(trelloBoardData);
        return;
    }
    const commentsPill = e.target.closest('.pr-comments-pill');
    if (commentsPill) {
        showPrCommentsModal(commentsPill.dataset.prKey);
        return;
    }
    const link = e.target.closest('.external-link[data-url], .pr-group-title[data-url], .pr-pipeline-link[data-url], .pr-card[data-url]');
    if (link) {
        e.preventDefault();
        window.kubeDashboard.openExternal(link.dataset.url);
    }
});

function renderTrelloBoard(data) {
    const empty = document.getElementById('trelloEmptyState');
    empty.style.display = 'none';
    if (!data) {
        renderTrelloColumns(null);
        renderListsDropdown(null);
        return;
    }
    renderListsDropdown(data.lists);
    renderTrelloView(data);
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
    document.getElementById('trelloBoard').dataset.ageFilter = chip.dataset.age;
    applyTrelloAgeFilter();
});

applyTrelloMode();

document.getElementById('trelloGoToSettings').addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.nav-item[data-view="settings"]').click();
});
