/**
 * Domain rules of the chat list shared by every backend adapter (legacy `chats.json` and SQLite).
 *
 * Everything here is a pure transformation of a chat row (or a small private list of rows) plus the post-commit
 * effects that follow a durable write. The adapters decide HOW rows are read and committed; they never duplicate
 * these rules, so a legacy write and a SQLite write of the same input produce the same record.
 */
import { randomUUID } from 'crypto';
import { normalizeAgentTransport, parseKnownAgentTransport } from '../agent-transport.js';
import { HARNESS_PLUGIN_ID_PATTERN } from '../agent-harness/harness-plugin-contract.ts';
import { normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { normalizeSdkUiMode } from '../sdk/sdk-ui-mode.ts';
import { normalizeContextAdvisoryWarnPercent } from '../sdk/sdk-context-advisory.ts';
import { normalizeAutoContextCompressionThresholdPercent } from '../context-compression.js';
import { isSamePageUrl } from '../widget/widget-page-url.ts';
import { isChatArchived, wouldCreateChatParentCycle } from '../chat-tree.js';
import { notifyChatCreated } from '../chat-created-push.js';
import { broadcastChatListChanged } from '../chat-list-updates.js';
import { appendChatTitleHistory, setChatTitleHistorySeq } from './chat-title-history-persist.js';
import { loadChatHistory } from './chat-history-service.js';
import { listRegisteredWorkspacesForFolder } from '../workspace-registry-service.js';

/**
 * Optional gate installed by `chat-archive-guard.js`. Kept as a setter so the persist layer does not import the
 * chat-run adapter (that import cycles).
 *
 * @type {((chats: Record<string, any>[], rootId: string) => void) | null}
 */
let rejectBusyChatArchive = null;

/**
 * @param {((chats: Record<string, any>[], rootId: string) => void) | null} rejector
 * @returns {void}
 */
export function setChatArchiveRejector(rejector) {
  rejectBusyChatArchive = typeof rejector === 'function' ? rejector : null;
}

/** @type {Set<(chatId: string) => void>} */
const chatArchivedListeners = new Set();

/**
 * Subscribes to "chat archived" (every chat of an archived subtree is reported).
 * @param {(chatId: string) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onChatArchived(listener) {
  chatArchivedListeners.add(listener);
  return () => chatArchivedListeners.delete(listener);
}

/**
 * Read-only view of a chat set for the checks that need a lookup and a count.
 *
 * @typedef {{ find: (id: string) => Record<string, any> | undefined, total: number }} ChatsView
 */

/**
 * @param {Record<string, any>[]} chats
 * @returns {ChatsView}
 */
export function listView(chats) {
  return { find: (id) => chats.find((chat) => chat.id === id), total: chats.length };
}

export function normalizeAutoContextThreshold(value) {
  return normalizeAutoContextCompressionThresholdPercent(value);
}

/** Titles assigned by the backend at creation: "Claude chat 872", "Chat 3", "Local · chat 4". */
export const DEFAULT_CHAT_TITLE_RE = /^(?:\S+ )?chat \d+$/i;

/**
 * Where the current title came from. Set only by the server:
 * 'default' (placeholder), 'auto' (generated), 'manual' (user / chat_rename).
 */
export const CHAT_TITLE_SOURCES = Object.freeze(['default', 'auto', 'manual']);

/**
 * Migration for entries saved before titleSource existed: placeholder names become 'default',
 * everything else 'manual' (an old auto-name cannot be told from a manual one).
 * Temporary fork chats are not titled, so they get no source.
 *
 * @param {Record<string, any>} chat
 * @returns {'default' | 'auto' | 'manual' | ''}
 */
export function inferChatTitleSource(chat) {
  if (!chat || chat.isTemporary === true || chat.forkKind === 'title' || chat.forkKind === 'summary') return '';
  const title = typeof chat.title === 'string' ? chat.title.trim() : '';
  if (!title || DEFAULT_CHAT_TITLE_RE.test(title)) return 'default';
  if (/^\[Temp\]/i.test(title)) return '';
  return 'manual';
}

/**
 * Pure: fills a missing or unknown `titleSource` on the given record (mutates and returns it).
 *
 * @param {Record<string, any>} chat
 * @returns {Record<string, any>}
 */
export function withTitleSource(chat) {
  if (!CHAT_TITLE_SOURCES.includes(chat.titleSource)) {
    const inferred = inferChatTitleSource(chat);
    if (inferred) chat.titleSource = inferred;
  }
  return chat;
}

/**
 * Builds a chat entry pointing at a new, empty SDK session.
 *
 * @param {Record<string, any>} chat
 * @param {string} cursorSessionId
 * @returns {Record<string, any>}
 */
export function createFreshSdkContextEntry(chat, cursorSessionId) {
  if (!chat || typeof chat !== 'object') {
    throw new TypeError('Chat entry is required');
  }
  const nextCursorSessionId = String(cursorSessionId || '').trim();
  if (!nextCursorSessionId) {
    throw new TypeError('New cursor session id is required');
  }
  const nextChat = {
    ...chat,
    cursorSessionId: nextCursorSessionId,
  };
  delete /** @type {Record<string, unknown>} */ (nextChat).sdkAgentId;
  return nextChat;
}

/**
 * Resolve the transport value that is persisted for a new chat.
 *
 * Built-ins and the legacy `cursor` alias keep the global
 * {@link normalizeAgentTransport} behavior. The only exception is a local
 * harness id that the create route already loaded and verified: it is stored
 * verbatim (lowercased, pattern-checked) when, and only when, the caller sets
 * `extras.localHarnessTransport === true`. The flag is a server-internal marker
 * set exclusively by `POST /api/chats` after `classifyCreateHarness` succeeded,
 * so an unrecognized/legacy id from any other caller still falls back to `sdk`
 * and can never become an executable plugin id by accident.
 *
 * @param {unknown} raw
 * @param {Record<string, any> | null | undefined} extras
 * @returns {string}
 */
function resolvePersistedChatTransport(raw, extras) {
  const builtin = parseKnownAgentTransport(raw);
  if (builtin) return builtin;
  if (extras && extras.localHarnessTransport === true) {
    const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (token && HARNESS_PLUGIN_ID_PATTERN.test(token)) return token;
  }
  return normalizeAgentTransport(raw);
}

/**
 * Reject child creation using the current store snapshot, including callers
 * whose parent object predates its archive.
 * @param {ChatsView} view
 * @param {unknown} parentId
 * @returns {void}
 */
function assertChatParentIsLive(view, parentId) {
  const id = String(parentId || '').trim();
  if (!id) return;
  const parent = view.find(id);
  if (parent?.archived !== true && !isChatArchived(parent)) return;
  const error = /** @type {Error & { code?: string }} */ (new Error('Restore the parent chat before adding a child.'));
  error.code = 'parent_archived';
  throw error;
}

/**
 * Pure part of `addChat`: validates the parent links against `view` and builds the new record.
 *
 * @param {ChatsView} view committed chats (lookup by id and the total count)
 * @param {string} cursorSessionId
 * @param {string} [title]
 * @param {string} [workspaceFile]
 * @param {string} [workspaceFolder]
 * @param {string} [model]
 * @param {Record<string, any> | null} [extras]
 * @returns {{ existing: Record<string, any> } | { entry: Record<string, any> }}
 */
export function planAddChat(view, cursorSessionId, title, workspaceFile, workspaceFolder, model, extras = null) {
  const reservedId = String(extras?.id || '').trim();
  if (reservedId) {
    const existing = view.find(reservedId);
    if (existing) return { existing };
  }
  assertChatParentIsLive(view, extras?.forkParentChatId);
  assertChatParentIsLive(view, extras?.delegationParentChatId);
  const id = reservedId || randomUUID();
  const createdAt = new Date().toISOString();
  const transport = resolvePersistedChatTransport(extras?.agentTransport, /** @type {any} */ (extras));
  const entry = {
    id,
    title: title || 'Chat ' + (view.total + 1),
    cursorSessionId,
    createdAt,
    updatedAt: createdAt,
    agentTransport: transport,
    sdkMode: normalizeSdkMode(extras?.sdkMode),
    sdkUiMode: normalizeSdkUiMode(extras?.sdkUiMode),
  };
  if (extras && typeof extras === 'object' && typeof extras.sdkSystemPrompt === 'string') {
    const trimmedPrompt = extras.sdkSystemPrompt.trim();
    if (trimmedPrompt) entry.sdkSystemPrompt = trimmedPrompt;
  }
  if (workspaceFile) entry.workspaceFile = workspaceFile;
  if (workspaceFolder) entry.workspaceFolder = workspaceFolder;
  if (extras && typeof extras === 'object' && typeof extras.workspaceId === 'string' && extras.workspaceId.trim()) {
    entry.workspaceId = extras.workspaceId.trim();
  }
  // Explicit runner cwd, separate from the logical workspace. Absent means the
  // workspace folder is used, which keeps every existing chat unchanged.
  if (extras && typeof extras === 'object' && typeof extras.executionFolder === 'string') {
    const executionFolder = extras.executionFolder.trim();
    if (executionFolder) entry.executionFolder = executionFolder;
  }
  if (model) entry.model = model;
  if (extras && typeof extras === 'object' && extras.widgetInstallationId) {
    entry.widgetInstallationId = String(extras.widgetInstallationId);
  }
  if (extras && typeof extras === 'object' && extras.widgetPageSessionId) {
    entry.widgetPageSessionId = String(extras.widgetPageSessionId);
  }
  if (extras && typeof extras === 'object' && extras.todoId) {
    entry.todoId = String(extras.todoId);
  }
  // Marks the single durable Workspace Watcher chat. Sidebar renders it in the
  // dedicated "Workspace" section instead of the normal chat list, and the chat
  // view opens in pinned (read + command) mode rather than as a normal agent run.
  if (extras && typeof extras === 'object' && extras.watcherPinned === true) {
    entry.watcherPinned = true;
  }
  if (extras && typeof extras === 'object' && extras.isTemporary === true) {
    entry.isTemporary = true;
  }
  if (extras && typeof extras === 'object' && extras.forkParentChatId) {
    entry.forkParentChatId = String(extras.forkParentChatId);
  }
  if (extras && typeof extras === 'object' && extras.forkKind) {
    entry.forkKind = String(extras.forkKind);
  }
  if (extras && typeof extras === 'object' && extras.delegationParentChatId) {
    entry.delegationParentChatId = String(extras.delegationParentChatId);
  }
  // Delegation tree position of a child chat (see lib/delegation-tree.js).
  if (extras && typeof extras === 'object' && Number(extras.delegationDepth) >= 1) {
    entry.delegationDepth = Math.floor(Number(extras.delegationDepth));
  }
  if (extras && typeof extras === 'object' && extras.delegationRootChatId) {
    entry.delegationRootChatId = String(extras.delegationRootChatId);
  }
  if (extras && typeof extras === 'object' && extras.delegationRootDelegationId) {
    entry.delegationRootDelegationId = String(extras.delegationRootDelegationId);
  }
  // Internal grant hook: lets a child chat start a nested delegation.
  if (extras && typeof extras === 'object' && extras.delegationGrant === true) {
    entry.delegationGrant = true;
  }
  // Which automatic model-pick purpose chose this chat's model (see
  // lib/model-pick-service.js); counted as role usage so picks rotate.
  if (extras && typeof extras === 'object' && extras.pickPurpose) {
    entry.pickPurpose = String(extras.pickPurpose);
  }
  if (extras && typeof extras === 'object' && extras.delegationId) {
    entry.delegationId = String(extras.delegationId);
  }
  if (extras && typeof extras === 'object' && extras.delegationAssignment) {
    entry.delegationAssignment = String(extras.delegationAssignment);
  }
  if (extras && typeof extras === 'object' && extras.delegationSessionIdentity) {
    entry.delegationSessionIdentity = String(extras.delegationSessionIdentity).trim();
    entry.delegationSessionGeneration = Math.max(
      0,
      Math.floor(Number(extras.delegationSessionGeneration) || 0),
    );
  }
  if (extras && typeof extras === 'object' && Array.isArray(extras.summaries)) {
    entry.summaries = JSON.parse(JSON.stringify(extras.summaries));
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionEnabled === true) {
    entry.autoContextCompressionEnabled = true;
  }
  if (extras && typeof extras === 'object' && Object.prototype.hasOwnProperty.call(extras, 'autoContextCompressionThreshold')) {
    entry.autoContextCompressionThreshold = normalizeAutoContextThreshold(
      extras.autoContextCompressionThreshold
    );
  }
  if (extras && typeof extras === 'object' && extras.autoContextCompressionReset === false) {
    entry.autoContextCompressionReset = false;
  }
  if (extras && typeof extras === 'object' && extras.opencodeSessionId) {
    entry.opencodeSessionId = String(extras.opencodeSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codebuddySessionId) {
    entry.codebuddySessionId = String(extras.codebuddySessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.deepseekSessionId) {
    entry.deepseekSessionId = String(extras.deepseekSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.codexThreadId) {
    entry.codexThreadId = String(extras.codexThreadId).trim();
  }
  if (extras && typeof extras === 'object' && extras.antigravitySessionId) {
    entry.antigravitySessionId = String(extras.antigravitySessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.qwenSessionId) {
    entry.qwenSessionId = String(extras.qwenSessionId).trim();
  }
  if (extras && typeof extras === 'object' && extras.claudeSessionId) {
    entry.claudeSessionId = String(extras.claudeSessionId).trim();
  }
  withTitleSource(entry);
  return { entry };
}

/**
 * Ids a `addChat` call must look up before it can build the record (the reserved id and the parents).
 *
 * @param {Record<string, any> | null | undefined} extras
 * @returns {string[]}
 */
export function addChatLookupIds(extras) {
  return [extras?.id, extras?.forkParentChatId, extras?.delegationParentChatId]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

/** Effects of a durable create; the caller runs them after COMMIT (or after the legacy atomic rename). */
export function publishChatCreated(entry) {
  broadcastChatListChanged({ reason: 'create', chatId: entry.id });
  // Temporary fork chats (title/summary helpers) are internal and stay silent.
  if (entry.isTemporary !== true) {
    notifyChatCreated({ chatId: entry.id, chatTitle: entry.title });
  }
}


/**
 * Applies `updates` to `chats[idx]` (and, for archive / widget pin / parent moves, to the other rows of the list).
 * The list must be private to the caller. Returns what the post-commit effects need.
 *
 * @param {Record<string, any>[]} chats
 * @param {number} idx
 * @param {string} id
 * @param {Record<string, any>} updates
 * @returns {{ titleChanged: boolean, nextTitle: string, archiveListReason: string, newlyArchivedIds: string[] }}
 */
export function applyChatUpdates(chats, idx, id, updates) {
  // A title coming through updateChat is a manual rename (PATCH, chat_rename); generators use applyAutoTitle.
  const nextTitle = typeof updates.title === 'string' ? updates.title.trim() : '';
  const titleChanged = Boolean(nextTitle) && nextTitle !== chats[idx].title;
  if (nextTitle) {
    chats[idx].title = nextTitle;
    chats[idx].titleSource = 'manual';
    if (titleChanged) chats[idx].titleRev = (Number(chats[idx].titleRev) || 0) + 1;
  }
  if (updates.model !== undefined) chats[idx].model = updates.model || undefined;
  if (updates.sdkMode !== undefined) chats[idx].sdkMode = normalizeSdkMode(updates.sdkMode);
  if (updates.sdkUiMode !== undefined) {
    chats[idx].sdkUiMode = normalizeSdkUiMode(updates.sdkUiMode);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'sdkSystemPrompt')) {
    const nextPrompt = updates.sdkSystemPrompt == null ? '' : String(updates.sdkSystemPrompt).trim();
    if (nextPrompt) chats[idx].sdkSystemPrompt = nextPrompt;
    else delete chats[idx].sdkSystemPrompt;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'todoId')) {
    const nextTodoId = updates.todoId == null ? '' : String(updates.todoId).trim();
    if (nextTodoId) chats[idx].todoId = nextTodoId;
    else delete chats[idx].todoId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationId')) {
    const nextDelegationId = updates.delegationId == null ? '' : String(updates.delegationId).trim();
    if (nextDelegationId) chats[idx].delegationId = nextDelegationId;
    else delete chats[idx].delegationId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationGrant')) {
    if (updates.delegationGrant === true) chats[idx].delegationGrant = true;
    else delete chats[idx].delegationGrant;
  }
  if (Number(updates.delegationDepth) >= 1) {
    chats[idx].delegationDepth = Math.floor(Number(updates.delegationDepth));
  }
  // Orchestration takeover re-points a child chat at its new controller.
  if (updates.delegationParentChatId) chats[idx].delegationParentChatId = String(updates.delegationParentChatId);
  if (updates.delegationRootChatId) chats[idx].delegationRootChatId = String(updates.delegationRootChatId);
  if (updates.delegationRootDelegationId) {
    chats[idx].delegationRootDelegationId = String(updates.delegationRootDelegationId);
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationAssignment')) {
    const nextAssignment = updates.delegationAssignment == null
      ? ''
      : String(updates.delegationAssignment).trim();
    if (nextAssignment) chats[idx].delegationAssignment = nextAssignment;
    else delete chats[idx].delegationAssignment;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationSessionIdentity')) {
    const identity = updates.delegationSessionIdentity == null
      ? ''
      : String(updates.delegationSessionIdentity).trim();
    if (identity) chats[idx].delegationSessionIdentity = identity;
    else delete chats[idx].delegationSessionIdentity;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'delegationSessionGeneration')) {
    chats[idx].delegationSessionGeneration = Math.max(
      0,
      Math.floor(Number(updates.delegationSessionGeneration) || 0),
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'executionFolder')) {
    const nextExecution = updates.executionFolder == null ? '' : String(updates.executionFolder).trim();
    if (nextExecution) chats[idx].executionFolder = nextExecution;
    else delete chats[idx].executionFolder;
  }
  if (typeof updates.summary === 'string' && updates.summary.trim()) {
    if (!Array.isArray(chats[idx].summaries)) chats[idx].summaries = [];
    /** @type {any[]} */ (chats[idx].summaries).push({
      summary: updates.summary.trim(),
      title: typeof updates.summaryTitle === 'string' ? updates.summaryTitle.trim() : undefined,
      at: new Date().toISOString(),
    });
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionEnabled')) {
    chats[idx].autoContextCompressionEnabled = updates.autoContextCompressionEnabled === true;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionThreshold')) {
    chats[idx].autoContextCompressionThreshold = normalizeAutoContextThreshold(
      updates.autoContextCompressionThreshold
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'autoContextCompressionReset')) {
    chats[idx].autoContextCompressionReset = updates.autoContextCompressionReset !== false;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextSettings')) {
    // Validated by the context settings resolver before it reaches this layer.
    const incoming = /** @type {any} */ (updates).contextSettings;
    if (incoming && typeof incoming === 'object') /** @type {any} */ (chats[idx]).contextSettings = incoming;
    else delete (/** @type {any} */ (chats[idx])).contextSettings;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryEnabled')) {
    if (updates.contextAdvisoryEnabled === false) chats[idx].contextAdvisoryEnabled = false;
    else delete chats[idx].contextAdvisoryEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'contextAdvisoryWarnPercent')) {
    chats[idx].contextAdvisoryWarnPercent = normalizeContextAdvisoryWarnPercent(
      updates.contextAdvisoryWarnPercent
    );
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'opencodeSessionId')) {
    const nextId = updates.opencodeSessionId == null ? '' : String(updates.opencodeSessionId).trim();
    if (nextId) chats[idx].opencodeSessionId = nextId;
    else delete chats[idx].opencodeSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codebuddySessionId')) {
    const nextId = updates.codebuddySessionId == null ? '' : String(updates.codebuddySessionId).trim();
    if (nextId) chats[idx].codebuddySessionId = nextId;
    else delete chats[idx].codebuddySessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'deepseekSessionId')) {
    const nextId = updates.deepseekSessionId == null ? '' : String(updates.deepseekSessionId).trim();
    if (nextId) chats[idx].deepseekSessionId = nextId;
    else delete chats[idx].deepseekSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'codexThreadId')) {
    const nextId = updates.codexThreadId == null ? '' : String(updates.codexThreadId).trim();
    if (nextId) chats[idx].codexThreadId = nextId;
    else delete chats[idx].codexThreadId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'antigravitySessionId')) {
    const nextId = updates.antigravitySessionId == null ? '' : String(updates.antigravitySessionId).trim();
    if (nextId) chats[idx].antigravitySessionId = nextId;
    else delete chats[idx].antigravitySessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'qwenSessionId')) {
    const nextId = updates.qwenSessionId == null ? '' : String(updates.qwenSessionId).trim();
    if (nextId) chats[idx].qwenSessionId = nextId;
    else delete chats[idx].qwenSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'claudeSessionId')) {
    const nextId = updates.claudeSessionId == null ? '' : String(updates.claudeSessionId).trim();
    if (nextId) chats[idx].claudeSessionId = nextId;
    else delete chats[idx].claudeSessionId;
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
    const nextParent = updates.forkParentChatId == null ? '' : String(updates.forkParentChatId).trim();
    if (!nextParent) {
      delete chats[idx].forkParentChatId;
    } else if (nextParent === id) {
      throw new Error('Chat cannot be nested under itself');
    } else if (!chats.some((chat) => chat.id === nextParent)) {
      throw new Error('Parent chat not found');
    } else if (wouldCreateChatParentCycle(chats, id, nextParent)) {
      throw new Error('Cannot nest a chat under its descendant');
    } else {
      assertChatParentIsLive(listView(chats), nextParent);
      chats[idx].forkParentChatId = nextParent;
    }
  }
  let archiveListReason = '';
  /** @type {string[]} */
  let newlyArchivedIds = [];
  if (Object.prototype.hasOwnProperty.call(updates, 'archived')) {
    const archivedAt = updates.archived === true ? new Date().toISOString() : '';
    if (archivedAt && rejectBusyChatArchive) {
      rejectBusyChatArchive(chats, id);
    }
    // Archiving a parent moves the complete nested tree into the archive. Use
    // the same parent relation as the sidebar, and walk transitively so deep
    // descendants cannot remain visible without their ancestor.
    const subtreeIds = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const chat of chats) {
        const parentId = typeof chat.forkParentChatId === 'string'
          ? chat.forkParentChatId.trim()
          : '';
        if (parentId && subtreeIds.has(parentId) && !subtreeIds.has(chat.id)) {
          subtreeIds.add(chat.id);
          changed = true;
        }
      }
    }
    for (const chat of chats) {
      if (!subtreeIds.has(chat.id)) continue;
      if (archivedAt) chat.archivedAt = archivedAt;
      else delete chat.archivedAt;
      chat.updatedAt = new Date().toISOString();
    }
    archiveListReason = updates.archived === true ? 'archive' : 'restore';
    if (archivedAt) newlyArchivedIds = [...subtreeIds];
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'widgetPinnedUrl')) {
    const nextPinnedUrl = updates.widgetPinnedUrl == null ? '' : String(updates.widgetPinnedUrl).trim();
    if (nextPinnedUrl) {
      for (let i = 0; i < chats.length; i += 1) {
        if (i === idx) continue;
        const otherPinnedUrl = typeof chats[i].widgetPinnedUrl === 'string'
          ? /** @type {string} */ (chats[i].widgetPinnedUrl).trim()
          : '';
        if (otherPinnedUrl && isSamePageUrl(otherPinnedUrl, nextPinnedUrl)) {
          delete chats[i].widgetPinnedUrl;
        }
      }
      chats[idx].widgetPinnedUrl = nextPinnedUrl;
    } else {
      delete chats[idx].widgetPinnedUrl;
    }
  }
  chats[idx].updatedAt = new Date().toISOString();
  return { titleChanged, nextTitle, archiveListReason, newlyArchivedIds };
}

async function currentHeadSeq(chatId) {
  const doc = await loadChatHistory(chatId);
  return doc && Number.isFinite(doc.headSeq) ? doc.headSeq : undefined;
}

/**
 * Title-history `seq` is a derived annotation (the history head at the time of the rename). The rename itself must
 * not wait for the async history adapter, so the annotation is added after the fact. A failed read leaves the entry
 * without `seq`; it never fails or delays the rename.
 *
 * @param {string} chatId
 * @param {string} title
 */
export function annotateTitleHistorySeq(chatId, title) {
  void currentHeadSeq(chatId)
    .then((seq) => { if (seq !== undefined) setChatTitleHistorySeq(chatId, title, seq); })
    .catch(() => {});
}

/**
 * Effects of a durable `updateChat`: archive listeners, title history, list broadcast.
 *
 * @param {string} id
 * @param {Record<string, any>} chat the committed row
 * @param {Record<string, any>} updates
 * @param {{ titleChanged: boolean, nextTitle: string, archiveListReason: string, newlyArchivedIds: string[] }} info
 */
export function publishChatUpdated(id, chat, updates, info) {
  for (const archivedId of info.newlyArchivedIds) {
    for (const listener of chatArchivedListeners) {
      try { listener(archivedId); } catch { /* A subscriber must not fail archiving. */ }
    }
  }
  if (info.titleChanged) {
    appendChatTitleHistory(id, { title: info.nextTitle, source: 'manual', reason: 'rename' });
    annotateTitleHistorySeq(id, info.nextTitle);
  }
  if (info.archiveListReason) {
    broadcastChatListChanged({ reason: info.archiveListReason, chatId: id });
  } else if (info.titleChanged) {
    // The frame carries the row content so clients patch one row instead of refetching the list.
    broadcastChatListChanged({ reason: 'title', chatId: id, title: chat.title, titleSource: /** @type {string} */ (chat.titleSource) });
  } else if (Object.prototype.hasOwnProperty.call(updates, 'forkParentChatId')) {
    broadcastChatListChanged({ reason: 'nest', chatId: id });
  }
}

/**
 * Sets the read markers on a private row copy. Returns the new state, or null when nothing changed.
 *
 * @param {Record<string, any>} chat
 * @param {{ finishedAt?: string, seenAt?: string }} marks
 * @returns {{ lastFinishedAt: string, lastSeenAt: string } | null}
 */
export function applyReadMarks(chat, marks = {}) {
  const finishedAt = typeof marks.finishedAt === 'string' ? marks.finishedAt.trim() : '';
  const seenAt = typeof marks.seenAt === 'string' ? marks.seenAt.trim() : '';
  const postponedAt = typeof marks.archivePostponedAt === 'string' ? marks.archivePostponedAt.trim() : '';
  let changed = false;
  if (finishedAt && chat.lastFinishedAt !== finishedAt) {
    chat.lastFinishedAt = finishedAt;
    changed = true;
  }
  if (seenAt && chat.lastSeenAt !== seenAt) {
    chat.lastSeenAt = seenAt;
    changed = true;
  }
  // "Postpone auto-archive" restarts the idle window without touching `updatedAt`
  // (list paging order) or the read marker the unread check depends on.
  if (postponedAt && chat.autoArchivePostponedAt !== postponedAt) {
    chat.autoArchivePostponedAt = postponedAt;
    changed = true;
  }
  if (!changed) return null;
  return {
    lastFinishedAt: String(chat.lastFinishedAt || ''),
    lastSeenAt: String(chat.lastSeenAt || ''),
    autoArchivePostponedAt: String(chat.autoArchivePostponedAt || ''),
  };
}

/** @param {string} id @param {{ lastFinishedAt: string, lastSeenAt: string, autoArchivePostponedAt?: string }} state */
export function publishChatRead(id, state) {
  broadcastChatListChanged({ reason: 'read', chatId: id, ...state });
}

/**
 * The only place that decides "auto never overwrites manual". Mutates the private row only when it applies.
 *
 * @param {Record<string, any>} chat
 * @param {string} title
 * @param {{ reason?: string, expectedVersion?: number, force?: boolean }} [options]
 * @returns {{ applied: boolean, skipped?: 'empty' | 'manual' | 'stale' | 'unchanged', nextTitle: string }}
 */
export function applyAutoTitleToRow(chat, title, options = {}) {
  const nextTitle = typeof title === 'string' ? title.trim() : '';
  if (!nextTitle) return { applied: false, skipped: 'empty', nextTitle };
  if (chat.titleSource === 'manual' && options.force !== true) return { applied: false, skipped: 'manual', nextTitle };
  if (Number.isFinite(options.expectedVersion) && (Number(chat.titleRev) || 0) !== options.expectedVersion) {
    return { applied: false, skipped: 'stale', nextTitle };
  }
  if (nextTitle === chat.title && chat.titleSource === 'auto') return { applied: false, skipped: 'unchanged', nextTitle };
  chat.title = nextTitle;
  chat.titleSource = 'auto';
  chat.titleRev = (Number(chat.titleRev) || 0) + 1;
  chat.updatedAt = new Date().toISOString();
  return { applied: true, nextTitle };
}

/** @param {string} id @param {Record<string, any>} chat @param {string} nextTitle @param {string} [reason] */
export function publishAutoTitle(id, chat, nextTitle, reason) {
  appendChatTitleHistory(id, { title: nextTitle, source: 'auto', reason: reason || 'auto' });
  annotateTitleHistorySeq(id, nextTitle);
  broadcastChatListChanged({ reason: 'title', chatId: id, title: chat.title, titleSource: /** @type {string} */ (chat.titleSource) });
}

/**
 * Title lock toggle on a private row copy. Returns false when the source is already right (no write).
 *
 * @param {Record<string, any>} chat
 * @param {boolean} locked
 * @returns {boolean} true when the row changed
 */
export function applyTitleLock(chat, locked) {
  const next = locked === true
    ? 'manual'
    : (DEFAULT_CHAT_TITLE_RE.test(String(chat.title || '').trim()) ? 'default' : 'auto');
  if (chat.titleSource === next) return false;
  chat.titleSource = next;
  chat.titleRev = (Number(chat.titleRev) || 0) + 1;
  chat.updatedAt = new Date().toISOString();
  return true;
}

/** @param {string} id @param {Record<string, any>} chat */
export function publishTitleLock(id, chat) {
  broadcastChatListChanged({ reason: 'title', chatId: id, title: chat.title, titleSource: chat.titleSource });
}

/** Session-id style fields set by the server (not through the public PATCH). */
export const CHAT_SESSION_FIELDS = Object.freeze([
  'antigravitySessionId', 'sdkAgentId', 'opencodeSessionId', 'codebuddySessionId', 'deepseekSessionId', 'codexThreadId', 'qwenSessionId', 'claudeSessionId',
]);

/**
 * Sets (or removes, for an empty value) one session-id field on a private row copy. The Claude session id skips
 * the write when it is unchanged, as before. Returns whether the row must be written.
 *
 * @param {Record<string, any>} chat
 * @param {string} field one of CHAT_SESSION_FIELDS
 * @param {unknown} value
 * @returns {boolean}
 */
export function applySessionField(chat, field, value) {
  if (!CHAT_SESSION_FIELDS.includes(field)) throw new TypeError(`Unknown chat session field: ${field}`);
  const trimmed = value == null ? '' : String(value).trim();
  if (field === 'claudeSessionId' && String(chat.claudeSessionId || '') === trimmed) return false;
  if (!trimmed) delete chat[field];
  else chat[field] = trimmed;
  chat.updatedAt = new Date().toISOString();
  return true;
}

/**
 * Detaches the chat from its old agent and local store by rotating the SDK session key.
 *
 * @param {Record<string, any>} chat
 * @returns {Record<string, any>} the replacement record
 */
export function rotatedSdkChat(chat) {
  const next = createFreshSdkContextEntry(chat, randomUUID());
  next.updatedAt = new Date().toISOString();
  return next;
}

const FORK_TEMP_TITLES = Object.freeze({
  title: '[Temp] Chat title',
  summary: '[Temp] Summary',
});

/** @param {'title'|'summary'} forkKind @returns {string} */
export function temporaryForkTitle(forkKind) {
  return FORK_TEMP_TITLES[forkKind] || '[Temp] Agent';
}

/** @param {Record<string, any>} c @param {string} parentChatId @param {string} [forkKind] */
export function isTemporaryForkOf(c, parentChatId, forkKind) {
  return Boolean(c) && c.isTemporary === true && c.forkParentChatId === parentChatId && (!forkKind || c.forkKind === forkKind);
}

/**
 * Arguments of the `addChat` call that creates a persistent conversation fork of `parentChat`.
 *
 * @param {Record<string, any>} parentChat
 * @param {Record<string, any> | null} [overrides]
 * @returns {[string, string, string | undefined, string | undefined, string | undefined, Record<string, any>]}
 */
export function conversationForkArgs(parentChat, overrides = null) {
  if (!parentChat?.id) {
    throw new TypeError('Parent chat is required');
  }
  const overrideTitle = typeof overrides?.title === 'string' ? overrides.title.trim() : '';
  const title = overrideTitle || `${parentChat.title || 'Chat'} (fork)`;
  const overrideWorkspaceFile =
    typeof overrides?.workspaceFile === 'string' ? overrides.workspaceFile.trim() : '';
  const overrideWorkspaceFolder =
    typeof overrides?.workspaceFolder === 'string' ? overrides.workspaceFolder.trim() : '';
  const overrideModel = typeof overrides?.model === 'string' ? overrides.model.trim() : '';
  const hasTransportOverride =
    typeof overrides?.agentTransport === 'string' && overrides.agentTransport.trim() !== '';
  const workspaceFile = overrideWorkspaceFile || parentChat.workspaceFile;
  const workspaceFolder = overrideWorkspaceFolder || parentChat.workspaceFolder;
  const model = overrideModel || parentChat.model;
  const forkKind =
    typeof overrides?.forkKind === 'string' && overrides.forkKind.trim()
      ? overrides.forkKind.trim()
      : 'conversation';
  const extras = {
    agentTransport: hasTransportOverride
      ? normalizeAgentTransport(overrides.agentTransport)
      : parentChat.agentTransport,
    sdkMode: parentChat.sdkMode,
    sdkUiMode: parentChat.sdkUiMode,
    sdkSystemPrompt: parentChat.sdkSystemPrompt,
    forkParentChatId: parentChat.id,
    forkKind,
  };
  if (forkKind !== 'analyze') {
    // A reference fork points at the parent history, so it does not copy summaries.
    if (forkKind !== 'reference') extras.summaries = parentChat.summaries;
    extras.autoContextCompressionEnabled = parentChat.autoContextCompressionEnabled === true;
    extras.autoContextCompressionThreshold = parentChat.autoContextCompressionThreshold;
    extras.autoContextCompressionReset = parentChat.autoContextCompressionReset;
  }
  return [randomUUID(), title, workspaceFile, workspaceFolder, model, extras];
}

/**
 * Fills `workspaceId` on chats whose folder belongs to exactly one registry workspace. Mutates the given rows
 * only when `dryRun` is false; the caller persists the rows listed in `assignments`.
 *
 * @param {Record<string, any>[]} chats private rows
 * @param {Record<string, any>} settings
 * @param {{ dryRun?: boolean }} [options]
 */
export function migrateWorkspaceIdsOnList(chats, settings, options = {}) {
  const dryRun = options.dryRun !== false;
  const report = { dryRun, total: chats.length, updated: 0, alreadySet: 0, noFolder: 0, unmatched: 0, ambiguous: 0, assignments: /** @type {Array<{ chatId: string, workspaceId: string }>} */ ([]) };
  for (const chat of chats) {
    if (String(chat.workspaceId || '').trim()) { report.alreadySet++; continue; }
    const folder = String(chat.workspaceFolder || '').trim();
    if (!folder) { report.noFolder++; continue; }
    const rows = listRegisteredWorkspacesForFolder(settings, folder);
    if (rows.length === 0) { report.unmatched++; continue; }
    if (rows.length > 1) { report.ambiguous++; continue; }
    report.assignments.push({ chatId: chat.id, workspaceId: rows[0].id });
    report.updated++;
    if (!dryRun) chat.workspaceId = rows[0].id;
  }
  return report;
}
