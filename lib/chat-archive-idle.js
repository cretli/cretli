import { probeChatRunLiveness } from './chat-run-service.js';
import { getRunsFingerprint, listRuns } from './recovery/recovery-store.ts';

/**
 * Archive-specific idle evidence for one synchronous sweep. A cold chat has no
 * room after restart; it can be archived only if the adapter is available and
 * the durable registry has no unfinished or recoverable run for it. Keep the
 * general liveness probe strict: cycle/recovery callers need terminal evidence.
 *
 * `staleRunMs` bounds how long a registry row may keep a cold chat visible. A run
 * that was created longer ago than that and whose chat has no in-memory room is a
 * ghost (the run finished but its row was never closed), and boot reprobes keep
 * such rows `running` forever. `waiting` and `recovering` rows (a pending human
 * answer, a held resume claim) always block regardless of age.
 */
export function createChatArchiveIdleProbe(options = {}) {
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const readRuns = options.listRuns || listRuns;
  const readFingerprint = options.getRunsFingerprint || getRunsFingerprint;
  const staleRunMs = Number.isFinite(options.staleRunMs) && options.staleRunMs > 0 ? Number(options.staleRunMs) : 0;
  let blockedIds;
  let blockedFingerprint;
  let readFailed = false;

  // Cheap registry version (one aggregate query). A probe can be shared across awaits (one per sweep), so a
  // run created or transitioned in between must invalidate the cached index; an unreadable marker forces a rebuild.
  // Memoized for a short TTL: a sweep over ~10k cold chats would otherwise run the aggregate query once per chat.
  const ttlMs = Number.isFinite(options.fingerprintTtlMs) ? Number(options.fingerprintTtlMs) : 0;
  const clock = options.nowMs || Date.now;
  let memo;
  let memoAt = -Infinity;
  let memoValid = false;
  const currentFingerprint = () => {
    const at = clock();
    if (memoValid && ((ttlMs > 0 && at - memoAt < ttlMs && at >= memoAt) || options.fingerprintPerTick === true)) return memo;
    try { memo = String(readFingerprint()); } catch { memo = undefined; }
    memoAt = at;
    memoValid = true;
    // Per-tick mode: valid only until the next await, so a run begun while the sweep awaits is still seen.
    if (options.fingerprintPerTick === true) queueMicrotask(() => { memoValid = false; });
    return memo;
  };

  const isGhostRun = (row) => {
    if (!staleRunMs || row.state === 'waiting' || row.state === 'recovering') return false;
    const createdMs = Date.parse(String(row.createdAt || ''));
    // An unparseable timestamp stays blocking (fail closed).
    return Number.isFinite(createdMs) && clock() - createdMs > staleRunMs;
  };

  return (input) => {
    const live = probe(input);
    if (live.known) return live.busy === false;
    if (live.reason !== 'state_missing' || input?.runId) return false;
    const id = String(input?.chat?.id || input?.chatId || '').trim();
    if (!id || readFailed) return false;
    const fingerprint = currentFingerprint();
    if (blockedIds && (fingerprint === undefined || fingerprint !== blockedFingerprint)) blockedIds = undefined;
    if (!blockedIds) {
      blockedFingerprint = fingerprint;
      blockedIds = new Set();
      try {
        // Read once per registry version rather than per cold chat. Include
        // interrupted/unknown runs: they may still be resumed by recovery.
        for (const state of ['starting', 'running', 'waiting', 'recovering', 'unknown', 'interrupted']) {
          for (let offset = 0; ; offset += 1000) {
            const rows = readRuns({ state, limit: 1000, offset });
            if (!Array.isArray(rows)) throw new TypeError('Invalid recovery run list');
            for (const row of rows) {
              if (isGhostRun(row)) continue;
              blockedIds.add(String(row.chatId || '').trim());
            }
            if (rows.length < 1000) break;
          }
        }
      } catch {
        readFailed = true;
        return false;
      }
    }
    return !blockedIds.has(id);
  };
}
