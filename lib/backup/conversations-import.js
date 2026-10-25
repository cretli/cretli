/**
 * Conversation import (B3): stage -> preview (whole change plan) -> apply.
 *
 * - Staging validates the entire archive (ZIP limits, traversal, checksums, schemas,
 *   reference integrity) before anything is written to chats or history.
 * - The preview is the full change plan: per chat it states whether the import
 *   creates a copy, replays an earlier import, hits a deleted destination, needs an
 *   explicit option-change acknowledgement or matches existing content/lineage.
 * - Apply creates NEW chat IDs, remaps relations/workspace/attachment references and
 *   never copies native harness session IDs. The chat list write is the single commit
 *   point; a durable `pending` journal lets a crash be rolled forward or cleaned up.
 * - A durable receipt per (archive id, archive digest, source chat, options) maps to the
 *   destination chat. Replays return the earlier mapping; a deleted destination is
 *   reported, never silently recreated; a changed digest for a known archive id is a
 *   conflict; copying again is the separate explicit `duplicate` mode.
 *
 * The module performs no process starts, no network access and no push delivery.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDataPath } from '../runtime-paths.js';
import { writeFileDurable } from './durable-write.js';
import {
  ConversationArchiveError,
  RELATION_FIELDS,
  chatContentDigest,
  parseConversationsArchive,
  referencedAttachmentNames,
  rewriteAttachmentRefs,
  sha256Hex,
  DEFAULT_MAX_IMPORT_BYTES,
} from './conversations-archive.js';
import { MAX_HISTORY_EVENTS } from '../persist/chat-history-adapter.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../sdk/sdk-ui-mode.ts';

export const IMPORT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_CAP = 20;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000;
const STAGE_CAP = 10;
const APPLIED_CAP = 500;
const RECEIPT_CAP = 50000;
const STAGE_ID_PATTERN = /^st-[a-z0-9]+-[a-f0-9]{8}$/;
const PATH_FIELD_MAX = 1024;

export class ConversationImportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'ConversationImportError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** @returns {string} */
const receiptsFile = () => resolveDataPath('conversation-import-receipts.json');
/** @returns {string} */
const stagingDir = () => resolveDataPath('backup-staging');

/**
 * @typedef {Object} Receipt
 * @property {string} archiveId
 * @property {string} archiveDigest
 * @property {string} sourceChatId
 * @property {string} optionsHash
 * @property {'import' | 'duplicate'} mode
 * @property {string} destinationChatId
 * @property {string} importedAt
 * @property {string} [duplicateKey] preview id of an explicit duplicate import
 * @property {Record<string, string>} attachments source attachment name -> destination name
 */

/**
 * @typedef {Object} ReceiptState
 * @property {number} v
 * @property {Record<string, { digest: string, firstSeenAt: string }>} archives
 * @property {Receipt[]} receipts
 * @property {Array<{ batchId: string, previewId: string, archiveId: string, archiveDigest: string, startedAt: string, items: Array<Receipt>, uploads: string[] }>} pending
 * @property {Record<string, any>} applied preview id -> result
 */

/** @returns {ReceiptState} */
function emptyState() {
  return { v: 1, archives: {}, receipts: [], pending: [], applied: {} };
}

/**
 * Fails closed: an unreadable receipts file must never be treated as "nothing imported yet",
 * because that would let a retry duplicate history.
 *
 * @returns {ReceiptState}
 */
export function readReceiptState() {
  const file = receiptsFile();
  if (!fs.existsSync(file)) return emptyState();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConversationImportError('RECEIPTS_CORRUPT', `Import receipts are unreadable: ${/** @type {Error} */ (err).message}`, 500);
  }
  if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.receipts) || !Array.isArray(parsed.pending) || typeof parsed.archives !== 'object' || typeof parsed.applied !== 'object') {
    throw new ConversationImportError('RECEIPTS_CORRUPT', 'Import receipts have an unexpected shape', 500);
  }
  return parsed;
}

/** @param {ReceiptState} state */
function writeReceiptState(state) {
  const applied = Object.entries(state.applied);
  if (applied.length > APPLIED_CAP) state.applied = Object.fromEntries(applied.slice(applied.length - APPLIED_CAP));
  if (state.receipts.length > RECEIPT_CAP) state.receipts = state.receipts.slice(state.receipts.length - RECEIPT_CAP);
  writeFileDurable(receiptsFile(), JSON.stringify(state));
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string | undefined}
 */
function optionalPath(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > PATH_FIELD_MAX || value.includes('\0')) {
    throw new ConversationImportError('OPTIONS_INVALID', `${label} must be a string up to ${PATH_FIELD_MAX} characters`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {{ workspaceFile?: string, workspaceFolder?: string }}
 */
function normalizeWorkspaceTarget(value, label) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new ConversationImportError('OPTIONS_INVALID', `${label} must be an object`);
  const workspaceFile = optionalPath(value.workspaceFile, `${label}.workspaceFile`);
  const workspaceFolder = optionalPath(value.workspaceFolder, `${label}.workspaceFolder`);
  return { ...(workspaceFile ? { workspaceFile } : {}), ...(workspaceFolder ? { workspaceFolder } : {}) };
}

/**
 * @param {unknown} raw
 * @param {import('./conversations-archive.js').ParsedConversationsArchive} parsed
 */
export function normalizeImportOptions(raw, parsed) {
  const input = isPlainObject(raw) ? raw : {};
  const known = new Set(parsed.chats.map((row) => row.sourceChatId));
  /** @type {string[] | null} */
  let chatIds = null;
  if (input.chatIds !== undefined && input.chatIds !== null) {
    if (!Array.isArray(input.chatIds) || input.chatIds.length === 0) throw new ConversationImportError('OPTIONS_INVALID', 'chatIds must be a non-empty array');
    chatIds = [...new Set(input.chatIds.map((id) => String(id)))];
    for (const id of chatIds) {
      if (!known.has(id)) throw new ConversationImportError('OPTIONS_INVALID', `Chat is not in the archive: ${id}`);
    }
    chatIds.sort();
  }
  /** @type {Record<string, { workspaceFile?: string, workspaceFolder?: string }>} */
  const workspaceMapping = {};
  if (input.workspaceMapping !== undefined && input.workspaceMapping !== null) {
    if (!isPlainObject(input.workspaceMapping)) throw new ConversationImportError('OPTIONS_INVALID', 'workspaceMapping must be an object');
    const refs = new Set(parsed.workspaces.map((ws) => ws.ref));
    for (const [ref, target] of Object.entries(input.workspaceMapping)) {
      if (!refs.has(ref)) throw new ConversationImportError('OPTIONS_INVALID', `Unknown workspace ref: ${ref}`);
      workspaceMapping[ref] = normalizeWorkspaceTarget(target, `workspaceMapping.${ref}`);
    }
  }
  return {
    chatIds,
    workspaceMapping,
    defaultWorkspace: normalizeWorkspaceTarget(input.defaultWorkspace, 'defaultWorkspace'),
    preserveArchived: input.preserveArchived !== false,
    duplicate: input.duplicate === true,
    acknowledgeOptionChange: input.acknowledgeOptionChange === true,
  };
}

/**
 * Keys that identify "the same conversation" across archives and installations.
 *
 * @param {{ id?: string, sourceChatId?: string, importedFrom?: any, lineage?: Array<{ archiveId: string, sourceChatId: string }> }} chat
 * @returns {Set<string>}
 */
function lineageKeys(chat) {
  const keys = new Set();
  const own = chat.sourceChatId || chat.id;
  if (own) keys.add(`local:${own}`);
  for (const link of chat.lineage || []) {
    keys.add(`${link.archiveId}:${link.sourceChatId}`);
    keys.add(`local:${link.sourceChatId}`);
  }
  const from = chat.importedFrom;
  if (isPlainObject(from) && from.archiveId) {
    keys.add(`${from.archiveId}:${from.sourceChatId}`);
    for (const link of Array.isArray(from.lineage) ? from.lineage : []) {
      keys.add(`${link.archiveId}:${link.sourceChatId}`);
      keys.add(`local:${link.sourceChatId}`);
    }
  }
  return keys;
}

/**
 * @param {ReturnType<typeof normalizeImportOptions>} options
 * @param {any} row
 * @param {import('./conversations-archive.js').ParsedConversationsArchive} parsed
 * @returns {{ workspaceFile?: string, workspaceFolder?: string, resolved: boolean, ref?: string, label?: string }}
 */
function resolveWorkspace(options, row, parsed) {
  const ws = row.workspaceRef ? parsed.workspaces.find((w) => w.ref === row.workspaceRef) : undefined;
  const mapped = row.workspaceRef ? options.workspaceMapping[row.workspaceRef] : undefined;
  const exported = ws ? normalizeWorkspaceTarget({ workspaceFile: ws.workspaceFile, workspaceFolder: ws.workspaceFolder }, 'archive workspace') : {};
  const pick = [mapped, exported, options.defaultWorkspace].find((target) => target && (target.workspaceFile || target.workspaceFolder));
  return { ...(pick || {}), resolved: Boolean(pick), ...(ws ? { ref: ws.ref, label: ws.label } : {}) };
}

/**
 * @param {{ workspaceFile?: string, workspaceFolder?: string }} workspace
 * @param {boolean} preserveArchived
 * @returns {string}
 */
function optionsHashFor(workspace, preserveArchived) {
  return sha256Hex(JSON.stringify({ w: workspace.workspaceFile || '', f: workspace.workspaceFolder || '', a: preserveArchived }));
}

/**
 * @typedef {Object} PlanChat
 * @property {string} sourceChatId
 * @property {string} title
 * @property {'new' | 'duplicate' | 'already_imported' | 'destination_deleted' | 'options_changed' | 'content_match' | 'not_selected'} status
 * @property {boolean} willImport
 * @property {string} optionsHash
 * @property {number} eventCount
 */

/**
 * Computes the complete change plan. Read-only.
 *
 * @param {import('./conversations-archive.js').ParsedConversationsArchive} parsed
 * @param {ReturnType<typeof normalizeImportOptions>} options
 * @param {ReceiptState} state
 * @param {Record<string, any>[]} localChats
 * @param {import('./conversations-store.js').ConversationStore} store
 */
export async function buildImportPlan(parsed, options, state, localChats, store) {
  const known = state.archives[parsed.archiveId];
  if (known && known.digest !== parsed.digest) {
    throw new ConversationImportError('ARCHIVE_DIGEST_CONFLICT', 'An archive with this id was imported before but its content differs. Refusing to import a modified archive under the same identity.', 409, { archiveId: parsed.archiveId });
  }
  const localById = new Map(localChats.map((chat) => [String(/** @type {any} */ (chat).id), chat]));
  const selected = new Set(options.chatIds || parsed.chats.map((row) => row.sourceChatId));
  /** @type {any[]} */
  const chats = [];
  for (const row of parsed.chats) {
    const history = /** @type {NonNullable<ReturnType<typeof parsed.histories.get>>} */ (parsed.histories.get(row.sourceChatId));
    const workspace = resolveWorkspace(options, row, parsed);
    const optionsHash = optionsHashFor(workspace, options.preserveArchived);
    const names = referencedAttachmentNames(history.events);
    const present = names.filter((name) => parsed.attachments.has(name));
    /** @type {any} */
    const entry = {
      sourceChatId: row.sourceChatId,
      title: row.title,
      eventCount: history.events.length,
      optionsHash,
      workspace: { ...(workspace.ref ? { ref: workspace.ref, label: workspace.label } : {}), workspaceFile: workspace.workspaceFile, workspaceFolder: workspace.workspaceFolder, resolved: workspace.resolved || !workspace.ref },
      attachments: { referenced: names.length, included: present.length, missing: names.length - present.length },
      lineage: Array.isArray(row.lineage) ? row.lineage : [],
      archived: Boolean(row.archivedAt),
      warnings: [],
      matches: [],
      previousDestinations: [],
      relations: [],
    };
    if (!selected.has(row.sourceChatId)) {
      chats.push({ ...entry, status: 'not_selected', willImport: false });
      continue;
    }
    if (!workspace.resolved && row.workspaceRef) entry.warnings.push('workspace_unmapped: the chat is imported without a workspace until one is assigned');
    if (entry.attachments.missing > 0) entry.warnings.push(`attachments_missing: ${entry.attachments.missing} referenced attachment(s) are not in the archive and stay as plain text`);

    const found = state.receipts.filter((r) => r.archiveId === parsed.archiveId && r.sourceChatId === row.sourceChatId && r.mode === 'import');
    const same = found.find((r) => r.optionsHash === optionsHash);
    entry.previousDestinations = found.map((r) => ({ destinationChatId: r.destinationChatId, optionsHash: r.optionsHash, exists: localById.has(r.destinationChatId), importedAt: r.importedAt }));
    /** @type {PlanChat['status']} */
    let status = 'new';
    if (same) {
      entry.destinationChatId = same.destinationChatId;
      status = localById.has(same.destinationChatId) ? 'already_imported' : 'destination_deleted';
    } else if (found.length > 0) {
      status = 'options_changed';
    } else {
      const keys = lineageKeys(row);
      const digest = chatContentDigest(history.events);
      for (const local of localChats) {
        const localChat = /** @type {any} */ (local);
        const overlap = [...lineageKeys(localChat)].some((key) => keys.has(key));
        if (!overlap) continue;
        const localHistory = await store.loadHistory(String(localChat.id));
        const identical = chatContentDigest(localHistory?.events || []) === digest;
        entry.matches.push({ chatId: String(localChat.id), kind: identical ? 'content' : 'lineage' });
      }
      if (entry.matches.some((m) => m.kind === 'content')) status = 'content_match';
    }
    if (options.duplicate && status !== 'new') {
      entry.replacedStatus = status;
      status = 'duplicate';
    }
    entry.status = status;
    entry.willImport = status === 'new' || status === 'duplicate' || (status === 'options_changed' && options.acknowledgeOptionChange);
    if (status === 'options_changed' && !options.acknowledgeOptionChange) entry.warnings.push('options_changed: this chat was imported before with different options; confirm to create another copy');
    if (status === 'destination_deleted') entry.warnings.push('destination_deleted: the earlier import was deleted; it is not recreated (use duplicate to import again)');
    if (status === 'content_match') entry.warnings.push('content_match: an identical chat already exists; skipped (use duplicate to import anyway)');
    chats.push(entry);
  }

  // Relations are resolved against what this run imports or what an earlier import already created.
  const importing = new Set(chats.filter((c) => c.willImport).map((c) => c.sourceChatId));
  for (const entry of chats) {
    if (!entry.willImport) continue;
    const row = parsed.chats.find((r) => r.sourceChatId === entry.sourceChatId);
    for (const field of RELATION_FIELDS) {
      const target = row[field];
      if (!target) continue;
      if (importing.has(target)) {
        entry.relations.push({ field, sourceTarget: target, action: 'remap' });
        continue;
      }
      const prior = [...state.receipts].reverse().find((r) => r.archiveId === parsed.archiveId && r.sourceChatId === target && r.mode === 'import' && localById.has(r.destinationChatId));
      if (prior && !options.duplicate) entry.relations.push({ field, sourceTarget: target, action: 'remap_existing', destinationChatId: prior.destinationChatId });
      else entry.relations.push({ field, sourceTarget: target, action: 'removed' });
    }
  }
  const counts = { new: 0, duplicate: 0, already_imported: 0, destination_deleted: 0, options_changed: 0, content_match: 0, not_selected: 0 };
  for (const entry of chats) counts[/** @type {keyof typeof counts} */ (entry.status)] += 1;
  const fingerprint = sha256Hex(JSON.stringify(chats.map((c) => [c.sourceChatId, c.status, c.willImport, c.optionsHash, c.destinationChatId || '', c.matches, c.relations])));
  return {
    archive: {
      archiveId: parsed.archiveId,
      archiveDigest: parsed.digest,
      createdAt: parsed.manifest.createdAt,
      cretliVersion: parsed.manifest.cretliVersion,
      selection: parsed.manifest.selection || null,
      lineage: parsed.manifest.lineage || { sourceArchiveIds: [] },
      previouslySeen: Boolean(known),
    },
    chats,
    counts,
    requiresOptionChangeAck: chats.some((c) => c.status === 'options_changed' && !options.acknowledgeOptionChange),
    willImportCount: chats.filter((c) => c.willImport).length,
    omissions: parsed.manifest.omissions,
    notes: [
      'Imported chats get new IDs; native harness session IDs are not imported. Continuing starts a new session with an explicit history handoff.',
      'Only the transcript retained at export time is restored. Trimmed events are not recreated and unsynchronized queues of other devices are not part of the archive.',
    ],
    fingerprint,
  };
}

/**
 * @param {any} row
 * @param {{ destinationChatId: string, workspace: { workspaceFile?: string, workspaceFolder?: string }, relations: Record<string, string>, options: ReturnType<typeof normalizeImportOptions>, archiveId: string, importedAt: string }} ctx
 * @returns {Record<string, any>}
 */
function buildChatEntry(row, ctx) {
  // Control characters from an archive title are replaced on purpose.
  // eslint-disable-next-line no-control-regex
  const title =String(row.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 300) || 'Imported chat';
  /** @type {Record<string, any>} */
  const entry = {
    id: ctx.destinationChatId,
    title,
    // A fresh native session key: the source session IDs are intentionally not carried over.
    cursorSessionId: crypto.randomUUID(),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : ctx.importedAt,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : ctx.importedAt,
    agentTransport: normalizeAgentTransport(row.agentTransport),
    sdkMode: normalizeSdkMode(row.sdkMode),
    sdkUiMode: normalizeSdkUiMode(row.sdkUiMode),
  };
  if (['default', 'auto', 'manual'].includes(row.titleSource)) entry.titleSource = row.titleSource;
  if (typeof row.model === 'string' && row.model.length <= 200) entry.model = row.model;
  if (typeof row.sdkSystemPrompt === 'string') entry.sdkSystemPrompt = row.sdkSystemPrompt;
  if (ctx.options.preserveArchived && typeof row.archivedAt === 'string' && row.archivedAt) entry.archivedAt = row.archivedAt;
  if (ctx.workspace.workspaceFile) entry.workspaceFile = ctx.workspace.workspaceFile;
  if (ctx.workspace.workspaceFolder) entry.workspaceFolder = ctx.workspace.workspaceFolder;
  if (Array.isArray(row.summaries)) entry.summaries = JSON.parse(JSON.stringify(row.summaries));
  if (row.autoContextCompressionEnabled === true) entry.autoContextCompressionEnabled = true;
  if (row.autoContextCompressionThreshold !== undefined) entry.autoContextCompressionThreshold = row.autoContextCompressionThreshold;
  if (row.autoContextCompressionReset === false) entry.autoContextCompressionReset = false;
  for (const field of RELATION_FIELDS) {
    if (ctx.relations[field]) entry[field] = ctx.relations[field];
  }
  if (entry.forkParentChatId && typeof row.forkKind === 'string') entry.forkKind = row.forkKind.slice(0, 64);
  if (entry.delegationParentChatId && Number(row.delegationDepth) >= 1) entry.delegationDepth = Math.floor(Number(row.delegationDepth));
  entry.importedFrom = {
    archiveId: ctx.archiveId,
    sourceChatId: row.sourceChatId,
    importedAt: ctx.importedAt,
    lineage: Array.isArray(row.lineage) ? row.lineage.slice(-32) : [],
  };
  // Marker for the run layer: the next run opens a new native session and receives the transcript explicitly.
  entry.historyHandoff = { required: true, source: 'import', at: ctx.importedAt };
  return entry;
}

/**
 * @param {{
 *   store: import('./conversations-store.js').ConversationStore,
 *   now?: () => Date,
 *   maxImportBytes?: number,
 *   hooks?: { beforeCommit?: () => void | Promise<void>, afterPendingWritten?: () => void | Promise<void>, afterCommit?: () => void | Promise<void> },
 * }} deps
 */
export function createConversationImporter(deps) {
  const { store } = deps;
  const now = deps.now || (() => new Date());
  const maxImportBytes = deps.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES;
  /** @type {Map<string, any>} */
  const previews = new Map();
  /** @type {Map<string, { stageId: string, archiveId: string, digest: string, createdAt: number }>} */
  const stages = new Map();
  let chain = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serialized(fn) {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** @param {string} stageId */
  function stagePath(stageId) {
    if (!STAGE_ID_PATTERN.test(stageId)) throw new ConversationImportError('STAGE_NOT_FOUND', 'Staged archive not found', 404);
    return path.join(stagingDir(), `${stageId}.zip`);
  }

  function sweepStages() {
    const dir = stagingDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = now().getTime() - STAGE_TTL_MS;
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.zip')).map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }));
    files.sort((a, b) => a.mtime - b.mtime);
    const excess = Math.max(0, files.length - STAGE_CAP + 1);
    files.forEach((file, index) => {
      if (file.mtime < cutoff || index < excess) {
        try { fs.unlinkSync(path.join(dir, file.name)); } catch { /* ignore */ }
        stages.delete(file.name.replace(/\.zip$/, ''));
      }
    });
  }

  /**
   * @param {string} stageId
   * @returns {import('./conversations-archive.js').ParsedConversationsArchive}
   */
  function loadStage(stageId) {
    const file = stagePath(stageId);
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw new ConversationImportError('STAGE_NOT_FOUND', 'Staged archive not found or expired. Upload it again.', 404);
    }
    return parseConversationsArchive(bytes, { maxBytes: maxImportBytes });
  }

  /**
   * Roll an interrupted apply forward (chats were committed) or back (they were not).
   *
   * @param {ReceiptState} state
   * @returns {Promise<boolean>} true when the state changed
   */
  async function recoverPending(state) {
    if (state.pending.length === 0) return false;
    const { chats } = store.readChats();
    const ids = new Set(chats.map((chat) => String(/** @type {any} */ (chat).id)));
    for (const batch of state.pending) {
      const committed = batch.items.length > 0 && batch.items.every((item) => ids.has(item.destinationChatId));
      if (committed) {
        state.receipts.push(...batch.items);
        state.applied[batch.previewId] = resultFromItems(batch.archiveId, batch.archiveDigest, batch.items, []);
      } else {
        for (const item of batch.items) await store.deleteHistory(item.destinationChatId);
        for (const name of batch.uploads) store.deleteUpload(name);
      }
    }
    state.pending = [];
    writeReceiptState(state);
    return true;
  }

  /**
   * @param {string} archiveId
   * @param {string} archiveDigest
   * @param {Receipt[]} items
   * @param {Array<{ sourceChatId: string, status: string, destinationChatId?: string }>} skipped
   */
  function resultFromItems(archiveId, archiveDigest, items, skipped) {
    /** @type {Record<string, string>} */
    const mapping = {};
    for (const item of items) mapping[item.sourceChatId] = item.destinationChatId;
    for (const row of skipped) if (row.destinationChatId) mapping[row.sourceChatId] = row.destinationChatId;
    return {
      archiveId,
      archiveDigest,
      imported: items.map((item) => ({ sourceChatId: item.sourceChatId, destinationChatId: item.destinationChatId, mode: item.mode, attachments: item.attachments })),
      skipped,
      mapping,
    };
  }

  return {
    /**
     * Validate the whole archive and keep it for preview/apply.
     *
     * @param {Buffer} bytes
     */
    stage(bytes) {
      return serialized(async () => {
        const parsed = parseConversationsArchive(bytes, { maxBytes: maxImportBytes });
        const state = readReceiptState();
        const known = state.archives[parsed.archiveId];
        if (known && known.digest !== parsed.digest) {
          throw new ConversationImportError('ARCHIVE_DIGEST_CONFLICT', 'An archive with this id was imported before but its content differs.', 409, { archiveId: parsed.archiveId });
        }
        sweepStages();
        const stageId = `st-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        writeFileDurable(stagePath(stageId), bytes);
        stages.set(stageId, { stageId, archiveId: parsed.archiveId, digest: parsed.digest, createdAt: now().getTime() });
        return {
          stageId,
          archiveId: parsed.archiveId,
          archiveDigest: parsed.digest,
          createdAt: parsed.manifest.createdAt,
          cretliVersion: parsed.manifest.cretliVersion,
          previouslySeen: Boolean(known),
          chatCount: parsed.chats.length,
          eventCount: [...parsed.histories.values()].reduce((sum, h) => sum + h.events.length, 0),
          attachmentCount: parsed.attachments.size,
          workspaces: parsed.workspaces,
          chats: parsed.chats.map((row) => ({ sourceChatId: row.sourceChatId, title: row.title, eventCount: row.eventCount, archivedAt: row.archivedAt || null })),
          omissions: parsed.manifest.omissions,
        };
      });
    },

    /** @param {string} stageId */
    discardStage(stageId) {
      try { fs.unlinkSync(stagePath(stageId)); } catch { /* already gone */ }
      stages.delete(stageId);
    },

    /**
     * @param {{ stageId: string, options?: unknown }} input
     */
    preview(input) {
      return serialized(async () => {
        const parsed = loadStage(String(input.stageId || ''));
        const options = normalizeImportOptions(input.options, parsed);
        const state = readReceiptState();
        await recoverPending(state);
        const { chats, revision } = store.readChats();
        const plan = await buildImportPlan(parsed, options, state, chats, store);
        const previewId = crypto.randomUUID();
        const createdAt = now().getTime();
        previews.set(previewId, {
          previewId, stageId: input.stageId, archiveId: parsed.archiveId, digest: parsed.digest, options,
          optionsFingerprint: sha256Hex(JSON.stringify(options)), planFingerprint: plan.fingerprint, revision,
          expiresAt: createdAt + IMPORT_PREVIEW_TTL_MS,
        });
        while (previews.size > PREVIEW_CAP) previews.delete(/** @type {string} */ (previews.keys().next().value));
        return {
          previewId,
          expiresAt: new Date(createdAt + IMPORT_PREVIEW_TTL_MS).toISOString(),
          destinationRevision: revision,
          options,
          plan,
        };
      });
    },

    /**
     * Apply a previewed plan. Idempotent per preview id (also across restarts).
     *
     * @param {{ previewId: string }} input
     */
    apply(input) {
      return serialized(async () => {
        const previewId = String(input.previewId || '');
        const state = readReceiptState();
        if (state.applied[previewId]) return { ...state.applied[previewId], replayed: true };
        await recoverPending(state);
        if (state.applied[previewId]) return { ...state.applied[previewId], replayed: true };
        const preview = previews.get(previewId);
        if (!preview) throw new ConversationImportError('PREVIEW_NOT_FOUND', 'Preview not found or already used. Create a new preview.', 410);
        if (now().getTime() > preview.expiresAt) {
          previews.delete(previewId);
          throw new ConversationImportError('PREVIEW_EXPIRED', 'Preview expired. Create a new preview.', 410);
        }
        const parsed = loadStage(preview.stageId);
        if (parsed.digest !== preview.digest) throw new ConversationImportError('STALE_PREVIEW', 'The staged archive changed. Create a new preview.', 409);
        const { chats: localChats, revision } = store.readChats();
        if (revision !== preview.revision) throw new ConversationImportError('STALE_PREVIEW', 'The chat list changed after the preview. Create a new preview.', 409);
        const plan = await buildImportPlan(parsed, preview.options, state, localChats, store);
        if (plan.fingerprint !== preview.planFingerprint) throw new ConversationImportError('STALE_PREVIEW', 'Import state changed after the preview. Create a new preview.', 409);
        if (plan.requiresOptionChangeAck) {
          throw new ConversationImportError('OPTION_CHANGE_UNCONFIRMED', 'Some chats were imported before with different options. Acknowledge the option change in the preview to create another copy.', 409);
        }

        const importedAt = now().toISOString();
        const toImport = plan.chats.filter((c) => c.willImport);
        const skipped = plan.chats
          .filter((c) => !c.willImport)
          .map((c) => ({ sourceChatId: c.sourceChatId, status: c.status, ...(c.destinationChatId && c.status === 'already_imported' ? { destinationChatId: c.destinationChatId } : {}) }));
        if (toImport.length === 0) {
          const result = resultFromItems(parsed.archiveId, parsed.digest, [], skipped);
          state.applied[previewId] = result;
          writeReceiptState(state);
          previews.delete(previewId);
          return { ...result, replayed: false };
        }

        const destDir = store.uploadsPath();
        /** @type {Map<string, string>} */
        const destByChat = new Map(toImport.map((c) => [c.sourceChatId, crypto.randomUUID()]));
        /** @type {Map<string, string>} source attachment -> destination name (shared by chats of this run) */
        const attachmentMap = new Map();
        /** @type {Receipt[]} */
        const items = [];
        /** @type {Array<{ row: any, entry: Record<string, any>, events: any[], destinationChatId: string, cursorSessionId: string }>} */
        const prepared = [];
        for (const planChat of toImport) {
          const row = parsed.chats.find((r) => r.sourceChatId === planChat.sourceChatId);
          const history = /** @type {NonNullable<ReturnType<typeof parsed.histories.get>>} */ (parsed.histories.get(planChat.sourceChatId));
          const names = referencedAttachmentNames(history.events).filter((name) => parsed.attachments.has(name));
          /** @type {Record<string, string>} */
          const used = {};
          for (const name of names) {
            if (!attachmentMap.has(name)) attachmentMap.set(name, `${crypto.randomUUID()}.jpg`);
            used[name] = /** @type {string} */ (attachmentMap.get(name));
          }
          /** @type {Record<string, string>} */
          const relations = {};
          for (const rel of planChat.relations) {
            if (rel.action === 'remap') relations[rel.field] = /** @type {string} */ (destByChat.get(rel.sourceTarget));
            else if (rel.action === 'remap_existing') relations[rel.field] = rel.destinationChatId;
          }
          const destinationChatId = /** @type {string} */ (destByChat.get(planChat.sourceChatId));
          const workspace = { workspaceFile: planChat.workspace.workspaceFile, workspaceFolder: planChat.workspace.workspaceFolder };
          const entry = buildChatEntry(row, { destinationChatId, workspace, relations, options: preview.options, archiveId: parsed.archiveId, importedAt });
          // Rewrite attachment references; stream chunks are stored as already coalesced by the source.
          const events = history.events.map((event) => {
            const rec = /** @type {Record<string, any>} */ (rewriteAttachmentRefs(event.rec, attachmentMap, destDir));
            delete rec.clientSeq;
            return rec;
          });
          // The marker lives in historyHandoff/importedFrom; the visible notice is skipped when it would
          // push the transcript over the retention limit and trim the oldest source event.
          if (events.length < MAX_HISTORY_EVENTS) events.push({
            kind: 'meta',
            variant: 'notice',
            payload: `Imported from a Cretli conversations archive (${history.events.length} retained events). The native session was not restored; continuing starts a new session and hands the transcript over explicitly.`,
            createdAt: importedAt,
            handoff: { source: 'import' },
          });
          prepared.push({ row, entry, events, destinationChatId, cursorSessionId: /** @type {any} */ (entry).cursorSessionId });
          items.push({
            archiveId: parsed.archiveId,
            archiveDigest: parsed.digest,
            sourceChatId: planChat.sourceChatId,
            optionsHash: planChat.optionsHash,
            mode: preview.options.duplicate ? 'duplicate' : 'import',
            destinationChatId,
            importedAt,
            ...(preview.options.duplicate ? { duplicateKey: previewId } : {}),
            attachments: used,
          });
        }
        const uploadNames = [...attachmentMap.values()];

        // 1) Durable journal first: a crash from here on is recoverable.
        state.archives[parsed.archiveId] = state.archives[parsed.archiveId] || { digest: parsed.digest, firstSeenAt: importedAt };
        state.pending.push({ batchId: crypto.randomUUID(), previewId, archiveId: parsed.archiveId, archiveDigest: parsed.digest, startedAt: importedAt, items, uploads: uploadNames });
        writeReceiptState(state);
        await deps.hooks?.afterPendingWritten?.();

        // 2) Stage attachments and history; 3) one atomic chat-list commit.
        try {
          for (const [source, destName] of attachmentMap) {
            const bytes = /** @type {Buffer} */ (parsed.attachments.get(source));
            store.writeUpload(destName, bytes);
            const back = store.readUpload(destName);
            if (!back || sha256Hex(back) !== sha256Hex(bytes)) throw new ConversationImportError('ATTACHMENT_VERIFY_FAILED', `Attachment ${source} failed its read-back checksum`, 500);
          }
          for (const item of prepared) await store.writeHistory(item.destinationChatId, item.cursorSessionId, item.events);
          await deps.hooks?.beforeCommit?.();
          store.commitChats(prepared.map((item) => item.entry));
        } catch (err) {
          for (const item of prepared) {
            try { await store.deleteHistory(item.destinationChatId); } catch { /* recovery retries from the journal */ }
          }
          for (const name of uploadNames) store.deleteUpload(name);
          state.pending = state.pending.filter((batch) => batch.previewId !== previewId);
          writeReceiptState(state);
          throw err;
        }
        await deps.hooks?.afterCommit?.();

        // 4) Finalize receipts + the replay record in one durable write.
        state.pending = state.pending.filter((batch) => batch.previewId !== previewId);
        state.receipts.push(...items);
        const result = resultFromItems(parsed.archiveId, parsed.digest, items, skipped);
        state.applied[previewId] = result;
        writeReceiptState(state);
        previews.delete(previewId);
        return { ...result, replayed: false };
      });
    },

    /** Roll interrupted imports forward/back (call once at startup). */
    recover() {
      return serialized(async () => recoverPending(readReceiptState()));
    },

    /** Test hook. */
    resetForTests() {
      previews.clear();
      stages.clear();
    },
  };
}

export { ConversationArchiveError };
