import crypto from 'node:crypto';

export const RUN_CONSENT_TIMEOUT_MS = 120_000;
export const UNSANDBOXED_SENTENCE = 'This script runs unsandboxed on the Cretli host with the host user permissions.';

/** Process-only grants bind the device and exact entry-file bytes. */
export function createRunConsentRegistry(options = {}) {
  const grants = new Set(), pending = new Map();
  const schedule = options.setTimeoutFn || setTimeout;
  const cancel = options.clearTimeoutFn || clearTimeout;
  const keyOf = (deviceId, hash) => JSON.stringify([deviceId, hash]);
  const notify = (chatId) => { try { options.onChange?.({ chatId }); } catch { /* Live updates are best effort. */ } };
  function settle(entry, outcome) {
    if (!pending.delete(entry.id)) return;
    cancel(entry.timer);
    if (outcome === 'once') grants.add(keyOf(entry.deviceId, entry.hash));
    entry.finish(outcome);
    notify(entry.chatId);
  }
  return {
    request(input) {
      const key = keyOf(input.deviceId, input.hash);
      if (grants.has(key)) return { approved: true, outcome: Promise.resolve('once') };
      const existing = [...pending.values()].find((e) => e.key === key && e.chatId === (input.chatId || ''));
      if (existing) return existing;
      let finish;
      const outcome = new Promise((resolve) => { finish = resolve; });
      const entry = {
        ...input, chatId: input.chatId || '', key, id: crypto.randomUUID(), outcome, finish,
        text: input.scriptPath + '\nSHA-256: ' + input.hash + '\nDevice: ' + input.deviceName + '\n' + UNSANDBOXED_SENTENCE,
        expiresAt: Date.now() + RUN_CONSENT_TIMEOUT_MS,
      };
      entry.timer = schedule(() => settle(entry, 'timeout'), RUN_CONSENT_TIMEOUT_MS);
      entry.timer?.unref?.();
      pending.set(entry.id, entry);
      notify(entry.chatId);
      return entry;
    },
    resolve(id, decision, { chatId = '' } = {}) {
      const entry = pending.get(id);
      if (!entry) return { ok: false, status: 404, error: 'consent-not-found' };
      if (entry.chatId !== chatId) return { ok: false, status: 403, error: 'forbidden-chat' };
      if (!['once', 'deny'].includes(decision)) return { ok: false, status: 400, error: 'invalid-decision' };
      settle(entry, decision);
      return { ok: true };
    },
    list(chatId = '') {
      return [...pending.values()].filter((e) => e.chatId === chatId)
        .map(({ id, deviceId, deviceName, scriptPath, hash, text, expiresAt, chatId }) => ({ id, deviceId, deviceName, scriptPath, hash, text, expiresAt, chatId }));
    },
  };
}
