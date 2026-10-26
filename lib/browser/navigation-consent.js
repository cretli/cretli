/**
 * Navigation consent for the built-in Browser.
 *
 * An agent that navigates to an origin outside the workspace allowlist used to
 * get a hard `navigation-blocked` error. Instead the call parks here while the
 * chat shows a prompt with three answers:
 * - `once`: this origin only, for this chat; dropped when the chat's Browser
 *   session closes (or the process restarts) — it is never persisted;
 * - `allow`: the origin is added to the workspace allowlist permanently;
 * - `deny` (or no answer before the timeout): the agent gets a clear error.
 *
 * Consent only widens the *origin allowlist* question. Every request still goes
 * through the full URL policy afterwards (scheme, ports, DNS pinning,
 * private-network and rebinding blocks), and loopback/private hosts never get a
 * prompt at all because allowlisting them would open the local network.
 */

import { isLocalHostname, isLoopbackHostname, isPrivateHostname, normalizeOrigin } from './url-policy.js';

export const NAVIGATION_CONSENT_TIMEOUT_MS = 120_000;
export const NAVIGATION_CONSENT_DECISIONS = Object.freeze(['once', 'allow', 'deny']);
/** Policy code of the only denial a consent prompt may override. */
export const NAVIGATION_CONSENT_POLICY_CODE = 'origin-not-allowed';

const MAX_PENDING_PER_CHAT = 5;

/**
 * Only public-looking http(s) origins are eligible for a prompt.
 * @param {string} origin
 * @returns {boolean}
 */
export function isConsentEligibleOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  let hostname = '';
  try {
    hostname = new URL(normalized).hostname;
  } catch {
    return false;
  }
  return !(isLoopbackHostname(hostname) || isPrivateHostname(hostname) || isLocalHostname(hostname));
}

/**
 * @param {{
 *   timeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   now?: () => number,
 *   persistOrigin?: (workspaceKey: string, origin: string) => void,
 *   onChange?: (event: { chatId: string }) => void,
 *   idFactory?: () => string,
 * }} [options]
 */
export function createNavigationConsentRegistry(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : NAVIGATION_CONSENT_TIMEOUT_MS;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const now = options.now || (() => Date.now());
  let counter = 0;
  const nextId = options.idFactory || (() => `nc-${now().toString(36)}-${(counter += 1).toString(36)}`);

  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Map<string, Set<string>>} chatId -> once-granted origins */
  const onceGrants = new Map();

  function notify(chatId) {
    try {
      options.onChange?.({ chatId });
    } catch {
      // A broken live push must never fail a navigation.
    }
  }

  function settle(entry, outcome) {
    if (!pending.delete(entry.id)) return;
    clearTimeoutFn(entry.timer);
    for (const resolve of entry.waiters) resolve(outcome);
    notify(entry.chatId);
  }

  return {
    /**
     * Parks until the user answers. Concurrent requests for the same chat and
     * origin share one prompt.
     * @param {{ chatId: string, grantChatId?: string, workspaceKey: string, origin: string }} input
     * @returns {Promise<'once'|'allow'|'deny'|'timeout'>}
     */
    request(input) {
      const chatId = String(input?.chatId || '').trim();
      const workspaceKey = String(input?.workspaceKey || '').trim();
      const origin = normalizeOrigin(input?.origin);
      // A fork child shares its parent's Browser session: the prompt shows in
      // the calling chat, the grant belongs to the session's chat.
      const grantChatId = String(input?.grantChatId || '').trim() || chatId;
      if (!chatId || !workspaceKey || !isConsentEligibleOrigin(origin)) return Promise.resolve('deny');
      if (this.hasOnceGrant(grantChatId, origin)) return Promise.resolve('once');
      for (const entry of pending.values()) {
        if (entry.chatId === chatId && entry.origin === origin) {
          return new Promise((resolve) => entry.waiters.push(resolve));
        }
      }
      const inChat = [...pending.values()].filter((entry) => entry.chatId === chatId).length;
      if (inChat >= MAX_PENDING_PER_CHAT) return Promise.resolve('deny');
      return new Promise((resolve) => {
        const entry = {
          id: nextId(),
          chatId,
          grantChatId,
          workspaceKey,
          origin,
          createdAt: now(),
          expiresAt: now() + timeoutMs,
          waiters: [resolve],
          timer: null,
        };
        entry.timer = setTimeoutFn(() => settle(entry, 'timeout'), timeoutMs);
        entry.timer?.unref?.();
        pending.set(entry.id, entry);
        notify(chatId);
      });
    },

    /**
     * @param {string} id
     * @param {string} decision once | allow | deny
     * @param {{ chatId?: string }} [scope] when given, the prompt must belong to that chat
     * @returns {{ ok: boolean, code?: string, origin?: string }}
     */
    resolve(id, decision, scope = {}) {
      const entry = pending.get(String(id || ''));
      if (!entry) return { ok: false, code: 'not-found' };
      if (scope.chatId && scope.chatId !== entry.chatId) return { ok: false, code: 'forbidden-chat' };
      if (!NAVIGATION_CONSENT_DECISIONS.includes(decision)) return { ok: false, code: 'invalid-decision' };
      if (decision === 'allow') {
        try {
          options.persistOrigin?.(entry.workspaceKey, entry.origin);
        } catch {
          // Persisting failed: keep the prompt open so the user can retry.
          return { ok: false, code: 'persist-failed' };
        }
      } else if (decision === 'once') {
        if (!onceGrants.has(entry.grantChatId)) onceGrants.set(entry.grantChatId, new Set());
        onceGrants.get(entry.grantChatId)?.add(entry.origin);
      }
      settle(entry, decision);
      return { ok: true, origin: entry.origin };
    },

    /** @param {string} chatId */
    list(chatId) {
      const id = String(chatId || '').trim();
      return [...pending.values()]
        .filter((entry) => entry.chatId === id)
        .map(({ id: promptId, chatId: owner, origin, createdAt, expiresAt }) => ({
          id: promptId, chatId: owner, origin, createdAt, expiresAt,
        }));
    },

    /** @param {string} chatId @param {string} origin */
    hasOnceGrant(chatId, origin) {
      return onceGrants.get(String(chatId || ''))?.has(normalizeOrigin(origin)) === true;
    },

    /** @param {string} chatId @returns {string[]} */
    onceOrigins(chatId) {
      return [...(onceGrants.get(String(chatId || '')) || [])];
    },

    /** Drops once-grants and denies prompts of a chat (its Browser session closed). */
    clearChat(chatId) {
      const id = String(chatId || '').trim();
      onceGrants.delete(id);
      for (const entry of [...pending.values()]) {
        if (entry.chatId === id) settle(entry, 'deny');
      }
    },
  };
}
