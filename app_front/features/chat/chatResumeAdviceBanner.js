/**
 * Inline cheap-resume notice in the scrollable conversation: shown once per cold-cache episode when
 * a chat with a large context is resumed. Advisory only; sending is never blocked.
 */

import { escapeHtml } from './chatHtmlUtils.js';

const DISMISS_STORAGE_KEY = 'cretli-resume-advice-dismissed';
const DISMISS_MAX_ENTRIES = 200;
const TOKENS_PER_THOUSAND = 1000;

/** @param {number} tokens @returns {string} e.g. "250k" */
export function formatAdviceTokens(tokens) {
  const value = Number(tokens) || 0;
  return value >= TOKENS_PER_THOUSAND ? `${Math.round(value / TOKENS_PER_THOUSAND)}k` : String(value);
}

/**
 * Opt-in summary action line: the cheap-model call is only made on click, so the
 * estimate is always visible next to the button.
 */
function renderSummaryEstimate(advice, t, formatUsd) {
  const tokens = Number(advice.estimatedSummaryTokens) || 0;
  if (!(tokens > 0)) return '';
  const key = advice.estimatedSummaryUsd != null ? 'chat.resumeAdviceSummaryCost' : 'chat.resumeAdviceSummaryCostUnpriced';
  const cost = advice.estimatedSummaryUsd != null ? formatUsd(advice.estimatedSummaryUsd) : '';
  return `<p class="chat-resume-advice-estimate" data-resume-advice-summary-estimate>${escapeHtml(t(key, { tokens: formatAdviceTokens(tokens), cost }))}</p>`;
}

/**
 * @param {Record<string, any>|null} advice `advice` of `/api/usage/resume-advice`
 * @param {(key: string, params?: Record<string, any>) => string} t
 * @param {(usd: number) => string} formatUsd
 * @param {string} [hint] inline hint (e.g. the reference fork failed)
 * @returns {string} empty when nothing should be shown
 */
export function renderResumeAdviceHtml(advice, t, formatUsd, hint = '') {
  if (!advice || advice.show !== true || advice.enabled === false) return '';
  const tokens = formatAdviceTokens(advice.contextTokens);
  const cost = advice.estimatedRewriteUsd != null
    ? ` ${escapeHtml(t('chat.resumeAdviceCost', { cost: formatUsd(advice.estimatedRewriteUsd) }))}`
    : '';
  return `<div class="chat-resume-advice" role="status" data-resume-advice>`
    + `<cr-icon-button class="chat-resume-advice-dismiss" data-resume-advice-action="dismiss" aria-label="${escapeHtml(t('chat.resumeAdviceDismiss'))}"><span class="mdi mdi-close" aria-hidden="true"></span></cr-icon-button>`
    + `<p class="chat-resume-advice-text">${escapeHtml(t('chat.resumeAdviceText', { tokens }))}${cost}</p>`
    + (hint ? `<p class="chat-resume-advice-hint" data-tone="error">${escapeHtml(hint)}</p>` : '')
    + renderSummaryEstimate(advice, t, formatUsd)
    + `<div class="chat-resume-advice-actions">`
    + `<cr-bar-button variant="primary" data-resume-advice-action="reference">${escapeHtml(t('chat.resumeAdviceReference'))}</cr-bar-button>`
    + (advice.estimatedSummaryTokens > 0
      ? `<cr-bar-button data-resume-advice-action="summary">${escapeHtml(t('chat.resumeAdviceSummary'))}</cr-bar-button>`
      : '')
    + `<cr-bar-button data-resume-advice-action="send">${escapeHtml(t('chat.resumeAdviceSendAnyway'))}</cr-bar-button>`
    + `</div></div>`;
}

/**
 * Dismissal is keyed by chat id + last cached turn, so a new cold episode
 * (a newer cached turn) shows the banner again.
 *
 * @param {Storage|null} storage
 */
export function createResumeAdviceDismissals(storage) {
  const memory = new Set();
  const key = (chatId, lastCachedTurnAt) => `${chatId}:${lastCachedTurnAt ?? ''}`;
  const readStored = () => {
    try {
      const parsed = JSON.parse(storage?.getItem(DISMISS_STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    isDismissed(chatId, lastCachedTurnAt) {
      const id = key(chatId, lastCachedTurnAt);
      return memory.has(id) || readStored().includes(id);
    },
    dismiss(chatId, lastCachedTurnAt) {
      const id = key(chatId, lastCachedTurnAt);
      memory.add(id);
      try {
        const next = [...readStored().filter((entry) => entry !== id), id].slice(-DISMISS_MAX_ENTRIES);
        storage?.setItem(DISMISS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage is optional; the in-memory set still dedupes this session.
      }
    },
  };
}

/**
 * @param {{
 *   api: { getUsageResumeAdvice: (chatId: string) => Promise<Record<string, any>> },
 *   storage?: Storage|null,
 *   t: (key: string, params?: Record<string, any>) => string,
 *   formatUsd: (usd: number) => string,
 *   getHost: (chat: Record<string, any>) => HTMLElement|null,
 *   onLayoutChange?: (host: HTMLElement) => void,
 *   onReference: (chat: Record<string, any>, options?: { withSummary?: boolean }) => Promise<{ ok: boolean, code?: string }>, // failure codes: reference_requires_saved_history, sync_failed
 * }} deps
 */
export function createResumeAdviceController(deps) {
  const dismissals = createResumeAdviceDismissals(deps.storage ?? null);
  /** @type {WeakMap<HTMLElement, { chat: object, advice: object }>} */
  const hosts = new WeakMap();
  const bound = new WeakSet();
  /** Bumped by hide(); a response that started before it must not repaint. */
  const generations = new WeakMap();
  /** Hosts with a reference fork in flight; blocks duplicate clicks. */
  const pending = new WeakSet();

  /** @param {string} [code] failure code of the reference action */
  function hintForFailure(code) {
    if (code === 'reference_requires_saved_history') return deps.t('chat.resumeAdviceNoHistory');
    if (code === 'sync_failed') return deps.t('sendBar.forkSyncFailed');
    return deps.t('chat.resumeAdviceForkFailed');
  }

  function paint(host, hint = '') {
    const state = hosts.get(host);
    const html = state ? renderResumeAdviceHtml(state.advice, deps.t, deps.formatUsd, hint) : '';
    const scrollContainer = host.parentElement;
    const wasAtBottom = scrollContainer
      && scrollContainer.scrollHeight - scrollContainer.clientHeight - scrollContainer.scrollTop <= 2;
    host.innerHTML = html;
    host.hidden = html === '';
    if (wasAtBottom) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      const scrollTop = scrollContainer.scrollTop;
      // Lit actions finish rendering after innerHTML changes; follow their final height.
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
        if (host.parentElement === scrollContainer && scrollContainer.scrollTop === scrollTop) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
    deps.onLayoutChange?.(host);
  }

  function clear(host) {
    hosts.delete(host);
    paint(host);
  }

  async function handleAction(host, action) {
    const state = hosts.get(host);
    if (!state) return;
    const { chat, advice } = state;
    if (action === 'send' || action === 'dismiss') {
      generations.set(host, (generations.get(host) || 0) + 1);
      dismissals.dismiss(chat.id, advice.lastCachedTurnAt);
      clear(host);
      return;
    }
    if ((action !== 'reference' && action !== 'summary') || pending.has(host)) return;
    pending.add(host);
    let result;
    try {
      result = await deps.onReference(chat, { withSummary: action === 'summary' });
    } catch {
      result = { ok: false };
    } finally {
      pending.delete(host);
    }
    if (result?.ok) {
      dismissals.dismiss(chat.id, advice.lastCachedTurnAt);
      clear(host);
      return;
    }
    if (hosts.has(host)) paint(host, hintForFailure(result?.code));
  }

  function bind(host) {
    if (bound.has(host)) return;
    bound.add(host);
    host.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-resume-advice-action]');
      if (button) void handleAction(host, button.getAttribute('data-resume-advice-action'));
    });
  }

  return {
    /** Fetch the advice and show the banner; renders nothing on any error. Resolves to the advice (or null). */
    async check(chat) {
      const host = chat?.id ? deps.getHost(chat) : null;
      if (!host) return null;
      bind(host);
      const generation = generations.get(host) || 0;
      let res = null;
      try {
        res = await deps.api.getUsageResumeAdvice(chat.id);
      } catch {
        res = null;
      }
      const advice = res?.ok ? res.advice : null;
      if ((generations.get(host) || 0) !== generation) return advice;
      if (!advice?.show || dismissals.isDismissed(chat.id, advice.lastCachedTurnAt)) {
        clear(host);
        return advice;
      }
      hosts.set(host, { chat, advice });
      paint(host);
      return advice;
    },
    /** Hides a stale banner (e.g. the user sent a message) without dismissing the episode. */
    hide(chat) {
      const host = chat?.id ? deps.getHost(chat) : null;
      if (!host) return;
      generations.set(host, (generations.get(host) || 0) + 1);
      clear(host);
    },
    handleAction,
    isDismissed: dismissals.isDismissed,
  };
}

const WARM_RECHECK_MS = 30 * 1000;
const DEFAULT_RECHECK_MS = 5 * 60 * 1000;

/**
 * Decides when a chat may ask for advice again. Semantics:
 * - never while a run is generating (nothing is requested, nothing is stamped);
 * - a result without a host (`null`) is not stamped;
 * - warm cache or active run: ask again after 30 s, so a cache that expires
 *   shortly after the first check is still caught on a later focus/select;
 * - any other no-show result: ask again after 5 minutes (the shortest cache TTL);
 * - banner shown: no further requests until `reset()` (the user sent a message);
 * - `ttl_unknown`: never ask again for this chat.
 *
 * @param {{
 *   check: (chat: Record<string, any>) => Promise<Record<string, any>|null>,
 *   isBusy: (chat: Record<string, any>) => boolean,
 *   now?: () => number,
 *   warmRecheckMs?: number,
 *   recheckMs?: number,
 * }} deps
 */
export function createResumeAdviceScheduler(deps) {
  const now = deps.now || Date.now;
  const warmMs = deps.warmRecheckMs ?? WARM_RECHECK_MS;
  const defaultMs = deps.recheckMs ?? DEFAULT_RECHECK_MS;
  /** @type {WeakMap<object, { nextAt: number, inFlight: boolean, generation: number }>} */
  const states = new WeakMap();
  const stateOf = (chat) => {
    if (!states.has(chat)) states.set(chat, { nextAt: 0, inFlight: false, generation: 0 });
    return states.get(chat);
  };
  function nextDelay(advice) {
    if (advice.reason === 'ttl_unknown' || advice.show === true) return Infinity;
    return advice.reason === 'cache_warm' || advice.reason === 'run_active' ? warmMs : defaultMs;
  }
  return {
    /** @returns {Promise<boolean>} whether a request was made */
    async request(chat) {
      if (!chat || deps.isBusy(chat)) return false;
      const state = stateOf(chat);
      if (state.inFlight || now() < state.nextAt) return false;
      state.inFlight = true;
      const generation = state.generation;
      let advice = null;
      try {
        advice = await deps.check(chat);
      } finally {
        state.inFlight = false;
      }
      if (advice && state.generation === generation) state.nextAt = now() + nextDelay(advice);
      return true;
    },
    /** The user sent a message: allow a fresh check later. */
    reset(chat) {
      if (!chat) return;
      const state = stateOf(chat);
      state.generation += 1;
      state.nextAt = 0;
    },
  };
}
