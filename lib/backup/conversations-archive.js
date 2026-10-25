/**
 * `conversations-v1` archive: building (export) and strict staged parsing
 * (import validation). Pure with respect to the stores: everything arrives
 * through the injected {@link import('./conversations-store.js').ConversationStore}.
 *
 * Archive layout (ZIP, store only):
 *   manifest.json                 profile manifest (categories, attachments, omissions, lineage)
 *   chats/metadata.json           whitelisted chat records + logical workspace table
 *   chats/history.json            retained history events per chat (coalesced as stored)
 *   attachments/index.json        attachment name -> size + sha256
 *   attachments/<uuid>.jpg        attachment bytes (only names listed in the index)
 *   markdown/conversations.md     optional reading copy, never parsed on import
 *
 * Only the retained transcript is exported. Trimmed events are not recreated and
 * unsynchronized queues of other devices are never part of the archive; both are
 * stated in `omissions`.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import {
  ARCHIVE_CONTRACT_REVISION,
  ARCHIVE_LIMITS_V1,
} from './archive-contract.js';
import { validateArchiveDocument } from './validate-archive-document.js';
import { ZipArchiveError, assertSafeEntryName, buildStoreZip, readStoreZip } from './zip-store.js';
import { ATTACHMENT_NAME_PATTERN } from './conversations-store.js';
import { formatChatHistoryEventsToText } from '../context-compression.js';
import { isValidChatId, MAX_HISTORY_EVENTS } from '../persist/chat-history-adapter.js';
import { isValidSdkHistoryRecord } from '../persist/chat-history-validate.js';
import { collectForkSubtreeIds, isChatArchived } from '../chat-tree.js';

const require = createRequire(import.meta.url);
const CRETLI_VERSION = String(require('../../package.json').version || '0.0.0');

export const CONVERSATIONS_SCHEMA_VERSION = 1;
export const MAX_CHATS_PER_ARCHIVE = 5000;
/** Same cap the sqlite history backend applies to one stored record. */
export const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_ATTACHMENTS = 20000;
/** Upper bound for an archive accepted over HTTP (operational, below the frozen 8 GiB contract limit). */
export const DEFAULT_MAX_IMPORT_BYTES = 512 * 1024 * 1024;

const PATHS = Object.freeze({
  manifest: 'manifest.json',
  metadata: 'chats/metadata.json',
  history: 'chats/history.json',
  attachmentIndex: 'attachments/index.json',
  markdown: 'markdown/conversations.md',
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** An uploads path in a record: optional directory prefix, `uploads/`, UUID + .jpg. */
const UPLOAD_REF_RE = /(?:[A-Za-z]:)?[^\s"'`<>()[\]|]{0,240}?uploads[\\/]([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.jpg)/gi;

export class ConversationArchiveError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {Record<string, unknown>} [extra]
   */
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'ConversationArchiveError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/** @param {Buffer | string} raw @returns {string} */
export function sha256Hex(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Chat fields that travel in an archive. Everything else (native harness session
 * IDs, widget bindings, delegation/TODO identifiers, temporary and watcher chats)
 * is deliberately absent, so a hand-crafted archive cannot smuggle them in either.
 */
const CHAT_SCALAR_FIELDS = Object.freeze([
  'title', 'titleSource', 'createdAt', 'updatedAt', 'archivedAt', 'agentTransport',
  'sdkMode', 'sdkUiMode', 'sdkSystemPrompt', 'model', 'forkKind', 'delegationDepth',
  'autoContextCompressionEnabled', 'autoContextCompressionThreshold', 'autoContextCompressionReset',
]);
/** Relation fields remapped to destination IDs on import. */
export const RELATION_FIELDS = Object.freeze(['forkParentChatId', 'delegationParentChatId', 'delegationRootChatId']);

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Replace every attachment path in a string with a constant so content digests
 * survive attachment renaming on import.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeUploadRefs(text) {
  return text.replace(UPLOAD_REF_RE, 'uploads/@');
}

/**
 * Digest of a transcript that ignores seq numbers, per-device `clientSeq`, attachment
 * file names (rewritten on import) and the import-handoff notice appended by an import.
 *
 * @param {Array<{ rec: any }>} events
 * @returns {string}
 */
export function chatContentDigest(events) {
  const recs = events.filter((event) => !(isPlainObject(event.rec?.handoff) && event.rec.handoff.source === 'import')).map((event) => {
    const rec = { ...event.rec };
    delete rec.clientSeq;
    return rec;
  });
  return sha256Hex(normalizeUploadRefs(JSON.stringify(recs)));
}

/**
 * @param {unknown} value
 * @param {(text: string) => string} fn
 * @returns {unknown} deep copy with `fn` applied to every string value
 */
function mapStrings(value, fn) {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, fn);
    return out;
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {Set<string>} into
 */
function collectUploadNames(value, into) {
  mapStrings(value, (text) => {
    for (const match of text.matchAll(UPLOAD_REF_RE)) into.add(match[1].toLowerCase());
    return text;
  });
}

/**
 * Rewrite attachment references to destination names and absolute destination paths.
 *
 * @param {unknown} rec
 * @param {Map<string, string>} nameMap source name -> destination name
 * @param {string} destDir absolute destination uploads directory
 * @returns {unknown}
 */
export function rewriteAttachmentRefs(rec, nameMap, destDir) {
  return mapStrings(rec, (text) => text.replace(UPLOAD_REF_RE, (whole, name) => {
    const mapped = nameMap.get(String(name).toLowerCase());
    return mapped ? `${destDir.replace(/\\/g, '/')}/${mapped}` : whole;
  }));
}

/**
 * Rejects `__proto__`/`constructor`/`prototype` keys anywhere in parsed JSON.
 *
 * @param {unknown} value
 * @param {string} where
 */
function assertNoPollutingKeys(value, where) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPollutingKeys(item, where);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ConversationArchiveError('prototype_pollution', `Forbidden key "${key}" in ${where}`);
    }
    assertNoPollutingKeys(value[key], where);
  }
}

/**
 * @param {Buffer} bytes
 * @param {string} where
 * @returns {any}
 */
function parseJsonMember(bytes, where) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new ConversationArchiveError('invalid_json', `${where} is not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  assertNoPollutingKeys(parsed, where);
  return parsed;
}

/**
 * @param {any[]} chats full chat list
 * @param {{
 *   scope: 'chat' | 'selection' | 'workspace' | 'all',
 *   chatIds?: string[],
 *   workspaceFolder?: string,
 *   workspaceFile?: string,
 *   includeArchived?: boolean,
 *   includeSubchats?: boolean,
 * }} input
 * @returns {{ chats: any[], omissions: Array<{ path: string, reason: string, detail?: string, rawSha256?: string }>, selection: Record<string, unknown> }}
 */
export function resolveExportSelection(chats, input) {
  const eligible = chats.filter((chat) => chat && !chat.isTemporary && !chat.watcherPinned);
  const byId = new Map(eligible.map((chat) => [String(chat.id), chat]));
  /** @type {Array<{ path: string, reason: string, detail?: string, rawSha256?: string }>} */
  const omissions = [];
  const includeArchived = input.includeArchived === true;
  const includeSubchats = input.includeSubchats === true;
  const scope = input.scope;
  /** @type {Set<string>} */
  const explicit = new Set();
  /** @type {Set<string>} */
  const candidates = new Set();

  if (scope === 'chat' || scope === 'selection') {
    const ids = Array.isArray(input.chatIds) ? input.chatIds.map((id) => String(id)) : [];
    if (ids.length === 0) throw new ConversationArchiveError('selection_empty', 'No chat selected');
    if (scope === 'chat' && ids.length !== 1) throw new ConversationArchiveError('selection_invalid', 'Scope "chat" takes exactly one chat id');
    for (const id of ids) {
      if (!byId.has(id)) throw new ConversationArchiveError('chat_not_found', `Chat not found: ${id}`, 404);
      explicit.add(id);
      candidates.add(id);
    }
  } else if (scope === 'workspace') {
    const folder = String(input.workspaceFolder || '').trim();
    const file = String(input.workspaceFile || '').trim();
    if (!folder && !file) throw new ConversationArchiveError('selection_invalid', 'Workspace scope needs workspaceFolder or workspaceFile');
    for (const chat of eligible) {
      if ((file && chat.workspaceFile === file) || (!file && folder && chat.workspaceFolder === folder)) candidates.add(String(chat.id));
    }
  } else if (scope === 'all') {
    for (const chat of eligible) candidates.add(String(chat.id));
  } else {
    throw new ConversationArchiveError('selection_invalid', `Unknown scope: ${scope}`);
  }

  if (includeSubchats) {
    for (const id of [...candidates]) {
      for (const child of collectForkSubtreeIds(eligible, id)) candidates.add(child);
    }
  }

  /** @type {Set<string>} */
  const picked = new Set();
  let archivedSkipped = 0;
  for (const id of candidates) {
    const chat = byId.get(id);
    if (!chat) continue;
    if (!explicit.has(id) && !includeArchived && isChatArchived(chat)) {
      archivedSkipped += 1;
      if (archivedSkipped <= 100) omissions.push({ path: `chats/${id}`, reason: 'operator_excluded', detail: 'archived chat excluded (includeArchived is off)' });
      continue;
    }
    picked.add(id);
  }
  if (archivedSkipped > 100) {
    omissions.push({ path: 'chats', reason: 'operator_excluded', detail: `${archivedSkipped} archived chats excluded in total (includeArchived is off)` });
  }
  const ordered = eligible.filter((chat) => picked.has(String(chat.id)));
  return {
    chats: ordered,
    omissions,
    selection: {
      scope,
      ...(scope === 'chat' || scope === 'selection' ? { chatIds: [...explicit] } : {}),
      ...(scope === 'workspace' && input.workspaceFolder ? { workspaceId: String(input.workspaceFolder) } : {}),
      includeArchived,
      includeSubchats,
    },
  };
}

/**
 * Longest backtick run + 1 (min 3) so untrusted text cannot close a Markdown fence.
 *
 * @param {string} text
 * @returns {string}
 */
function fenceFor(text) {
  let longest = 0;
  for (const run of text.match(/`+/g) || []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * @param {string} text
 * @returns {string} single-line, markdown-inert heading text
 */
function inertLine(text) {
  return String(text || '').replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}[\]()#+!|<>])/g, '\\$1').trim();
}

/**
 * @param {Array<{ chat: any, events: any[], workspaceLabel: string }>} entries
 * @returns {string}
 */
export function renderMarkdown(entries) {
  const lines = ['# Cretli conversations export', '',
    'Reading copy only. Importing uses the JSON archive; this file is never interpreted as configuration.', ''];
  for (const entry of entries) {
    const body = formatChatHistoryEventsToText(entry.events) || '(no retained transcript)';
    const fence = fenceFor(body);
    lines.push(`## ${inertLine(entry.chat.title) || 'Untitled chat'}`, '');
    lines.push(`- Chat id: ${entry.chat.id}`);
    if (entry.chat.createdAt) lines.push(`- Created: ${entry.chat.createdAt}`);
    if (entry.chat.model) lines.push(`- Model: ${inertLine(entry.chat.model)}`);
    if (entry.workspaceLabel) lines.push(`- Workspace: ${inertLine(entry.workspaceLabel)}`);
    if (entry.chat.archivedAt) lines.push(`- Archived: ${entry.chat.archivedAt}`);
    lines.push(`- Retained events: ${entry.events.length}`, '', `${fence}text`, body, fence, '');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {string} p
 * @returns {string}
 */
function workspaceLabelOf(p) {
  const base = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
  return base.replace(/\.code-workspace$/i, '');
}

/**
 * Collects everything an export needs. Read-only; also used for the export estimate.
 *
 * @param {import('./conversations-store.js').ConversationStore} store
 * @param {Parameters<typeof resolveExportSelection>[1] & { includeAttachments?: boolean, includeWorkspacePaths?: boolean, shouldCancel?: () => boolean, onProgress?: (done: number, total: number) => void }} input
 */
export async function collectExport(store, input) {
  const { chats: all } = store.readChats();
  const selection = resolveExportSelection(all, input);
  const picked = selection.chats;
  const pickedIds = new Set(picked.map((chat) => String(chat.id)));
  /** @type {Array<{ path: string, reason: string, detail?: string, rawSha256?: string }>} */
  const omissions = [...selection.omissions];
  const includeAttachments = input.includeAttachments !== false;
  const includePaths = input.includeWorkspacePaths === true;

  /** @type {Map<string, { file: string, folder: string }>} */
  const workspaceByKey = new Map();
  /** @type {any[]} */
  const workspaces = [];
  /** @param {any} chat */
  const workspaceRefOf = (chat) => {
    const file = String(chat.workspaceFile || '');
    const folder = String(chat.workspaceFolder || '');
    if (!file && !folder) return undefined;
    const key = `${file}\u0000${folder}`;
    if (!workspaceByKey.has(key)) {
      workspaceByKey.set(key, { file, folder });
      workspaces.push({
        ref: `w${workspaces.length + 1}`,
        label: workspaceLabelOf(file || folder),
        ...(includePaths ? { workspaceFile: file || undefined, workspaceFolder: folder || undefined } : {}),
      });
    }
    return workspaces[[...workspaceByKey.keys()].indexOf(key)].ref;
  };

  /** @type {any[]} */
  const chatRows = [];
  /** @type {any[]} */
  const histories = [];
  /** @type {Array<{ chat: any, events: any[], workspaceLabel: string }>} */
  const markdownEntries = [];
  /** @type {Set<string>} */
  const uploadNames = new Set();
  let eventTotal = 0;
  let done = 0;
  for (const chat of picked) {
    if (input.shouldCancel?.()) throw new ConversationArchiveError('cancelled', 'Export cancelled', 409);
    const id = String(chat.id);
    if (!isValidChatId(id)) {
      omissions.push({ path: `chats/${id.slice(0, 64)}`, reason: 'corrupt_source', rawSha256: sha256Hex(id), detail: 'chat id is not a valid identifier' });
      continue;
    }
    const doc = await store.loadHistory(id);
    const events = (doc?.events || []).map((e) => ({ seq: Number(e.seq), rec: e.rec }));
    eventTotal += events.length;
    for (const event of events) collectUploadNames(event.rec, uploadNames);
    if (events.length >= MAX_HISTORY_EVENTS && events[0] && events[0].seq > 1) {
      omissions.push({ path: `chats/${id}/history`, reason: 'pruned_history', detail: `only the ${events.length} retained events are exported; older events were trimmed and are not recreated` });
    }
    /** @type {Record<string, unknown>} */
    const row = { sourceChatId: id };
    for (const field of CHAT_SCALAR_FIELDS) {
      if (chat[field] !== undefined && chat[field] !== null && chat[field] !== '') row[field] = chat[field];
    }
    if (Array.isArray(chat.summaries)) row.summaries = JSON.parse(JSON.stringify(chat.summaries));
    const wsRef = workspaceRefOf(chat);
    if (wsRef) row.workspaceRef = wsRef;
    for (const field of RELATION_FIELDS) {
      const target = String(chat[field] || '').trim();
      if (!target) continue;
      if (pickedIds.has(target)) row[field] = target;
      else omissions.push({ path: `chats/${id}/${field}`, reason: 'dependency_not_exported', detail: `${field} points at a chat outside this export; the link is removed on import` });
    }
    for (const dropped of ['todoId', 'delegationId', 'delegationRootDelegationId']) {
      if (chat[dropped]) omissions.push({ path: `chats/${id}/${dropped}`, reason: 'dependency_not_exported', detail: `${dropped} references a store that is not part of a conversations export` });
    }
    // Lineage of an imported chat: oldest source first, so a re-export keeps the full chain.
    const imported = chat.importedFrom;
    if (isPlainObject(imported) && typeof imported.archiveId === 'string') {
      row.lineage = [
        ...(Array.isArray(imported.lineage) ? imported.lineage : []),
        { archiveId: imported.archiveId, sourceChatId: String(imported.sourceChatId || '') },
      ].slice(-32);
    }
    row.eventCount = events.length;
    row.contentSha256 = chatContentDigest(events);
    chatRows.push(row);
    histories.push({ chatId: id, headSeq: Number(doc?.headSeq) || 0, events });
    markdownEntries.push({ chat, events, workspaceLabel: workspaceLabelOf(chat.workspaceFile || chat.workspaceFolder || '') });
    done += 1;
    input.onProgress?.(done, picked.length);
  }

  /** @type {Array<{ name: string, bytes: Buffer }>} */
  const attachments = [];
  if (includeAttachments) {
    for (const name of [...uploadNames].sort()) {
      const bytes = ATTACHMENT_NAME_PATTERN.test(name) ? store.readUpload(name) : null;
      if (bytes) attachments.push({ name, bytes });
      else omissions.push({ path: `attachments/${name}`, reason: 'attachment_missing', detail: 'referenced by a transcript but not present in uploads/' });
    }
  } else if (uploadNames.size > 0) {
    omissions.push({ path: 'attachments', reason: 'operator_excluded', detail: `${uploadNames.size} referenced attachments were not included (includeAttachments is off)` });
  }
  omissions.push({
    path: 'browser/offline-queues',
    reason: 'browser_unavailable',
    detail: 'Unsynchronized records queued on this or other devices are not part of the archive; only the server-retained transcript is exported.',
  });
  return { selection, chatRows, histories, markdownEntries, workspaces, attachments, omissions, eventTotal, includeAttachments };
}

/**
 * Cheap summary of an export without building the archive.
 *
 * @param {import('./conversations-store.js').ConversationStore} store
 * @param {Parameters<typeof collectExport>[1]} input
 */
export async function previewExport(store, input) {
  const data = await collectExport(store, { ...input });
  let attachmentBytes = 0;
  for (const attachment of data.attachments) attachmentBytes += attachment.bytes.length;
  const historyBytes = Buffer.byteLength(JSON.stringify(data.histories));
  return {
    selection: data.selection.selection,
    chatCount: data.chatRows.length,
    eventCount: data.eventTotal,
    attachmentCount: data.attachments.length,
    estimatedBytes: historyBytes + attachmentBytes,
    chats: data.chatRows.map((row) => ({ sourceChatId: row.sourceChatId, title: row.title, eventCount: row.eventCount })),
    omissions: data.omissions,
  };
}

/**
 * Keeps the manifest within the omission limit and records how many entries were dropped.
 *
 * @param {Array<{ path: string, reason: string, detail?: string, rawSha256?: string }>} omissions
 */
export function capOmissions(omissions) {
  const max = ARCHIVE_LIMITS_V1.maxOmissions;
  if (omissions.length <= max) return omissions;
  return [
    ...omissions.slice(0, max - 1),
    { path: 'omissions', reason: 'operator_excluded', detail: `${omissions.length - (max - 1)} further omissions are not listed (limit ${max})` },
  ];
}

/**
 * @param {Parameters<typeof collectExport>[1] & { format?: 'archive' | 'markdown', includeMarkdown?: boolean, now?: () => Date }} input
 * @param {import('./conversations-store.js').ConversationStore} store
 * @returns {Promise<{ format: 'archive' | 'markdown', bytes: Buffer, archiveId?: string, manifest?: any, summary: Record<string, unknown>, fileName: string }>}
 */
export async function buildConversationsExport(store, input) {
  const format = input.format === 'markdown' ? 'markdown' : 'archive';
  const data = await collectExport(store, input);
  const createdAt = (input.now ? input.now() : new Date()).toISOString();
  const summary = {
    chatCount: data.chatRows.length,
    eventCount: data.eventTotal,
    attachmentCount: data.attachments.length,
    omissionCount: data.omissions.length,
  };
  const markdown = renderMarkdown(data.markdownEntries);
  if (format === 'markdown') {
    return { format, bytes: Buffer.from(markdown, 'utf8'), summary, fileName: 'cretli-conversations.md' };
  }

  const archiveId = crypto.randomUUID();
  const metadata = { schemaVersion: CONVERSATIONS_SCHEMA_VERSION, workspaces: data.workspaces, chats: data.chatRows };
  const history = { schemaVersion: CONVERSATIONS_SCHEMA_VERSION, histories: data.histories };
  const attachmentIndex = {
    schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
    attachments: data.attachments.map((a) => ({ name: a.name, size: a.bytes.length, sha256: sha256Hex(a.bytes) })),
  };
  /** @type {Array<{ name: string, data: Buffer }>} */
  const members = [];
  /** @type {any[]} */
  const categories = [];
  /**
   * @param {string} categoryId
   * @param {string} memberPath
   * @param {Buffer} bytes
   * @param {'json' | 'markdown'} role
   * @param {Record<string, number>} [recordCounts]
   * @param {string} [storeId]
   */
  const addCategory = (categoryId, memberPath, bytes, role, recordCounts, storeId) => {
    if (bytes.length > ARCHIVE_LIMITS_V1.maxMemberBytes) throw new ConversationArchiveError('member_size_exceeded', `${memberPath} exceeds the member size limit`, 413);
    members.push({ name: memberPath, data: bytes });
    categories.push({
      categoryId, path: memberPath, byteSize: bytes.length, sha256: sha256Hex(bytes), role,
      ...(recordCounts ? { recordCounts } : {}),
      ...(storeId ? { storeId } : {}),
      schemaVersion: CONVERSATIONS_SCHEMA_VERSION,
    });
  };
  addCategory('chat-metadata', PATHS.metadata, Buffer.from(JSON.stringify(metadata)), 'json', { chats: data.chatRows.length }, 'chats-metadata');
  addCategory('chat-history', PATHS.history, Buffer.from(JSON.stringify(history)), 'json', { chats: data.histories.length, events: data.eventTotal }, 'chat-history');
  addCategory('attachment-index', PATHS.attachmentIndex, Buffer.from(JSON.stringify(attachmentIndex)), 'json', { attachments: data.attachments.length }, 'attachments');
  if (input.includeMarkdown !== false) {
    addCategory('markdown', PATHS.markdown, Buffer.from(markdown, 'utf8'), 'markdown', { chats: data.chatRows.length });
  }
  for (const attachment of data.attachments) members.push({ name: `attachments/${attachment.name}`, data: attachment.bytes });

  const lineageIds = new Set();
  for (const row of data.chatRows) for (const link of row.lineage || []) lineageIds.add(link.archiveId);

  const manifest = {
    profile: 'conversations-v1',
    manifestFormatVersion: 1,
    archiveContractRevision: ARCHIVE_CONTRACT_REVISION,
    archiveId,
    createdAt,
    cretliVersion: CRETLI_VERSION,
    selection: data.selection.selection,
    categories,
    attachments: {
      count: data.attachments.length,
      totalBytes: data.attachments.reduce((sum, a) => sum + a.bytes.length, 0),
      indexPath: PATHS.attachmentIndex,
    },
    ...(lineageIds.size > 0 ? { lineage: { sourceArchiveIds: [...lineageIds].slice(0, 64) } } : {}),
    omissions: capOmissions(data.omissions),
  };
  const checked = validateArchiveDocument(manifest, 'conversations-v1');
  if (!checked.ok) throw new ConversationArchiveError('manifest_invalid', `Generated manifest is invalid: ${/** @type {any} */ (checked).errors.join('; ')}`, 500);
  members.unshift({ name: PATHS.manifest, data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const zip = buildStoreZip(members);
  return { format, bytes: zip, archiveId, manifest, summary, fileName: `cretli-conversations-${archiveId}.zip` };
}

/**
 * @typedef {Object} ParsedConversationsArchive
 * @property {string} archiveId
 * @property {string} digest sha256 of the archive bytes
 * @property {any} manifest
 * @property {Array<{ ref: string, label: string, workspaceFile?: string, workspaceFolder?: string }>} workspaces
 * @property {Array<any>} chats metadata rows
 * @property {Map<string, { headSeq: number, events: Array<{ seq: number, rec: any }> }>} histories
 * @property {Map<string, Buffer>} attachments name -> bytes (hash verified)
 */

/**
 * Fully validates an archive in memory without any write.
 * Order: ZIP structure -> manifest schema -> member checksums/sizes -> no unlisted
 * members -> payload shapes -> reference integrity. Any failure rejects everything.
 *
 * @param {Buffer} bytes
 * @param {{ maxBytes?: number }} [limits]
 * @returns {ParsedConversationsArchive}
 */
export function parseConversationsArchive(bytes, limits = {}) {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES;
  if (!Buffer.isBuffer(bytes)) throw new ConversationArchiveError('zip_invalid', 'Archive must be a binary body');
  if (bytes.length > maxBytes) throw new ConversationArchiveError('archive_size_exceeded', 'Archive too large', 413);
  /** @type {Map<string, Buffer>} */
  let members;
  try {
    members = readStoreZip(bytes, { maxTotalBytes: maxBytes, maxMemberBytes: Math.min(ARCHIVE_LIMITS_V1.maxMemberBytes, maxBytes) });
  } catch (err) {
    if (err instanceof ZipArchiveError) throw new ConversationArchiveError(err.code, err.message, err.code.endsWith('exceeded') ? 413 : 400);
    throw err;
  }
  const manifestBytes = members.get(PATHS.manifest);
  if (!manifestBytes) throw new ConversationArchiveError('manifest_missing', 'manifest.json is missing');
  const manifest = parseJsonMember(manifestBytes, 'manifest.json');
  const checked = validateArchiveDocument(manifest, 'conversations-v1');
  if (!checked.ok) throw new ConversationArchiveError('manifest_invalid', `Invalid manifest: ${/** @type {any} */ (checked).errors.slice(0, 5).join('; ')}`);
  if (!UUID_PATTERN.test(String(manifest.archiveId))) throw new ConversationArchiveError('manifest_invalid', 'archiveId is not a UUID');

  /** @type {Set<string>} */
  const listed = new Set([PATHS.manifest]);
  /** @type {Map<string, Buffer>} */
  const byCategory = new Map();
  for (const category of manifest.categories) {
    assertSafeEntryName(category.path);
    const data = members.get(category.path);
    if (!data) throw new ConversationArchiveError('member_missing', `Listed member is missing: ${category.path}`);
    if (listed.has(category.path)) throw new ConversationArchiveError('duplicate_entry', `Member listed twice: ${category.path}`);
    if (data.length !== category.byteSize) throw new ConversationArchiveError('size_mismatch', `Size mismatch for ${category.path}`);
    if (sha256Hex(data) !== category.sha256) throw new ConversationArchiveError('checksum_mismatch', `Checksum mismatch for ${category.path}`);
    listed.add(category.path);
    byCategory.set(category.categoryId, data);
  }
  const metadataBytes = byCategory.get('chat-metadata');
  const historyBytes = byCategory.get('chat-history');
  const indexBytes = byCategory.get('attachment-index');
  if (!metadataBytes || !historyBytes || !indexBytes) throw new ConversationArchiveError('category_missing', 'chat-metadata, chat-history and attachment-index categories are required');

  // Attachments: every attachments/<name> member must be in the index with a matching hash.
  const index = parseJsonMember(indexBytes, PATHS.attachmentIndex);
  if (index.schemaVersion !== CONVERSATIONS_SCHEMA_VERSION || !Array.isArray(index.attachments)) throw new ConversationArchiveError('attachment_index_invalid', 'Unsupported attachment index');
  if (index.attachments.length > MAX_ATTACHMENTS) throw new ConversationArchiveError('attachment_limit_exceeded', 'Too many attachments', 413);
  /** @type {Map<string, Buffer>} */
  const attachments = new Map();
  for (const row of index.attachments) {
    if (!isPlainObject(row) || typeof row.name !== 'string' || !ATTACHMENT_NAME_PATTERN.test(row.name)) throw new ConversationArchiveError('attachment_index_invalid', 'Illegal attachment name in index');
    if (attachments.has(row.name)) throw new ConversationArchiveError('duplicate_entry', `Attachment listed twice: ${row.name}`);
    const memberPath = `attachments/${row.name}`;
    const data = members.get(memberPath);
    if (!data) throw new ConversationArchiveError('member_missing', `Attachment member is missing: ${memberPath}`);
    if (data.length !== row.size) throw new ConversationArchiveError('size_mismatch', `Size mismatch for ${memberPath}`);
    if (sha256Hex(data) !== row.sha256) throw new ConversationArchiveError('checksum_mismatch', `Checksum mismatch for ${memberPath}`);
    listed.add(memberPath);
    attachments.set(row.name, data);
  }
  for (const name of members.keys()) {
    if (!listed.has(name)) throw new ConversationArchiveError('unlisted_member', `Archive member is not described by the manifest: ${name}`);
  }
  if (Number(manifest.attachments?.count ?? attachments.size) !== attachments.size) throw new ConversationArchiveError('attachment_index_invalid', 'Manifest attachment count does not match the index');

  const metadata = parseJsonMember(metadataBytes, PATHS.metadata);
  const history = parseJsonMember(historyBytes, PATHS.history);
  if (metadata.schemaVersion !== CONVERSATIONS_SCHEMA_VERSION || history.schemaVersion !== CONVERSATIONS_SCHEMA_VERSION) {
    throw new ConversationArchiveError('unsupported_schema_version', 'Unsupported payload schema version');
  }
  if (!Array.isArray(metadata.chats) || !Array.isArray(history.histories) || !Array.isArray(metadata.workspaces)) throw new ConversationArchiveError('payload_invalid', 'chat payloads have an unexpected shape');
  if (metadata.chats.length > MAX_CHATS_PER_ARCHIVE) throw new ConversationArchiveError('chat_limit_exceeded', 'Too many chats in one archive', 413);

  /** @type {Set<string>} */
  const refs = new Set();
  for (const ws of metadata.workspaces) {
    if (!isPlainObject(ws) || typeof ws.ref !== 'string' || !/^w\d{1,6}$/.test(ws.ref) || refs.has(ws.ref)) throw new ConversationArchiveError('payload_invalid', 'Invalid workspace table');
    refs.add(ws.ref);
  }
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const row of metadata.chats) {
    if (!isPlainObject(row) || typeof row.sourceChatId !== 'string' || !isValidChatId(row.sourceChatId)) throw new ConversationArchiveError('payload_invalid', 'Invalid chat id in metadata');
    if (rows.has(row.sourceChatId)) throw new ConversationArchiveError('duplicate_entry', `Chat listed twice: ${row.sourceChatId}`);
    if (typeof row.title !== 'string') throw new ConversationArchiveError('payload_invalid', `Chat ${row.sourceChatId} has no title`);
    if (row.workspaceRef !== undefined && !refs.has(row.workspaceRef)) throw new ConversationArchiveError('reference_broken', `Chat ${row.sourceChatId} references an unknown workspace`);
    rows.set(row.sourceChatId, row);
  }
  for (const row of rows.values()) {
    for (const field of RELATION_FIELDS) {
      if (row[field] !== undefined && !rows.has(row[field])) throw new ConversationArchiveError('reference_broken', `Chat ${row.sourceChatId} ${field} points outside the archive`);
    }
  }
  // The fork-parent graph must be acyclic.
  for (const row of rows.values()) {
    const seen = new Set([row.sourceChatId]);
    let parent = row.forkParentChatId;
    while (parent) {
      if (seen.has(parent)) throw new ConversationArchiveError('reference_cycle', `Fork parent cycle at ${row.sourceChatId}`);
      seen.add(parent);
      parent = rows.get(parent)?.forkParentChatId;
    }
  }

  /** @type {Map<string, { headSeq: number, events: Array<{ seq: number, rec: any }> }>} */
  const histories = new Map();
  let eventTotal = 0;
  for (const h of history.histories) {
    if (!isPlainObject(h) || typeof h.chatId !== 'string' || !rows.has(h.chatId) || histories.has(h.chatId) || !Array.isArray(h.events)) {
      throw new ConversationArchiveError('payload_invalid', 'History does not match the chat metadata');
    }
    if (h.events.length > MAX_HISTORY_EVENTS) throw new ConversationArchiveError('event_limit_exceeded', `Chat ${h.chatId} has more than ${MAX_HISTORY_EVENTS} events`, 413);
    let lastSeq = 0;
    for (const event of h.events) {
      if (!isPlainObject(event) || !Number.isInteger(event.seq) || event.seq <= lastSeq) throw new ConversationArchiveError('payload_invalid', `Chat ${h.chatId}: seq must be strictly increasing`);
      lastSeq = event.seq;
      if (!isValidSdkHistoryRecord(event.rec)) throw new ConversationArchiveError('record_invalid', `Chat ${h.chatId}: invalid history record at seq ${event.seq}`);
      if (Buffer.byteLength(JSON.stringify(event.rec)) > MAX_RECORD_BYTES) throw new ConversationArchiveError('record_too_large', `Chat ${h.chatId}: record at seq ${event.seq} exceeds ${MAX_RECORD_BYTES} bytes`, 413);
    }
    eventTotal += h.events.length;
    const row = rows.get(h.chatId);
    if (row.eventCount !== h.events.length) throw new ConversationArchiveError('count_mismatch', `Chat ${h.chatId}: eventCount does not match history`);
    if (row.contentSha256 !== chatContentDigest(h.events)) throw new ConversationArchiveError('checksum_mismatch', `Chat ${h.chatId}: content digest does not match history`);
    histories.set(h.chatId, { headSeq: Number(h.headSeq) || lastSeq, events: h.events.map((e) => ({ seq: e.seq, rec: e.rec })) });
  }
  for (const id of rows.keys()) {
    if (!histories.has(id)) throw new ConversationArchiveError('payload_invalid', `Chat ${id} has no history entry`);
  }
  const historyCategory = manifest.categories.find((c) => c.categoryId === 'chat-history');
  if (historyCategory?.recordCounts && (historyCategory.recordCounts.events !== eventTotal || historyCategory.recordCounts.chats !== rows.size)) {
    throw new ConversationArchiveError('count_mismatch', 'Manifest record counts do not match the history payload');
  }
  return {
    archiveId: manifest.archiveId,
    digest: sha256Hex(bytes),
    manifest,
    workspaces: metadata.workspaces,
    chats: [...rows.values()],
    histories,
    attachments,
  };
}

/**
 * Attachment names referenced by a chat's transcript (not necessarily present).
 *
 * @param {Array<{ rec: any }>} events
 * @returns {string[]}
 */
export function referencedAttachmentNames(events) {
  const names = new Set();
  collectUploadNames(events.map((e) => e.rec), names);
  return [...names];
}
