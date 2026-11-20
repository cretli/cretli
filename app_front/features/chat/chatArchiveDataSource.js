/**
 * Archive list reads from runtime RAM and chat metadata IDB (task 7.1, schema 5.1).
 *
 * HTTP refresh policy lives in chatListLoadFreshness.js; this module owns how
 * archived rows are discovered for search and archive UI before/after a GET.
 */

import {
  applyIfFresh,
  createSliceSession,
  forEachInTimeSlices,
} from '../../lib/schedulerYield.js';
import { deriveWorkspaceKey } from './chatMetadataIdbSchema.js';

/** IDB-specific fields stripped when projecting a metadata record to a chat row. */
const METADATA_RECORD_STRIP_KEYS = new Set([
  'sessionId',
  'generation',
  'savedAt',
  'workspaceKey',
  'archivedFlag',
  'rankingUpdatedAtMs',
]);

/**
 * @param {unknown} record
 * @returns {object | null}
 */
export function chatRowFromMetadataRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return null;
  /** @type {Record<string, unknown>} */
  const row = {};
  for (const [key, value] of Object.entries(record)) {
    if (METADATA_RECORD_STRIP_KEYS.has(key)) continue;
    row[key] = value;
  }
  row.id = id;
  return row;
}

/**
 * @param {object[] | null | undefined} runtimeChats
 * @returns {object[]}
 */
export function listArchivedRowsFromRuntime(runtimeChats) {
  if (!Array.isArray(runtimeChats)) return [];
  /** @type {object[]} */
  const out = [];
  for (const chat of runtimeChats) {
    if (!chat || typeof chat !== 'object') continue;
    const archivedAt = typeof chat.archivedAt === 'string' ? chat.archivedAt.trim() : '';
    if (!archivedAt) continue;
    out.push(chat);
  }
  return out;
}

/**
 * @param {object} chat
 * @param {string} workspaceKey
 * @returns {boolean}
 */
export function chatMatchesWorkspaceKey(chat, workspaceKey) {
  const key = typeof workspaceKey === 'string' ? workspaceKey : '';
  if (!key) return true;
  return deriveWorkspaceKey(chat) === key;
}

/**
 * Merge RAM archived rows with IDB records; RAM wins on id collision.
 *
 * @param {object[]} runtimeArchived
 * @param {object[]} idbRecords
 * @param {string} [workspaceKey]
 * @returns {object[]}
 */
export function mergeArchiveCatalogRows(runtimeArchived, idbRecords, workspaceKey = '') {
  const byId = new Map();
  for (const record of Array.isArray(idbRecords) ? idbRecords : []) {
    const row = chatRowFromMetadataRecord(record);
    if (!row) continue;
    if (workspaceKey && !chatMatchesWorkspaceKey(row, workspaceKey)) continue;
    byId.set(row.id, row);
  }
  for (const chat of Array.isArray(runtimeArchived) ? runtimeArchived : []) {
    if (!chat?.id) continue;
    if (workspaceKey && !chatMatchesWorkspaceKey(chat, workspaceKey)) continue;
    byId.set(chat.id, chat);
  }
  return [...byId.values()];
}

/**
 * Rows present in the catalog but not yet in the runtime `getChats()` array.
 *
 * @param {object[]} catalogRows
 * @param {Set<string>} runtimeIds
 * @returns {object[]}
 */
export function selectArchiveRowsMissingFromRuntime(catalogRows, runtimeIds) {
  const seen = runtimeIds instanceof Set ? runtimeIds : new Set();
  /** @type {object[]} */
  const missing = [];
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    missing.push(row);
  }
  return missing;
}

/**
 * @param {object} chat
 * @param {string} query
 * @param {string} workspaceName
 * @param {(q: string, item: { title?: string, workspaceName?: string }) => boolean} matchesSearch
 * @returns {boolean}
 */
export function archiveRowMatchesSidebarSearch(chat, query, workspaceName, matchesSearch) {
  if (!matchesSearch(query, { title: chat?.title, workspaceName })) return false;
  return true;
}

/**
 * Time-sliced projection of IDB metadata records to sidebar chat rows.
 *
 * @param {unknown[]} records
 * @param {{
 *   deps?: import('../../lib/schedulerYield.js').SchedulerYieldDeps,
 *   budgetMs?: number,
 *   sliceSession?: ReturnType<typeof createSliceSession>,
 *   isApplyFresh?: () => boolean,
 * }} [options]
 * @returns {Promise<{ rows: object[], cancelled: boolean }>}
 */
export async function projectMetadataRecordsToRows(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return { rows: [], cancelled: false };
  const isApplyFresh = typeof options.isApplyFresh === 'function' ? options.isApplyFresh : () => true;
  if (!isApplyFresh()) return { rows: [], cancelled: true };
  /** @type {object[]} */
  const rows = [];
  const result = await forEachInTimeSlices(list, {
    session: options.sliceSession,
    deps: options.deps,
    budgetMs: options.budgetMs,
    onItem: (record) => {
      if (!isApplyFresh()) return;
      const row = chatRowFromMetadataRecord(record);
      if (row) rows.push(row);
    },
  });
  if (result.cancelled || !isApplyFresh()) {
    return { rows: [], cancelled: true };
  }
  return { rows, cancelled: false };
}

/**
 * Time-sliced merge of archived catalog rows into the live runtime list.
 *
 * @param {object[]} rows
 * @param {(row: object) => void} applyRow
 * @param {{
 *   isRunActive?: () => boolean,
 *   guard?: { isSessionFresh?: () => boolean, isListFresh?: () => boolean, isIdbEpochFresh?: () => boolean },
 *   deps?: import('../../lib/schedulerYield.js').SchedulerYieldDeps,
 *   budgetMs?: number,
 * }} [options]
 * @returns {Promise<{ applied: number, cancelled: boolean }>}
 */
export async function hydrateArchiveRowsIntoRuntime(rows, applyRow, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { applied: 0, cancelled: false };
  const isRunActive = typeof options.isRunActive === 'function' ? options.isRunActive : () => true;
  const guard = options.guard || null;
  const session = options.sliceSession || createSliceSession();
  let applied = 0;
  const result = await forEachInTimeSlices(list, {
    session,
    deps: options.deps,
    budgetMs: options.budgetMs,
    onItem: (row) => {
      if (!isRunActive()) return;
      if (guard) {
        if (guard.isSessionFresh && !guard.isSessionFresh()) return;
        if (guard.isListFresh && !guard.isListFresh()) return;
        if (guard.isIdbEpochFresh && !guard.isIdbEpochFresh()) return;
      }
      const token = session.captureToken();
      const didApply = applyIfFresh(session, token, () => {
        if (!isRunActive()) return;
        if (guard) {
          if (guard.isSessionFresh && !guard.isSessionFresh()) return;
          if (guard.isListFresh && !guard.isListFresh()) return;
          if (guard.isIdbEpochFresh && !guard.isIdbEpochFresh()) return;
        }
        applyRow(row);
      });
      if (didApply) applied += 1;
    },
  });
  const cancelled = result.cancelled
    || !isRunActive()
    || (guard?.isSessionFresh && !guard.isSessionFresh())
    || (guard?.isListFresh && !guard.isListFresh())
    || (guard?.isIdbEpochFresh && !guard.isIdbEpochFresh());
  return { applied, cancelled: Boolean(cancelled) };
}

/**
 * Build the workspace chat pool used for sidebar search (includes archived rows
 * even when the archive section is closed or rows are outside the visible cap).
 *
 * @param {object[]} workspaceChats chats already limited to one workspace group
 * @param {object[] | null | undefined} extraArchivedFromCatalog
 * @returns {object[]}
 */
export function buildWorkspaceSearchChatPool(workspaceChats, extraArchivedFromCatalog) {
  const byId = new Map();
  for (const chat of Array.isArray(workspaceChats) ? workspaceChats : []) {
    if (!chat?.id) continue;
    byId.set(chat.id, chat);
  }
  for (const chat of Array.isArray(extraArchivedFromCatalog) ? extraArchivedFromCatalog : []) {
    if (!chat?.id) continue;
    if (!byId.has(chat.id)) byId.set(chat.id, chat);
  }
  return [...byId.values()];
}
