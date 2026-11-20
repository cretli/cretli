/**
 * Terminal session picker (trigger label + dropdown list) and the LAN sync box.
 */
import { getLanUrl } from '../../../core/api/index.js';
import { t } from '../../../i18n/index.js';
import { setTerminalStatus } from '../../connection/connectionStatus.js';
import { safeFit } from '../services/terminalViewport.js';
import { terminals, terminalState, terminalFavorites } from '../state/terminalStore.js';

function applySyncUrl(syncUrl) {
  const box = document.getElementById('terminal-sync-box');
  const link = /** @type {HTMLAnchorElement | null} */ (document.getElementById('terminal-sync-link'));
  const qr = /** @type {HTMLImageElement | null} */ (document.getElementById('terminal-sync-qr'));
  if (link) {
    link.href = syncUrl;
    link.textContent = syncUrl;
  }
  if (qr) qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=' + encodeURIComponent(syncUrl);
  if (box) box.style.display = 'flex';
}

function syncUrlFor(base, sessionId) {
  const pathname = typeof location !== 'undefined' ? location.pathname : '/';
  return base + pathname + '?session=' + sessionId;
}

export function updateSyncBox(sessionId) {
  if (!sessionId) return;
  getLanUrl()
    .then((data) => {
      const base = data.ok && data.url ? data.url : (typeof location !== 'undefined' ? location.origin : '');
      applySyncUrl(syncUrlFor(base, sessionId));
    })
    .catch(() => {
      applySyncUrl(syncUrlFor(typeof location !== 'undefined' ? location.origin : '', sessionId));
    });
}

function setFavIcon(btn, active) {
  const icon = document.createElement('span');
  icon.className = 'mdi ' + (active ? 'mdi-star dropdown-fav-btn--active' : 'mdi-star-outline');
  icon.setAttribute('aria-hidden', 'true');
  btn.replaceChildren(icon);
}

function getTerminalFavoriteKey(terminal) {
  if (!terminal) return '';
  if (terminal.sessionId) return `session:${terminal.sessionId}`;
  return `title:${terminal.title || terminal.id || ''}`;
}

export function updateTerminalSelect() {
  const triggerLabel = document.getElementById('terminal-bar-trigger-label');
  const listEl = document.getElementById('terminal-list-items');

  if (!terminalState.activeId || !terminals.some((t) => t.id === terminalState.activeId)) {
    const firstId = terminals[0]?.id || null;
    if (firstId && firstId !== terminalState.activeId) {
      selectTerminal(firstId);
      return;
    }
  }

  const current = terminalState.activeId ? terminals.find((t) => t.id === terminalState.activeId) : null;
  if (triggerLabel) {
    triggerLabel.textContent = current ? current.title : '—';
  }
  if (!listEl) return;

  const orderedTerminals = terminals
    .map((terminal, idx) => ({ terminal, idx }))
    .sort((a, b) => {
      const af = terminalFavorites.isFavorite(getTerminalFavoriteKey(a.terminal)) ? 1 : 0;
      const bf = terminalFavorites.isFavorite(getTerminalFavoriteKey(b.terminal)) ? 1 : 0;
      if (af !== bf) return bf - af;
      return a.idx - b.idx;
    })
    .map((x) => x.terminal);

  listEl.replaceChildren(
    ...orderedTerminals.map((row) => {
      const li = document.createElement('li');
      li.className = 'chat-list-item' + (row.id === terminalState.activeId ? ' is-active' : '');
      li.setAttribute('role', 'option');
      li.dataset.terminalId = row.id;
      li.tabIndex = -1;
      const title = document.createElement('span');
      title.className = 'chat-list-item-title';
      title.textContent = row.title;
      li.appendChild(title);
      return li;
    }),
  );

  listEl.querySelectorAll('.chat-list-item').forEach((el) => {
    const id = /** @type {HTMLElement} */ (el).dataset.terminalId;
    const terminal = id ? terminals.find((item) => item.id === id) : null;
    const favKey = getTerminalFavoriteKey(terminal);
    if (favKey) {
      const active = terminalFavorites.isFavorite(favKey);
      const favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'dropdown-fav-btn';
      favBtn.title = active ? t('terminal.favoriteRemove') : t('terminal.favoriteAdd');
      favBtn.setAttribute('aria-label', favBtn.title);
      setFavIcon(favBtn, active);
      favBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const next = terminalFavorites.toggleFavorite(favKey);
        favBtn.title = next ? t('terminal.favoriteRemove') : t('terminal.favoriteAdd');
        favBtn.setAttribute('aria-label', favBtn.title);
        setFavIcon(favBtn, next);
      });
      el.appendChild(favBtn);
    }
    el.addEventListener('click', () => {
      if (!id) return;
      selectTerminal(id);
      terminalState.dropdownApi?.close();
    });
  });
}

export function selectTerminal(id) {
  terminalState.activeId = id;
  const t = terminals.find((x) => x.id === id);
  document.querySelectorAll('.terminal-tab-pane').forEach((p) => {
    p.classList.toggle('active', /** @type {HTMLElement} */ (p).dataset.terminalId === id);
  });
  updateTerminalSelect();
  setTerminalStatus(t ? (t._connectionStatus || 'disconnected') : 'disconnected');
  if (t && t.fitAddon && t.pane) {
    const wrap = t.pane.querySelector('.terminal-viewport-wrap');
    setTimeout(() => safeFit(t.term, t.fitAddon, wrap), 50);
  }
  if (t && t.sessionId) updateSyncBox(t.sessionId);
}

