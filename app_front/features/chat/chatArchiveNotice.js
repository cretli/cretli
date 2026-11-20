/**
 * In-chat auto-archive notice: while the open chat (with its fork family) is in
 * the sidebar countdown window, a card under the conversation says when it will
 * be archived, drains a bar towards the deadline and offers "Postpone".
 *
 * It reuses the resume-advice card styling so every "the chat needs a decision"
 * notice looks the same. Pure HTML + a small controller; the caller supplies the
 * countdown, the host element and the postpone request.
 */

import { escapeHtml } from './chatHtmlUtils.js';

/**
 * @typedef {{ remainingMs: number, warnMs: number, label: string, tone: string }} ArchiveCountdown
 */

/**
 * Share of the warning window still left, 0..1 (the bar drains to the deadline).
 *
 * @param {ArchiveCountdown} countdown
 * @returns {number}
 */
export function archiveNoticeProgress(countdown) {
  const warnMs = Number(countdown?.warnMs);
  const remainingMs = Number(countdown?.remainingMs);
  if (!Number.isFinite(warnMs) || warnMs <= 0 || !Number.isFinite(remainingMs)) return 0;
  return Math.min(1, Math.max(0, remainingMs / warnMs));
}

/**
 * @param {ArchiveCountdown | null} countdown
 * @param {(key: string, params?: Record<string, any>) => string} t
 * @param {{ pending?: boolean, hint?: string }} [state]
 * @returns {string} empty when nothing should be shown
 */
export function renderChatArchiveNoticeHtml(countdown, t, state = {}) {
  if (!countdown) return '';
  const percent = (archiveNoticeProgress(countdown) * 100).toFixed(1);
  const hint = String(state.hint || '');
  return `<div class="chat-resume-advice chat-archive-notice" role="status" data-archive-notice data-tone="${escapeHtml(countdown.tone)}">`
    + `<cr-icon-button class="chat-resume-advice-dismiss" data-archive-notice-action="dismiss" aria-label="${escapeHtml(t('chat.archiveNoticeDismiss'))}"><span class="mdi mdi-close" aria-hidden="true"></span></cr-icon-button>`
    + `<p class="chat-resume-advice-text">${escapeHtml(t('chat.archiveNoticeText', { time: countdown.label }))}</p>`
    + `<div class="chat-archive-notice-bar" aria-hidden="true"><span class="chat-archive-notice-bar-fill" style="width:${percent}%"></span></div>`
    + (hint ? `<p class="chat-resume-advice-hint" data-tone="error">${escapeHtml(hint)}</p>` : '')
    + `<div class="chat-resume-advice-actions">`
    + `<cr-bar-button variant="primary" data-archive-notice-action="postpone"${state.pending ? ' disabled' : ''}>${escapeHtml(t('chat.archiveNoticePostpone'))}</cr-bar-button>`
    + `</div></div>`;
}

/**
 * @param {{
 *   t: (key: string, params?: Record<string, any>) => string,
 *   getHost: (chat: any) => HTMLElement | null,
 *   resolveCountdown: (chat: any) => ArchiveCountdown | null,
 *   postpone: (chat: any) => Promise<{ ok: boolean, error?: string }>,
 * }} deps
 */
export function createChatArchiveNoticeController(deps) {
  /** Chats whose notice the user closed; cleared once the countdown is gone. */
  const dismissed = new Set();
  /** @type {Map<string, string>} */
  const hints = new Map();
  const pending = new Set();
  /** @type {WeakMap<HTMLElement, string>} */
  const painted = new WeakMap();

  /**
   * @param {HTMLElement} host
   * @param {string} markup
   */
  function paint(host, markup) {
    if (painted.get(host) === markup) return;
    painted.set(host, markup);
    // The markup is already escaped by renderChatArchiveNoticeHtml, so a plain parse is enough.
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    host.replaceChildren(...doc.body.childNodes);
    host.hidden = !markup;
  }

  /** @param {any} chat */
  async function postpone(chat) {
    const id = String(chat?.id || '');
    if (!id || pending.has(id)) return;
    pending.add(id);
    hints.delete(id);
    sync(chat);
    let result;
    try {
      result = await deps.postpone(chat);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    pending.delete(id);
    if (!result?.ok) hints.set(id, deps.t('chat.archiveNoticePostponeFailed', { error: result?.error || '' }));
    sync(chat);
  }

  /**
   * Repaint the notice for one chat (cheap when nothing changed).
   *
   * @param {any} chat
   */
  function sync(chat) {
    const host = chat ? deps.getHost(chat) : null;
    if (!host) return;
    const id = String(chat.id || '');
    const countdown = deps.resolveCountdown(chat);
    if (!countdown) {
      dismissed.delete(id);
      hints.delete(id);
      paint(host, '');
      return;
    }
    if (dismissed.has(id)) {
      paint(host, '');
      return;
    }
    paint(host, renderChatArchiveNoticeHtml(countdown, deps.t, { pending: pending.has(id), hint: hints.get(id) }));
    if (host.dataset.archiveNoticeBound === '1') return;
    host.dataset.archiveNoticeBound = '1';
    host.addEventListener('click', (event) => {
      const target = /** @type {Element | null} */ (event.target instanceof Element ? event.target : null);
      const action = target?.closest('[data-archive-notice-action]')?.getAttribute('data-archive-notice-action');
      const current = /** @type {any} */ (host)._archiveNoticeChat;
      if (!action || !current) return;
      if (action === 'dismiss') {
        dismissed.add(String(current.id || ''));
        sync(current);
      } else if (action === 'postpone') {
        void postpone(current);
      }
    });
  }

  return {
    /** @param {any} chat */
    sync(chat) {
      const host = chat ? deps.getHost(chat) : null;
      if (host) /** @type {any} */ (host)._archiveNoticeChat = chat;
      sync(chat);
    },
  };
}
