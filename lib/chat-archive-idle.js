import { probeChatRunLiveness } from './chat-run-service.js';
import { listRuns } from './recovery/recovery-store.ts';

/**
 * Archive-specific idle evidence for one synchronous sweep. A cold chat has no
 * room after restart; it can be archived only if the adapter is available and
 * the durable registry has no unfinished or recoverable run for it. Keep the
 * general liveness probe strict: cycle/recovery callers need terminal evidence.
 */
export function createChatArchiveIdleProbe(options = {}) {
  const probe = options.probeChatRunLiveness || probeChatRunLiveness;
  const readRuns = options.listRuns || listRuns;
  let blockedIds;
  let readFailed = false;

  return (input) => {
    const live = probe(input);
    if (live.known) return live.busy === false;
    if (live.reason !== 'state_missing' || input?.runId) return false;
    const id = String(input?.chat?.id || input?.chatId || '').trim();
    if (!id || readFailed) return false;
    if (!blockedIds) {
      blockedIds = new Set();
      try {
        // Read once per sweep rather than querying every cold chat. Include
        // interrupted/unknown runs: they may still be resumed by recovery.
        for (const state of ['starting', 'running', 'waiting', 'recovering', 'unknown', 'interrupted']) {
          for (let offset = 0; ; offset += 1000) {
            const rows = readRuns({ state, limit: 1000, offset });
            if (!Array.isArray(rows)) throw new TypeError('Invalid recovery run list');
            for (const row of rows) blockedIds.add(String(row.chatId || '').trim());
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
