import crypto from 'node:crypto';
import { getWidgetInstallation } from './widget/widget-installations.js';

const OPEN_SOCKET_STATE = 1;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

const COMMAND_PERMISSIONS = new Map([
  ['getContext', 'context'],
  ['getDom', 'dom'],
  ['queryElements', 'dom'],
  ['getComputedStyles', 'dom'],
  ['getConsole', 'console'],
  ['getNetwork', 'network'],
  ['takeScreenshot', 'screenshot'],
  ['click', 'interact'],
  ['type', 'interact'],
  ['select', 'interact'],
  ['scroll', 'interact'],
  ['focus', 'interact'],
  ['waitFor', 'interact'],
  ['pickElement', 'interact'],
  ['pressKey', 'interact'],
  ['copyText', 'interact'],
  ['highlight', 'interact'],
  ['hover', 'interact'],
  ['fillForm', 'interact'],
  ['readStorage', 'storage'],
  ['reload', 'navigate'],
  ['navigate', 'navigate'],
]);
const ALLOWED_PERMISSIONS = new Set(COMMAND_PERMISSIONS.values());

const sessions = new Map();
const socketSessions = new WeakMap();
const chatBindings = new Map();
const pendingCommands = new Map();

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function normalizePermissions(value) {
  if (!Array.isArray(value)) throw new Error('sessionInfo.permissions must be an array');
  const permissions = [...new Set(value)];
  for (const permission of permissions) {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      throw new Error(`Unsupported page permission: ${String(permission)}`);
    }
  }
  return permissions;
}

function jsonByteLength(value, errorMessage) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(errorMessage);
  }
  if (serialized === undefined) throw new Error(errorMessage);
  return Buffer.byteLength(serialized);
}

function publicSession(session) {
  return {
    ...structuredClone(session.info),
    pageSessionId: session.id,
    permissions: [...session.permissions],
    latestState: structuredClone(session.latestState),
  };
}

function removeListeners(session) {
  const remove = typeof session.ws.off === 'function'
    ? session.ws.off.bind(session.ws)
    : session.ws.removeListener?.bind(session.ws);
  if (!remove) return;
  remove('message', session.handlers.message);
  remove('close', session.handlers.close);
  remove('error', session.handlers.error);
}

function rejectPending(session, error) {
  for (const commandId of session.pending) {
    const pending = pendingCommands.get(commandId);
    if (!pending) continue;
    clearTimeout(pending.timer);
    pendingCommands.delete(commandId);
    pending.reject(error);
  }
  session.pending.clear();
}

function finishCommand(commandId, action, value) {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  pending.session.pending.delete(commandId);
  pending[action](value);
}

function messageData(raw) {
  const value = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  return null;
}

function handlePageState(session, message) {
  const byteLength = jsonByteLength(message.state, 'Invalid page state');
  session.latestState = byteLength <= MAX_STATE_BYTES
    ? structuredClone(message.state)
    : { truncated: true, byteLength };
  session.stateUpdatedAt = new Date().toISOString();
}

function handleCommandResult(session, message) {
  if (typeof message.id !== 'string') return;
  const pending = pendingCommands.get(message.id);
  if (!pending || pending.session !== session) return;

  if (Object.hasOwn(message, 'error') && message.error !== null) {
    const detail = typeof message.error === 'string'
      ? message.error
      : JSON.stringify(message.error);
    finishCommand(message.id, 'reject', new Error(`Page command failed: ${detail}`));
    return;
  }

  const byteLength = jsonByteLength(message.result, 'Invalid page command response');
  if (byteLength > MAX_RESULT_BYTES) {
    finishCommand(message.id, 'reject', new Error('Page command response is too large'));
    return;
  }
  finishCommand(message.id, 'resolve', structuredClone(message.result));
}

function handleChatBinding(session, message) {
  if (typeof message.chatSessionKey !== 'string' || !message.chatSessionKey.trim()) return;
  const chatSessionKey = message.chatSessionKey.trim();
  try {
    session.onBindChat?.(chatSessionKey, publicSession(session));
    chatBindings.set(chatSessionKey, session.id);
    session.ws.send(JSON.stringify({
      type: 'bindChatResult',
      ok: true,
      chatSessionKey,
    }));
  } catch (error) {
    session.ws.send(JSON.stringify({
      type: 'bindChatResult',
      ok: false,
      chatSessionKey,
      error: error?.message || 'Chat binding denied',
    }));
  }
}

function handleMessage(session, raw) {
  const data = messageData(raw);
  if (data === null || Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return;

  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'pageState') handlePageState(session, message);
  if (message.type === 'commandResult') handleCommandResult(session, message);
  if (message.type === 'bindChat') handleChatBinding(session, message);
}

export function registerPageBridge(ws, sessionInfo) {
  if (!ws || typeof ws.on !== 'function' || typeof ws.send !== 'function') {
    throw new Error('A WebSocket-compatible object is required');
  }
  if (!sessionInfo || typeof sessionInfo !== 'object' || Array.isArray(sessionInfo)) {
    throw new Error('sessionInfo must be an object');
  }

  const id = requireNonEmptyString(sessionInfo.pageSessionId, 'sessionInfo.pageSessionId');
  const permissions = normalizePermissions(sessionInfo.permissions);
  const previousForSocket = socketSessions.get(ws);
  if (previousForSocket) unregisterPageBridge(ws);
  const previousForId = sessions.get(id);
  if (previousForId) unregisterPageBridge(previousForId.ws);

  const {
    pageSessionId: _pageSessionId,
    permissions: _permissions,
    onBindChat = null,
    ...metadata
  } = sessionInfo;
  const session = {
    id,
    ws,
    info: structuredClone(metadata),
    permissions: new Set(permissions),
    onBindChat: typeof onBindChat === 'function' ? onBindChat : null,
    latestState: null,
    stateUpdatedAt: null,
    pending: new Set(),
    handlers: {},
  };
  session.handlers.message = (message) => handleMessage(session, message);
  session.handlers.close = () => unregisterPageBridge(ws);
  session.handlers.error = () => {};

  sessions.set(id, session);
  socketSessions.set(ws, session);
  ws.on('message', session.handlers.message);
  ws.on('close', session.handlers.close);
  ws.on('error', session.handlers.error);
  return publicSession(session);
}

export function unregisterPageBridge(ws) {
  const session = socketSessions.get(ws);
  if (!session) return false;

  removeListeners(session);
  socketSessions.delete(ws);
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  for (const [chatSessionKey, pageSessionId] of chatBindings) {
    if (pageSessionId === session.id) chatBindings.delete(chatSessionKey);
  }
  rejectPending(session, new Error('Page session disconnected'));
  return true;
}

export function bindChatToPageSession(chatSessionKey, pageSessionId) {
  const chatKey = requireNonEmptyString(chatSessionKey, 'chatSessionKey');
  const sessionId = requireNonEmptyString(pageSessionId, 'pageSessionId');
  if (!sessions.has(sessionId)) throw new Error(`Page session not found: ${sessionId}`);
  chatBindings.set(chatKey, sessionId);
  return publicSession(sessions.get(sessionId));
}

export function unbindChatPageSession(chatSessionKey) {
  const chatKey = requireNonEmptyString(chatSessionKey, 'chatSessionKey');
  return chatBindings.delete(chatKey);
}

export function getPageSessionForChat(chatSessionKey) {
  const chatKey = requireNonEmptyString(chatSessionKey, 'chatSessionKey');
  const pageSessionId = chatBindings.get(chatKey);
  if (!pageSessionId) return null;
  const session = sessions.get(pageSessionId);
  return session ? publicSession(session) : null;
}

export function executePageCommandForChat(
  chatSessionKey,
  command,
  args = {},
  options = {},
) {
  const chatKey = requireNonEmptyString(chatSessionKey, 'chatSessionKey');
  const commandName = requireNonEmptyString(command, 'command');
  const permission = COMMAND_PERMISSIONS.get(commandName);
  if (!permission) throw new Error(`Unsupported page command: ${commandName}`);

  const pageSessionId = chatBindings.get(chatKey);
  if (!pageSessionId) throw new Error(`No page session is bound to chat: ${chatKey}`);
  const session = sessions.get(pageSessionId);
  if (!session) throw new Error(`Page session is not connected: ${pageSessionId}`);
  if (session.info.installationId) {
    const installation = getWidgetInstallation(session.info.installationId);
    if (!installation.enabled || !installation.permissions.includes(permission)) {
      throw new Error(`Page command "${commandName}" is no longer allowed by the installation`);
    }
  }
  if (!session.permissions.has(permission)) {
    throw new Error(`Page command "${commandName}" requires permission "${permission}"`);
  }
  if (session.ws.readyState !== OPEN_SOCKET_STATE) {
    throw new Error(`Page session socket is not open: ${pageSessionId}`);
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('options must be an object');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }

  const id = crypto.randomUUID();
  const outgoing = { type: 'command', id, command: commandName, args };
  if (jsonByteLength(outgoing, 'Page command arguments must be JSON-serializable') > MAX_MESSAGE_BYTES) {
    throw new Error('Page command is too large');
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finishCommand(id, 'reject', new Error(`Page command timed out: ${commandName}`));
    }, timeoutMs);
    pendingCommands.set(id, { resolve, reject, timer, session });
    session.pending.add(id);

    try {
      session.ws.send(JSON.stringify(outgoing), (error) => {
        if (error) finishCommand(id, 'reject', new Error(`Failed to send page command: ${error.message}`));
      });
    } catch (error) {
      finishCommand(id, 'reject', new Error(`Failed to send page command: ${error.message}`));
    }
  });
}
