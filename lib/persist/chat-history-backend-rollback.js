/**
 * Rollback-aware READ-ONLY backend of the async history adapter (stage 2a).
 *
 * It opens a rollback export produced by `lib/storage/history-rollback.js`
 * (legacy `legacy-chat-history/*.json` + `rollback-control/` sidecars), refuses
 * to serve until the export and the control actions are verified, answers every
 * read from the strictly parsed legacy documents and answers receipt/dedupe
 * lookups from the exported ledger. EVERY write is refused with
 * `history_rollback_read_only`.
 *
 * Why read-only is the certified rollback mode: plain legacy code has no
 * notion of dataset generation, producer, receipt or fencing epoch, so a
 * writable legacy backend after new ACKs would need a crash-safe atomic ledger
 * plus JSON publishing plus fencing, which does not exist. A best-effort
 * cross-store write would silently lose or duplicate acknowledged data, so this
 * backend never writes; the operator's rollback keeps every confirmed event
 * readable and the new-version data intact, and writing resumes only through
 * the SQLite backend (docs/storage-history-migration.md, "Rollback").
 *
 * Verification is synchronous startup work in an emergency mode (it re-reads
 * and hashes the export); it is not a request-path operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { verifyRollbackExport, ROLLBACK_CONTROL_DIR, ROLLBACK_CONTROL_FILE, ROLLBACK_LEGACY_DIR, ROLLBACK_MANIFEST_FILE } from '../storage/history-rollback.js';
import { readLegacyHistoryFile } from '../storage/history-legacy-format.js';
import { HistoryMigrationError } from '../storage/history-legacy-format.js';
import { extendHistorySliceToStreamBoundary } from '../sdk/sdk-history-stream-coalesce.ts';
import { extendHistorySliceToTurnStart } from '../sdk/sdk-history-turn-window.ts';
import { summarizeChatHistoryUsage } from './chat-history-usage.js';
import { HISTORY_PULL_MAX_LIMIT, HISTORY_TAIL_DEFAULT_LIMIT, clampPullLimit, isValidChatId } from './chat-history-adapter.js';
import { refuseHistory } from './chat-history-errors.js';

/**
 * @param {string} operation
 * @returns {never}
 */
function readOnly(operation) {
  return refuseHistory('history_rollback_read_only', 'The history store is in rollback read-only mode; every write is refused', { operation });
}

/**
 * @param {{
 *   exportDir: string,
 *   storeDir?: string,
 *   expectedManifestHash?: string,
 *   controlState?: { readHwm: () => number, readRestorePause: () => boolean },
 *   allowUnverifiedControl?: boolean,
 * }} options `controlState` is the coordinator (or any object with the same two reads); without it, or with a
 *   failing check, the backend refuses to start unless `allowUnverifiedControl` (diagnostic use only).
 */
export function createRollbackReadOnlyHistoryBackend(options) {
  const { exportDir } = options;
  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const checks = [];
  let verified;
  try {
    verified = verifyRollbackExport({ exportDir, storeDir: options.storeDir });
    checks.push({ name: 'export_verified', ok: true, detail: `${verified.chats} chats, ${verified.events} events` });
  } catch (error) {
    if (error instanceof HistoryMigrationError) {
      refuseHistory('history_rollback_not_verified', 'The rollback export failed verification', { code: error.code });
    }
    throw error;
  }
  if (options.expectedManifestHash !== undefined) {
    const ok = options.expectedManifestHash === verified.manifestHash;
    checks.push({ name: 'manifest_matches_marker', ok, detail: ok ? 'manifest hash equals the control marker' : 'manifest hash differs from the control marker' });
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, ROLLBACK_MANIFEST_FILE), 'utf8'));
  const control = JSON.parse(fs.readFileSync(path.join(exportDir, ROLLBACK_CONTROL_DIR, ROLLBACK_CONTROL_FILE), 'utf8'));
  if (options.controlState) {
    const hwm = options.controlState.readHwm();
    checks.push({ name: 'fence_raised', ok: hwm >= control.requiredMinimumFenceEpoch, detail: `fencing high-water mark ${hwm}, required at least ${control.requiredMinimumFenceEpoch}` });
    checks.push({ name: 'restore_pause_marker', ok: options.controlState.readRestorePause() === true, detail: 'new-store writers must stay paused while the export is served' });
  } else {
    checks.push({ name: 'control_state_available', ok: false, detail: 'no coordinator control state was provided to confirm fencing and the pause marker' });
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0 && options.allowUnverifiedControl !== true) {
    refuseHistory('history_rollback_not_verified', 'Rollback control actions are not confirmed; reads stay disabled', { failed: failed.map((check) => check.name).join(',') });
  }
  const generations = new Set(control.datasetGenerations);
  const chatFiles = new Map(manifest.chats.map((chat) => [chat.chatId, path.join(exportDir, ROLLBACK_LEGACY_DIR, `${chat.chatId}.json`)]));

  /** @param {string} chatId @returns {import('../storage/history-legacy-format.js').LegacyHistoryDocument | null} */
  function readDoc(chatId) {
    const file = chatFiles.get(chatId);
    if (!file) return null;
    return readLegacyHistoryFile(file, { expectedChatId: chatId }).doc;
  }

  /** @param {import('../storage/history-legacy-format.js').LegacyHistoryDocument} doc */
  const eventsOf = (doc) => doc.events.map((event) => ({ seq: event.seq, rec: event.rec }));

  /**
   * Stream a JSONL control sidecar; the callback returns true to stop.
   * @param {string} name @param {(row: Record<string, any>) => boolean} visit
   */
  async function scan(name, visit) {
    const lines = readline.createInterface({ input: fs.createReadStream(path.join(exportDir, ROLLBACK_CONTROL_DIR, name), { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line && visit(JSON.parse(line))) return;
      }
    } finally {
      lines.close();
    }
  }

  const refuseWrite = (operation) => async () => readOnly(operation);

  return {
    appendChatHistoryEvents: refuseWrite('appendChatHistoryEvents'),
    appendChatNotice: refuseWrite('appendChatNotice'),
    copyChatHistory: refuseWrite('copyChatHistory'),
    copyChatHistoryUntil: refuseWrite('copyChatHistoryUntil'),
    deleteChatHistory: refuseWrite('deleteChatHistory'),
    async loadChatHistory(chatId) {
      const doc = readDoc(chatId);
      if (!doc) return null;
      const events = eventsOf(doc);
      return { v: 1, chatId: doc.chatId, cursorSessionId: doc.cursorSessionId, headSeq: doc.headSeq, updatedAt: doc.updatedAt, events, usageSummary: summarizeChatHistoryUsage(events) };
    },
    async getChatHistorySince(chatId, sinceSeq = 0, limit = 1000) {
      const doc = readDoc(chatId);
      if (!doc) return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], hasMore: false };
      const since = Math.max(0, Number(sinceSeq) || 0);
      const tail = eventsOf(doc).filter((event) => event.seq > since);
      const slice = tail.slice(0, clampPullLimit(limit));
      return { ok: true, chatId: doc.chatId, cursorSessionId: doc.cursorSessionId, headSeq: doc.headSeq, events: slice, hasMore: tail.length > slice.length };
    },
    async getChatHistoryEvent(chatId, seq) {
      const wanted = Number(seq);
      const doc = readDoc(chatId);
      const empty = { ok: true, chatId, headSeq: 0, event: null, events: [] };
      if (!Number.isInteger(wanted) || wanted <= 0 || !doc) return empty;
      const event = eventsOf(doc).find((row) => row.seq === wanted) ?? null;
      return { ok: true, chatId: doc.chatId, headSeq: doc.headSeq, event, events: event ? [event] : [] };
    },
    async getChatHistoryPage(chatId, pageOptions = {}) {
      const doc = readDoc(chatId);
      if (!doc) return { ok: true, chatId, cursorSessionId: '', headSeq: 0, events: [], oldestSeq: 0, hasOlder: false };
      const all = eventsOf(doc);
      const beforeSeq = Math.max(0, Number(pageOptions.beforeSeq) || 0);
      const lim = Math.min(HISTORY_PULL_MAX_LIMIT, Math.max(1, Number(pageOptions.limit) || HISTORY_TAIL_DEFAULT_LIMIT));
      const pool = beforeSeq > 0 ? all.filter((event) => event.seq < beforeSeq) : all;
      const bounded = extendHistorySliceToStreamBoundary(pool, pool.slice(-lim), HISTORY_PULL_MAX_LIMIT);
      const slice = extendHistorySliceToTurnStart(pool, bounded, HISTORY_PULL_MAX_LIMIT);
      const oldestSeq = all.length > 0 ? all[0].seq : 0;
      return { ok: true, chatId: doc.chatId, cursorSessionId: doc.cursorSessionId, headSeq: doc.headSeq, events: slice, oldestSeq, hasOlder: slice.length > 0 && slice[0].seq > oldestSeq };
    },
    async listChatHistoryHeadSeqs() {
      /** @type {Record<string, { headSeq: number, updatedAt: string }>} */
      const out = {};
      for (const chatId of chatFiles.keys()) {
        const doc = readDoc(chatId);
        if (doc) out[chatId] = { headSeq: doc.headSeq, updatedAt: doc.updatedAt || '' };
      }
      return out;
    },
    async getChatHistoryUsage(chatId) {
      const doc = readDoc(chatId);
      return doc ? { usageSummary: summarizeChatHistoryUsage(eventsOf(doc)), headSeq: doc.headSeq, eventCount: eventsOf(doc).length, updatedAt: doc.updatedAt } : { usageSummary: summarizeChatHistoryUsage([]), headSeq: 0 };
    },
    /**
     * Answer "did this command commit?" from the exported receipt ledger. Only
     * `outcome: 'committed'` (same generation, and the same digest when one is
     * given) is an ACK. A receipt that exists only under ANOTHER generation, or
     * a caller generation the export does not know, is `stale_generation` and
     * never acknowledges the command.
     *
     * @param {{ datasetGeneration: string, commandId: string, requestDigest?: string }} args
     */
    async lookupReceipt({ datasetGeneration, commandId, requestDigest }) {
      if (!generations.has(datasetGeneration)) return { outcome: 'stale_generation', ack: false };
      /** @type {Record<string, any> | null} */
      let sameGeneration = null;
      let otherGeneration = false;
      await scan('receipts.jsonl', (row) => {
        if (row.commandId !== commandId) return false;
        if (row.datasetGeneration === datasetGeneration) {
          sameGeneration = row;
          return true;
        }
        otherGeneration = true;
        return false;
      });
      if (sameGeneration) {
        if (requestDigest !== undefined && /** @type {any} */ (sameGeneration).requestDigest !== requestDigest) return { outcome: 'digest_mismatch', ack: false };
        return { outcome: 'committed', ack: true, result: /** @type {any} */ (sameGeneration).result };
      }
      return { outcome: otherGeneration ? 'stale_generation' : 'not_found', ack: false };
    },
    /**
     * Was this producer-scoped input already accepted? (Browser queue replay
     * after a rollback; the answer comes from the exported dedupe ledger.)
     * @param {{ datasetGeneration: string, chatId: string, producerId: string, clientSeq: number }} args
     */
    async lookupInput({ datasetGeneration, chatId, producerId, clientSeq }) {
      if (!generations.has(datasetGeneration)) return { found: false, stale: true };
      let hit = null;
      await scan('dedupe.jsonl', (row) => {
        if (row.datasetGeneration === datasetGeneration && row.chatId === chatId && row.producerId === producerId && row.clientSeq === clientSeq) {
          hit = row;
          return true;
        }
        return false;
      });
      return hit ? { found: true, seq: /** @type {any} */ (hit).eventSeq, requestDigest: /** @type {any} */ (hit).requestDigest } : { found: false, stale: false };
    },
    diagnose() {
      return {
        backend: 'rollback-readonly', writable: false, plainLegacyBinaryCompatible: control.plainLegacyBinaryCompatible === true,
        manifestHash: verified.manifestHash, datasetGenerations: [...generations], requiredMinimumFenceEpoch: control.requiredMinimumFenceEpoch,
        checks, chats: manifest.chats.length,
      };
    },
    isValidChatId,
  };
}
