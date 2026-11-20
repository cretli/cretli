/**
 * Sidebar presence for persisted recovery runs (leaf R13).
 *
 * `summarizeChatRunStates` normally derives presence from the in-memory run
 * service and delegation rows. After a restart those are gone, while the
 * recovery registry still knows that an ordinary chat was interrupted. This
 * module contributes that server-owned state so the sidebar can render
 * "Interrupted after restart" / "Resuming" / "Waiting" / "Unknown" without a
 * live WebSocket push. The registry is read-only here.
 */

import { getRunsFingerprint, listRuns } from './recovery-store.ts';

/** Recovery states that deserve a sidebar row. */
/** Page size for the per-state presence scan (listRuns caps a page at 1000). */
const PRESENCE_PAGE = 1000;

export const RECOVERY_PRESENCE_STATES = Object.freeze([
  'interrupted',
  'recovering',
  'unknown',
  'waiting',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * @param {object} run
 * @returns {number}
 */
function runTimestamp(run: Record<string, any>): number {
  const updated = Date.parse(String(run?.updatedAt || ''));
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(String(run?.createdAt || ''));
  return Number.isFinite(created) ? created : 0;
}

/**
 * Newest run per (chat, presence state) over all chats. The scan result is
 * cached per store and reused while `getRunsFingerprint` is unchanged, so a
 * presence flush costs one aggregate query instead of up to four paged
 * `listRuns` scans with JSON parsing.
 */
const scanCache = new WeakMap<object, { fingerprint: string, runs: Record<string, any>[] }>();
const DEFAULT_SCAN_KEY = {};

export function scanPresenceRuns(store?: Record<string, any>): Record<string, any>[] {
  const key = store && typeof store === 'object' ? store : DEFAULT_SCAN_KEY;
  const fingerprint = getRunsFingerprint(store as any);
  const cached = scanCache.get(key);
  if (cached && cached.fingerprint === fingerprint) return cached.runs;
  const runs: Record<string, any>[] = [];
  // One paged query per state, newest first; the first row seen per (chat,
  // state) is that chat's newest in the state. Rows in these states are few.
  for (const state of RECOVERY_PRESENCE_STATES) {
    const seen = new Set<string>();
    for (let offset = 0; ; offset += PRESENCE_PAGE) {
      const page = listRuns({ state, order: 'desc', limit: PRESENCE_PAGE, offset }, store as any);
      for (const run of page) {
        const chatId = text(run?.chatId);
        if (!chatId || seen.has(chatId)) continue;
        seen.add(chatId);
        runs.push(run);
      }
      if (page.length < PRESENCE_PAGE) break;
    }
  }
  scanCache.set(key, { fingerprint, runs });
  return runs;
}

/**
 * Latest UI-relevant recovery run per chat. Missing/unopened store is a normal
 * state (tests, early boot) and yields an empty map instead of an error.
 *
 * The chat filter runs in the store query, before the cap, so a busy global
 * recovery state can never hide the target chat. `order: 'desc'` keeps the
 * newest row first even for a chat with many historical runs.
 *
 * @param {string[] | null | undefined} chatIds
 * @param {object} [store]
 * @returns {Record<string, object>}
 */
export function buildRecoveryPresenceMap(chatIds: string[] | null | undefined, store?: Record<string, any>): Record<string, Record<string, any>> {
  const wanted = [...new Set((Array.isArray(chatIds) ? chatIds : []).map(text).filter(Boolean))];
  if (wanted.length === 0) return {};
  const wantedSet = new Set(wanted);
  let runs: Record<string, any>[] = [];
  try {
    runs = scanPresenceRuns(store).filter((run) => wantedSet.has(text(run?.chatId)));
  } catch {
    return {};
  }
  const out: Record<string, Record<string, any>> = {};
  for (const run of runs) {
    const chatId = text(run?.chatId);
    if (!chatId || !wantedSet.has(chatId)) continue;
    const previous = out[chatId];
    if (!previous || runTimestamp(run) >= runTimestamp(previous)) out[chatId] = run;
  }
  return out;
}
