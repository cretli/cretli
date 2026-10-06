/**
 * Time-sliced GET /api/chats reconcile into runtime rows (task 8.1).
 */

import { normalizeSdkMode } from '../../../lib/sdk/sdk-mode.js';
import { normalizeSdkUiMode } from '../../../lib/sdk/sdk-ui-mode.js';
import {
  isBlockingPersistedLocalChatHarnessState,
  resolvePersistedLocalChatTransport,
} from './persistedLocalChatState.js';
import {
  createSliceSession,
  forEachInTimeSlices,
} from '../../lib/schedulerYield.js';

/** Reconcile with yields when the server payload exceeds this row count. */
export const CHAT_LIST_SERVER_RECONCILE_SLICE_THRESHOLD = 64;

/**
 * @param {object | null | undefined} existing
 * @param {object} serverChat
 * @param {{
 *   readChatBufferForChatRestore: (id: string, flag: boolean) => unknown[] | null | undefined,
 *   chatBufferMax: number,
 *   blockedTransitions: object[],
 *   restoredTransitions: object[],
 * }} ctx
 * @returns {object}
 */
export function mergeExistingChatFromServerRow(existing, serverChat, ctx) {
  delete existing._fromBootCache;
  const wasBlocked = isBlockingPersistedLocalChatHarnessState(existing);
  existing.title = serverChat.title;
  if (typeof serverChat.titleSource === 'string' && serverChat.titleSource) {
    existing.titleSource = serverChat.titleSource;
  } else {
    delete existing.titleSource;
  }
  existing.cursorSessionId = serverChat.cursorSessionId;
  existing.model = serverChat.model;
  existing.workspaceFile = serverChat.workspaceFile;
  existing.workspaceFolder = serverChat.workspaceFolder;
  existing.createdAt = serverChat.createdAt;
  existing.updatedAt = serverChat.updatedAt;
  existing.summaries = Array.isArray(serverChat.summaries)
    ? serverChat.summaries
    : (Array.isArray(existing.summaries) ? existing.summaries : []);
  existing.agentTransport = resolvePersistedLocalChatTransport(serverChat);
  existing.sdkMode = normalizeSdkMode(serverChat.sdkMode);
  existing.sdkUiMode = normalizeSdkUiMode(serverChat.sdkUiMode);
  existing.autoContextCompressionEnabled = serverChat.autoContextCompressionEnabled === true;
  existing.autoContextCompressionThreshold = Number.isFinite(
    Number(serverChat.autoContextCompressionThreshold)
  )
    ? Number(serverChat.autoContextCompressionThreshold)
    : 80;
  existing.autoContextCompressionReset = serverChat.autoContextCompressionReset !== false;
  if (serverChat.harnessState && typeof serverChat.harnessState === 'object') {
    existing.harnessState = serverChat.harnessState;
  } else {
    delete existing.harnessState;
  }
  if (!wasBlocked && isBlockingPersistedLocalChatHarnessState(existing)) {
    ctx.blockedTransitions.push(existing);
  } else if (wasBlocked && !isBlockingPersistedLocalChatHarnessState(existing)) {
    ctx.restoredTransitions.push(existing);
  }
  if (typeof serverChat.sdkAgentId === 'string' && serverChat.sdkAgentId.trim()) {
    existing.sdkAgentId = serverChat.sdkAgentId.trim();
  } else {
    delete existing.sdkAgentId;
  }
  if (typeof serverChat.todoId === 'string' && serverChat.todoId.trim()) {
    existing.todoId = serverChat.todoId.trim();
  } else {
    delete existing.todoId;
  }
  if (serverChat.isTemporary === true) {
    existing.isTemporary = true;
  } else {
    delete existing.isTemporary;
  }
  if (serverChat.watcherPinned === true) {
    existing.watcherPinned = true;
  } else {
    delete existing.watcherPinned;
  }
  if (typeof serverChat.forkParentChatId === 'string' && serverChat.forkParentChatId.trim()) {
    existing.forkParentChatId = serverChat.forkParentChatId.trim();
  } else {
    delete existing.forkParentChatId;
  }
  if (typeof serverChat.forkKind === 'string' && serverChat.forkKind.trim()) {
    existing.forkKind = serverChat.forkKind.trim();
  } else {
    delete existing.forkKind;
  }
  if (typeof serverChat.widgetPinnedUrl === 'string' && serverChat.widgetPinnedUrl.trim()) {
    existing.widgetPinnedUrl = serverChat.widgetPinnedUrl.trim();
  } else {
    delete existing.widgetPinnedUrl;
  }
  if (typeof serverChat.archivedAt === 'string' && serverChat.archivedAt.trim()) {
    existing.archivedAt = serverChat.archivedAt.trim();
  } else {
    delete existing.archivedAt;
  }
  if (!existing._buffer) {
    const saved = ctx.readChatBufferForChatRestore(serverChat.id, true);
    if (saved && saved.length > 0) existing._buffer = saved.slice(-ctx.chatBufferMax);
  }
  return existing;
}

/**
 * @param {object} serverChat
 * @param {{
 *   readChatBufferForChatRestore: (id: string, flag: boolean) => unknown[] | null | undefined,
 *   chatBufferMax: number,
 *   hydratePresenceChat: (chat: object) => boolean,
 *   presenceDirtyIds: string[],
 * }} ctx
 * @returns {object}
 */
export function createRuntimeChatFromServerRow(serverChat, ctx) {
  const created = {
    id: serverChat.id,
    title: serverChat.title,
    titleSource: typeof serverChat.titleSource === 'string' ? serverChat.titleSource : undefined,
    cursorSessionId: serverChat.cursorSessionId,
    model: serverChat.model,
    workspaceFile: serverChat.workspaceFile,
    workspaceFolder: serverChat.workspaceFolder,
    createdAt: serverChat.createdAt,
    updatedAt: serverChat.updatedAt,
    summaries: Array.isArray(serverChat.summaries) ? serverChat.summaries : [],
    agentTransport: resolvePersistedLocalChatTransport(serverChat),
    sdkMode: normalizeSdkMode(serverChat.sdkMode),
    sdkUiMode: normalizeSdkUiMode(serverChat.sdkUiMode),
    autoContextCompressionEnabled: serverChat.autoContextCompressionEnabled === true,
    autoContextCompressionThreshold: Number.isFinite(
      Number(serverChat.autoContextCompressionThreshold)
    )
      ? Number(serverChat.autoContextCompressionThreshold)
      : 80,
    autoContextCompressionReset: serverChat.autoContextCompressionReset !== false,
  };
  if (serverChat.harnessState && typeof serverChat.harnessState === 'object') {
    created.harnessState = serverChat.harnessState;
  }
  if (typeof serverChat.sdkAgentId === 'string' && serverChat.sdkAgentId.trim()) {
    created.sdkAgentId = serverChat.sdkAgentId.trim();
  }
  if (typeof serverChat.todoId === 'string' && serverChat.todoId.trim()) {
    created.todoId = serverChat.todoId.trim();
  }
  if (serverChat.isTemporary === true) {
    created.isTemporary = true;
  }
  if (serverChat.watcherPinned === true) {
    created.watcherPinned = true;
  }
  if (typeof serverChat.forkParentChatId === 'string' && serverChat.forkParentChatId.trim()) {
    created.forkParentChatId = serverChat.forkParentChatId.trim();
  }
  if (typeof serverChat.forkKind === 'string' && serverChat.forkKind.trim()) {
    created.forkKind = serverChat.forkKind.trim();
  }
  if (typeof serverChat.widgetPinnedUrl === 'string' && serverChat.widgetPinnedUrl.trim()) {
    created.widgetPinnedUrl = serverChat.widgetPinnedUrl.trim();
  }
  if (typeof serverChat.archivedAt === 'string' && serverChat.archivedAt.trim()) {
    created.archivedAt = serverChat.archivedAt.trim();
  }
  const saved = ctx.readChatBufferForChatRestore(created.id, true);
  if (saved && saved.length > 0) created._buffer = saved.slice(-ctx.chatBufferMax);
  if (ctx.hydratePresenceChat(created)) ctx.presenceDirtyIds.push(created.id);
  return created;
}

/**
 * @param {object} serverChat
 * @param {Map<string, object>} runtimeById
 * @param {object} ctx
 * @returns {object}
 */
export function reconcileOneServerChatRow(serverChat, runtimeById, ctx) {
  const existing = runtimeById.get(serverChat.id);
  if (existing) return mergeExistingChatFromServerRow(existing, serverChat, ctx);
  return createRuntimeChatFromServerRow(serverChat, ctx);
}

/**
 * @param {object[]} serverChats
 * @param {Map<string, object>} runtimeById
 * @param {object} ctx
 * @returns {object[]}
 */
export function reconcileServerChatsSync(serverChats, runtimeById, ctx) {
  const list = Array.isArray(serverChats) ? serverChats : [];
  return list.map((serverChat) => reconcileOneServerChatRow(serverChat, runtimeById, ctx));
}

/**
 * @param {object[]} serverChats
 * @param {Map<string, object>} runtimeById
 * @param {object} ctx
 * @param {{
 *   isApplyFresh?: () => boolean,
 *   deps?: import('../../lib/schedulerYield.js').SchedulerYieldDeps,
 *   budgetMs?: number,
 *   session?: ReturnType<typeof createSliceSession>,
 * }} [options]
 * @returns {Promise<{ rows: object[], cancelled: boolean }>}
 */
export async function reconcileServerChatsInTimeSlices(
  serverChats,
  runtimeById,
  ctx,
  options = {},
) {
  const list = Array.isArray(serverChats) ? serverChats : [];
  const isApplyFresh = typeof options.isApplyFresh === 'function' ? options.isApplyFresh : () => true;
  if (list.length <= CHAT_LIST_SERVER_RECONCILE_SLICE_THRESHOLD) {
    return { rows: reconcileServerChatsSync(list, runtimeById, ctx), cancelled: false };
  }
  const session = options.session || createSliceSession();
  /** @type {object[]} */
  const rows = [];
  const result = await forEachInTimeSlices(list, {
    session,
    deps: options.deps,
    budgetMs: options.budgetMs,
    onItem: (serverChat) => {
      if (!isApplyFresh()) return;
      rows.push(reconcileOneServerChatRow(serverChat, runtimeById, ctx));
    },
  });
  const cancelled = result.cancelled || !isApplyFresh();
  return { rows, cancelled };
}
