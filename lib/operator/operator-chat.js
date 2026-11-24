/**
 * The single owner thread of the internal operator.
 *
 * The thread is only a view (notices appended by the host); every run executes
 * in its own hidden chat. Identity: `operatorChat: true` on the row (set only
 * by this module) and the id stored in `operator_meta.internal_operator_chat_id`.
 *
 * `ensureOperatorChat` is idempotent and safe to call concurrently:
 *   1. stored id and the row exists -> use it;
 *   2. stored id but the row is gone (owner deleted it, crash between the
 *      reservation and the creation) -> recreate under the SAME id;
 *   3. no stored id -> adopt a surviving `operatorChat` row, else reserve a new
 *      id durably first and then create the row.
 * The reservation is written before the row so a crash in the window between
 * the two converges on the same id on the next call.
 */

import { randomUUID } from 'node:crypto';
import { addChatAsync, getChatByIdAsync, loadChatsAsync } from '../persist/chats-persist.js';
import { appendChatNotice } from '../persist/chat-history-service.js';
import { getMeta, openOperatorStore, setMeta } from './operator-internal-store.js';

export const OPERATOR_CHAT_META_KEY = 'internal_operator_chat_id';
export const OPERATOR_CHAT_TITLE = 'Operator';

/** @typedef {{ ok: true, chatId: string, created: boolean, chat: Record<string, any> } | { ok: false, reason: string, error?: string }} OperatorChatResult */

/** @type {Map<string, Promise<OperatorChatResult>>} one in-flight resolution per journal file */
const inFlight = new Map();

/** @param {Record<string, any>} options */
const inFlightKey = (options) => String(options.file || options.dataDir || '');

/** @param {unknown} chat @returns {boolean} */
export function isOperatorOwnerChat(chat) {
  return Boolean(chat && typeof chat === 'object' && /** @type {any} */ (chat).operatorChat === true);
}

/**
 * Read the stored id, or reserve a fresh one atomically (INSERT OR IGNORE then read back).
 *
 * @param {Record<string, any>} storeOptions
 * @param {string} [adoptId] id of a surviving row to adopt instead of a new id
 * @returns {string}
 */
function readOrReserveId(storeOptions, adoptId) {
  const db = openOperatorStore(storeOptions);
  try {
    db.prepare('INSERT OR IGNORE INTO operator_meta(key, value) VALUES (?, ?)').run(OPERATOR_CHAT_META_KEY, adoptId || randomUUID());
    return getMeta(db, OPERATOR_CHAT_META_KEY);
  } finally { db.close(); }
}

/**
 * @param {{ dataDir?: string, file?: string, workspaceFolder?: string, deps?: Record<string, any> }} [options]
 *   `deps` injects `getChatById`, `loadChats`, `addChat` (tests).
 * @returns {Promise<OperatorChatResult>}
 */
export function ensureOperatorChat(options = {}) {
  const key = inFlightKey(options);
  const running = inFlight.get(key);
  if (running) return running;
  const run = ensureNow(options).finally(() => { if (inFlight.get(key) === run) inFlight.delete(key); });
  inFlight.set(key, run);
  return run;
}

/**
 * @param {{ dataDir?: string, file?: string, workspaceFolder?: string, deps?: Record<string, any> }} options
 * @returns {Promise<OperatorChatResult>}
 */
async function ensureNow(options) {
  const deps = options.deps || {};
  const getById = deps.getChatById || getChatByIdAsync;
  const loadAll = deps.loadChats || loadChatsAsync;
  const addChat = deps.addChat || addChatAsync;
  const storeOptions = { dataDir: options.dataDir, file: options.file };
  try {
    const db = openOperatorStore(storeOptions);
    let storedId;
    try { storedId = getMeta(db, OPERATOR_CHAT_META_KEY); } finally { db.close(); }
    if (storedId) {
      const row = await getById(storedId);
      if (row && isOperatorOwnerChat(row)) return { ok: true, chatId: storedId, created: false, chat: row };
    }
    let id = storedId;
    if (!id) {
      const survivor = (await loadAll()).find((chat) => isOperatorOwnerChat(chat));
      id = readOrReserveId(storeOptions, survivor?.id);
      if (survivor && survivor.id === id) return { ok: true, chatId: id, created: false, chat: survivor };
    }
    // Reserved (or stored) id without a row: create it under that id.
    const created = await addChat(randomUUID(), OPERATOR_CHAT_TITLE, null, options.workspaceFolder || process.cwd(), undefined, {
      id,
      operatorChat: true,
      agentTransport: 'sdk',
      sdkMode: 'plan',
    });
    if (!created?.id) return { ok: false, reason: 'create_failed' };
    return { ok: true, chatId: created.id, created: true, chat: created };
  } catch (error) {
    return { ok: false, reason: 'create_failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Append a host notice to the owner thread (creating the thread when needed).
 * Never throws: a notice must not break a run or the scheduler.
 *
 * @param {{ text: string, level?: string, runId?: string, kind?: string }} notice
 * @param {{ dataDir?: string, file?: string, deps?: Record<string, any> }} [options] `deps.appendNotice` injects the writer (tests)
 * @returns {Promise<{ ok: boolean, reason?: string, chatId?: string }>}
 */
export async function appendOperatorOwnerNotice(notice, options = {}) {
  try {
    const ensured = await ensureOperatorChat(options);
    if (ensured.ok === false) return { ok: false, reason: ensured.reason };
    const append = options.deps?.appendNotice || appendChatNotice;
    await append(ensured.chatId, String(notice.text || ''), {
      variant: 'operator',
      ...(notice.level ? { level: notice.level } : {}),
      ...(notice.runId ? { runId: notice.runId } : {}),
      ...(notice.kind ? { kind: notice.kind } : {}),
    });
    return { ok: true, chatId: ensured.chatId };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
