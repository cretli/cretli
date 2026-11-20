import { randomUUID } from 'node:crypto';
import { broadcastBrowserConsentChanged } from '../chat-list-updates.js';

/** Explicit Chrome access belongs to one execution, never to a disconnected UI socket. */
export function createChromeAccessRegistry({ timeoutMs = 600_000, waitMs = 25_000, now = Date.now, onChange = broadcastBrowserConsentChanged } = {}) {
  const entries = new Map();

  function notify(entry) {
    try { onChange({ chatId: entry.chatId }); } catch { /* A missed push is recovered by the global queue. */ }
  }

  function settle(entry, decision, ownerSessionId = '') {
    entry.decision = decision;
    entry.ownerSessionId = ownerSessionId;
    for (const finish of entry.waiters) finish({ decision, ownerSessionId });
    entry.waiters.clear();
    notify(entry);
  }

  function prune() {
    for (const [key, entry] of entries) {
      if (entry.expiresAt > now() && entry.isCurrent()) continue;
      entries.delete(key);
      if (entry.decision === 'pending') settle(entry, 'timeout');
    }
  }

  return {
    request(key, chatId, isCurrent = () => true) {
      prune();
      let entry = entries.get(key);
      if (!entry) {
        if (entries.size >= 2000) return Promise.resolve({ decision: 'limit', ownerSessionId: '' });
        entry = { id: randomUUID(), chatId, expiresAt: now() + timeoutMs,
          decision: 'pending', ownerSessionId: '', waiters: new Set(), isCurrent };
        entries.set(key, entry);
        notify(entry);
      }
      if (entry.decision !== 'pending') return Promise.resolve({ decision: entry.decision, ownerSessionId: entry.ownerSessionId });
      return new Promise((resolve) => {
        const finish = (result) => { clearTimeout(timer); entry.waiters.delete(finish); resolve(result); };
        const timer = setTimeout(() => finish({ decision: 'pending', ownerSessionId: '' }), waitMs);
        timer.unref?.();
        entry.waiters.add(finish);
      });
    },
    get(key) {
      prune();
      const entry = entries.get(key);
      if (entry?.decision === 'allow') entry.expiresAt = now() + timeoutMs;
      return entry && entry.decision !== 'pending' ? { decision: entry.decision, ownerSessionId: entry.ownerSessionId } : null;
    },
    list() {
      prune();
      return [...entries.values()].filter((entry) => entry.decision === 'pending')
        .map(({ id, chatId, expiresAt }) => ({ id, chatId, expiresAt, kind: 'chrome' }));
    },
    revoke(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entries.delete(key);
      if (entry.decision === 'pending') settle(entry, 'deny');
    },
    resolve(id, decision, chatId, ownerSessionId) {
      prune();
      const entry = [...entries.values()].find((row) => row.id === id && row.chatId === chatId);
      if (!entry || entry.decision !== 'pending') return { ok: false, code: 'not-found' };
      if (!['allow', 'deny'].includes(decision)) return { ok: false, code: 'invalid-decision' };
      settle(entry, decision, decision === 'allow' ? ownerSessionId : '');
      return { ok: true };
    },
  };
}

export const chromeAccess = createChromeAccessRegistry();
