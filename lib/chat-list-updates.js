/**
 * Notify connected chat UIs when the chat list or agent presence changes.
 */

import { WS_BACKPRESSURE_THRESHOLD_BYTES } from './sdk/sdk-ws-transport.js';

/**
 * @typedef {{ kind: 'session' } | { kind: 'widget', chatIds: Set<string> } | { kind: 'mcp' }} ChatListScopeBase
 * @typedef {ChatListScopeBase & { workspaceFolder?: string }} ChatListScope
 * @typedef {{ scope: ChatListScope }} ChatListClient
 */

/** @type {Map<import('ws').WebSocket, ChatListClient>} */
const clients = new Map();

/** @type {((ws: import('ws').WebSocket, scope: ChatListScope) => void) | null} */
let subscribeHook = null;

/**
 * @param {(ws: import('ws').WebSocket, scope: ChatListScope) => void} hook
 * @returns {void}
 */
export function setChatListSubscribeHook(hook) {
  subscribeHook = typeof hook === 'function' ? hook : null;
}

/**
 * @param {object | null | undefined} scope
 * @returns {ChatListScope}
 */
export function normalizeChatListScope(scope) {
  const workspaceFolder = String(scope?.workspaceFolder || '').trim();
  if (scope?.kind === 'widget') {
    const chatIds = new Set(
      [...(scope.chatIds || [])].map((id) => String(id || '').trim()).filter(Boolean)
    );
    return workspaceFolder ? { kind: 'widget', chatIds, workspaceFolder } : { kind: 'widget', chatIds };
  }
  if (scope?.kind === 'mcp') {
    return workspaceFolder ? { kind: 'mcp', workspaceFolder } : { kind: 'mcp' };
  }
  return workspaceFolder ? { kind: 'session', workspaceFolder } : { kind: 'session' };
}

/**
 * @param {ChatListScope} scope
 * @returns {string}
 */
export function chatListScopeKey(scope) {
  const workspaceSuffix = scope?.workspaceFolder ? `:${scope.workspaceFolder}` : '';
  if (scope?.kind === 'widget') {
    return `widget:${[...scope.chatIds].sort().join(',')}${workspaceSuffix}`;
  }
  if (scope?.kind === 'mcp') return `mcp${workspaceSuffix}`;
  return `session${workspaceSuffix}`;
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {object} [scope]
 * @returns {void}
 */
export function subscribeChatListUpdates(ws, scope = { kind: 'session' }) {
  if (!ws) return;
  const nextScope = normalizeChatListScope(scope);
  const existing = clients.get(ws);
  if (existing) {
    existing.scope = nextScope;
    return;
  }
  clients.set(ws, { scope: nextScope });
  ws.once('close', () => unsubscribeChatListUpdates(ws));
  if (typeof subscribeHook === 'function') subscribeHook(ws, nextScope);
}

/**
 * @param {import('ws').WebSocket} ws
 * @returns {void}
 */
export function unsubscribeChatListUpdates(ws) {
  clients.delete(ws);
}

/**
 * @param {import('ws').WebSocket} ws
 * @returns {ChatListScope | null}
 */
export function getChatListClientScope(ws) {
  return clients.get(ws)?.scope || null;
}

/**
 * @returns {Iterable<[import('ws').WebSocket, ChatListClient]>}
 */
export function listChatListUpdateClients() {
  return clients.entries();
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} message
 * @returns {boolean}
 */
export function sendChatListClientMessage(ws, message) {
  if (!ws || ws.readyState !== 1) return false;
  const buffered = Number(ws.bufferedAmount) || 0;
  if (buffered > WS_BACKPRESSURE_THRESHOLD_BYTES) return false;
  try {
    ws.send(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * A widget socket is subscribed to an allowlist of chat ids, so a frame that carries row
 * content must never be sent to a widget that does not own the chat. Mirrors
 * `filterPresenceForScope` on the presence channel.
 *
 * @param {ChatListScope} scope
 * @param {string | null} chatId
 * @returns {boolean}
 */
function chatListFrameInScope(scope, chatId) {
  if (scope?.kind !== 'widget') return true;
  if (!chatId) return false;
  return scope.chatIds.has(chatId);
}

/**
 * @param {{ reason?: string, chatId?: string|null, title?: string, titleSource?: string }} [payload]
 * @returns {void}
 */
export function broadcastChatListChanged(payload = {}) {
  const reason = typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : 'update';
  const chatId = typeof payload.chatId === 'string' && payload.chatId.trim()
    ? payload.chatId.trim()
    : null;
  const frame = { type: 'chatsChanged', reason, chatId };
  // Row content is optional: a client that receives it patches the single chat instead of
  // refetching the whole list, and a client that does not (older server) reloads as before.
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (title) frame.title = title;
  const titleSource = typeof payload.titleSource === 'string' ? payload.titleSource.trim() : '';
  if (titleSource) frame.titleSource = titleSource;
  // Read markers (reason 'read'): `lastSeenAt` may legitimately be empty, so presence of the
  // reason decides, not truthiness.
  const isRead = reason === 'read';
  if (isRead) {
    frame.lastFinishedAt = typeof payload.lastFinishedAt === 'string' ? payload.lastFinishedAt : '';
    frame.lastSeenAt = typeof payload.lastSeenAt === 'string' ? payload.lastSeenAt : '';
  }
  const carriesContent = Boolean(title || titleSource || isRead);
  const message = JSON.stringify(frame);
  for (const [ws, client] of clients) {
    if (carriesContent && !chatListFrameInScope(client.scope, chatId)) continue;
    sendChatListClientMessage(ws, message);
  }
}

/**
 * True when at least one socket is subscribed to the list channel. Callers can
 * skip building a live frame entirely when nobody is listening.
 *
 * @returns {boolean}
 */
export function hasChatListSubscribers() {
  return clients.size > 0;
}

/**
 * Workspace scope of a todo-change frame (`docs/todo-review-contract.md` U7).
 *
 * - A widget scope never receives a todo-change frame in v1 (U7): the frame
 *   carries no chat id, so an allowlisted widget cannot be authorized row by row.
 * - Any other scope that declares an authorized `workspaceFolder` receives only
 *   frames for that exact workspace; a frame for another workspace is dropped
 *   server-side. A bare session scope (no declared workspace) is the trusted
 *   logged-in browser and receives every workspace's frame; the panel still
 *   filters by its active workspace.
 *
 * @param {ChatListScope} scope
 * @param {{ workspaceFolder?: unknown }} frame
 * @returns {boolean}
 */
function todoChangeFrameInScope(scope, frame) {
  if (scope?.kind === 'widget') return false;
  const authorized = String(scope?.workspaceFolder || '').trim();
  if (!authorized) return true;
  return authorized === String(frame?.workspaceFolder || '').trim();
}

/**
 * Broadcast a todo-change refresh frame on the existing list channel. The frame
 * carries identifiers only (workspace + todo id), never row content, so a client
 * refetches the authoritative snapshot itself.
 *
 * @param {{ reason?: string, workspaceFolder?: string, todoId?: string }} [payload]
 * @returns {void}
 */
export function broadcastTodoReviewChanged(payload = {}) {
  const workspaceFolder = typeof payload.workspaceFolder === 'string' ? payload.workspaceFolder.trim() : '';
  const todoId = typeof payload.todoId === 'string' ? payload.todoId.trim() : '';
  if (!workspaceFolder || !todoId) return;
  const reason = typeof payload.reason === 'string' && payload.reason.trim()
    ? payload.reason.trim()
    : 'review';
  const frame = { type: 'todosChanged', reason, workspaceFolder, todoId };
  const message = JSON.stringify(frame);
  for (const [ws, client] of clients) {
    if (!todoChangeFrameInScope(client.scope, frame)) continue;
    sendChatListClientMessage(ws, message);
  }
}

/**
 * Push the shared sidebar layout to every chat-list subscriber.
 *
 * @param {object | null | undefined} layout
 * @returns {void}
 */
export function broadcastSidebarLayout(layout) {
  const source = layout && typeof layout === 'object' ? layout : {};
  const message = JSON.stringify({
    type: 'sidebarLayout',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    chatOrder: Array.isArray(source.chatOrder) ? source.chatOrder : [],
    workspaceOrder: Array.isArray(source.workspaceOrder) ? source.workspaceOrder : [],
    favoriteChatIds: Array.isArray(source.favoriteChatIds) ? source.favoriteChatIds : [],
    collapsedWorkspaces: Array.isArray(source.collapsedWorkspaces) ? source.collapsedWorkspaces : [],
    subchatExpanded: Array.isArray(source.subchatExpanded) ? source.subchatExpanded : [],
    archiveOpen: Array.isArray(source.archiveOpen) ? source.archiveOpen : [],
  });
  for (const [ws] of clients) {
    sendChatListClientMessage(ws, message);
  }
}

/**
 * Clears subscribers (tests only).
 * @returns {void}
 */
export function __clearChatListUpdateClientsForTest() {
  clients.clear();
}
