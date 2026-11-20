/**
 * Consent registry for agent `port_expose` calls when the policy mode is `ask`.
 *
 * Same shape as the Browser navigation consent (lib/browser/navigation-consent.js)
 * but a separate module: that one is limited to public origins, this one is
 * keyed by `(chatId, port)`. The tool waits briefly, the card lives longer:
 * - `once`: a one-shot grant for `(chatId, port)`. It is consumed by exactly one
 *   call (a parked waiter, or the retry after `pending`) and never persisted;
 * - `deny`: the agent gets `expose-denied-user`;
 * - silence: the card expires after `timeoutMs` (`expose-consent-timeout`). A deny or
 *   timeout that no call was waiting for is reported once to the next call.
 * Consent never bypasses the hard blocks (denylist, range, loopback-only): the
 * service re-checks them on the call that spends the grant.
 */

export const EXPOSE_CONSENT_TIMEOUT_MS = 600_000;
export const EXPOSE_CONSENT_WAIT_MS = Math.min(25_000, Math.max(1, Number(process.env.CRETLI_PORT_EXPOSE_CONSENT_WAIT_MS) || 20_000));
export const EXPOSE_CONSENT_DECISIONS = Object.freeze(['once', 'deny']);
export const MAX_PENDING_PER_CHAT = 5;

/**
 * @param {{
 *   timeoutMs?: number,
 *   waitMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   now?: () => number,
 *   onChange?: (event: { chatId: string }) => void,
 *   onCreate?: (event: { chatId: string, id: string, port: number }) => void,
 *   idFactory?: () => string,
 * }} [options]
 */
export function createExposeConsentRegistry(options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : EXPOSE_CONSENT_TIMEOUT_MS;
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : EXPOSE_CONSENT_WAIT_MS;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const now = options.now || (() => Date.now());
  let counter = 0;
  const nextId = options.idFactory || (() => `pe-${now().toString(36)}-${(counter += 1).toString(36)}`);

  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {Set<string>} `${chatId}:${port}` grants not yet spent */
  const grants = new Set();
  /** @type {Map<string, 'deny'|'timeout'>} refusals nobody was waiting for; reported once to the retry */
  const missed = new Map();
  const grantKey = (chatId, port) => `${chatId}:${port}`;

  function notify(chatId) {
    try { options.onChange?.({ chatId }); } catch { /* A broken live push must never fail a tool call. */ }
  }

  function settle(entry, outcome) {
    if (!pending.delete(entry.id)) return;
    clearTimeoutFn(entry.timer);
    const key = grantKey(entry.chatId, entry.port);
    if (outcome === 'once') {
      // Exactly one parked waiter spends the grant; the others retry. With no
      // waiter left the grant stays for the retry after `pending`.
      grants.add(key);
      const [first, ...rest] = entry.waiters;
      if (first) {
        grants.delete(key);
        first('once');
        for (const waiter of rest) waiter('pending');
      }
    } else {
      // A refusal nobody is waiting for is kept for the retry, so the agent learns about it
      // instead of re-asking the user who just said no (or never answered).
      if (!entry.waiters.length && !entry.cleared) missed.set(key, outcome);
      for (const waiter of entry.waiters) waiter(outcome);
    }
    notify(entry.chatId);
  }

  function waitFor(entry) {
    return new Promise((resolve) => {
      const waiter = (outcome) => { clearTimeoutFn(timer); resolve(outcome); };
      entry.waiters.push(waiter);
      const timer = setTimeoutFn(() => {
        entry.waiters = entry.waiters.filter((candidate) => candidate !== waiter);
        resolve('pending');
      }, waitMs);
      timer?.unref?.();
    });
  }

  return {
    /**
     * Parks until the user answers. Concurrent requests for the same chat and
     * port share one card.
     * @param {{ chatId: string, port: number, ttlMs?: number, reason?: string }} input
     * @returns {Promise<'once'|'deny'|'timeout'|'pending'|'limit'>}
     */
    request(input) {
      const chatId = String(input?.chatId || '').trim();
      const port = Number(input?.port);
      if (!chatId || !Number.isInteger(port)) return Promise.resolve('deny');
      const key = grantKey(chatId, port);
      if (grants.delete(key)) return Promise.resolve('once');
      const refused = missed.get(key);
      if (refused) {
        missed.delete(key);
        return Promise.resolve(refused);
      }
      for (const entry of pending.values()) {
        if (entry.chatId === chatId && entry.port === port) return waitFor(entry);
      }
      const inChat = [...pending.values()].filter((entry) => entry.chatId === chatId).length;
      if (inChat >= MAX_PENDING_PER_CHAT) return Promise.resolve('limit');
      const entry = {
        id: nextId(),
        chatId,
        port,
        ttlMs: Number(input?.ttlMs) > 0 ? Number(input.ttlMs) : null,
        reason: String(input?.reason || '').slice(0, 300),
        createdAt: now(),
        expiresAt: now() + timeoutMs,
        waiters: [],
        timer: null,
      };
      entry.timer = setTimeoutFn(() => settle(entry, 'timeout'), timeoutMs);
      entry.timer?.unref?.();
      pending.set(entry.id, entry);
      notify(chatId);
      try { options.onCreate?.({ chatId, id: entry.id, port }); } catch { /* Push is best effort. */ }
      return waitFor(entry);
    },

    /**
     * @param {string} id
     * @param {string} decision once | deny
     * @param {{ chatId?: string }} [scope] when given, the card must belong to that chat
     * @returns {{ ok: boolean, code?: string, port?: number }}
     */
    resolve(id, decision, scope = {}) {
      const entry = pending.get(String(id || ''));
      if (!entry) return { ok: false, code: 'not-found' };
      if (scope.chatId && scope.chatId !== entry.chatId) return { ok: false, code: 'forbidden-chat' };
      if (!EXPOSE_CONSENT_DECISIONS.includes(decision)) return { ok: false, code: 'invalid-decision' };
      settle(entry, decision);
      return { ok: true, port: entry.port };
    },

    /** @param {string} chatId */
    list(chatId) {
      const id = String(chatId || '').trim();
      return [...pending.values()]
        .filter((entry) => entry.chatId === id)
        .map(({ id: cardId, chatId: owner, port, ttlMs, reason, createdAt, expiresAt }) => ({
          id: cardId, chatId: owner, port, ttlMs, reason, createdAt, expiresAt,
        }));
    },

    /** @param {string} chatId @param {number} port */
    hasOnceGrant(chatId, port) {
      return grants.has(grantKey(String(chatId || ''), Number(port)));
    },

    /** Drops grants and denies the cards of a chat (it was archived); nothing is remembered for a retry. */
    clearChat(chatId) {
      const id = String(chatId || '').trim();
      for (const key of [...grants, ...missed.keys()]) {
        if (key.startsWith(`${id}:`)) { grants.delete(key); missed.delete(key); }
      }
      for (const entry of [...pending.values()]) {
        if (entry.chatId !== id) continue;
        entry.cleared = true;
        settle(entry, 'deny');
      }
    },
  };
}
