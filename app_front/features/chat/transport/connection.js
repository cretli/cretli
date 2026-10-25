import { getClientInstanceId } from '../../../lib/clientInstance.js';

export function getPageVisibilityState() {
  if (typeof document === 'undefined') return 'unknown';
  return document.visibilityState || (document.hidden ? 'hidden' : 'visible');
}

export function buildSocketDiagnostics(chat) {
  const now = Date.now();
  const lastPingAt = Number.isFinite(chat?._lastPingAt) ? chat._lastPingAt : null;
  const lastPongAt = Number.isFinite(chat?._lastPongAt) ? chat._lastPongAt : null;
  const unackedPingAt = Number.isFinite(chat?._unackedPingAt) ? chat._unackedPingAt : null;
  return {
    visibility: getPageVisibilityState(),
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    reconnectAttempts: chat?._reconnectAttempts || 0,
    socketGeneration: Number(chat?._wsGeneration) || 0,
    lastPingAgoMs: lastPingAt ? now - lastPingAt : null,
    lastPongAgoMs: lastPongAt ? now - lastPongAt : null,
    unackedPingAgeMs: unackedPingAt ? now - unackedPingAt : null,
  };
}

export function buildAgentWsUrl(chat, wsPath) {
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = typeof location !== 'undefined' ? location.host : '';
  const params = new URLSearchParams();
  params.set('session', chat.cursorSessionId);
  if (chat.workspaceFile) params.set('workspace', chat.workspaceFile);
  if (chat.workspaceFolder) params.set('workspaceFolder', chat.workspaceFolder);
  if (chat.model) params.set('model', chat.model);
  const clientInstanceId = getClientInstanceId();
  if (clientInstanceId) params.set('clientInstance', clientInstanceId);
  const query = params.toString();
  return `${protocol}//${host}${wsPath}${query ? `?${query}` : ''}`;
}

export function shouldIgnoreDuplicateCatchUp(chat, data, buildCatchUpSignature, dedupMs) {
  if (!chat) return false;
  const now = Date.now();
  const signature = buildCatchUpSignature(data);
  const sameSignature = chat._lastCatchUpSig && chat._lastCatchUpSig === signature;
  const recent = typeof chat._lastCatchUpAt === 'number'
    && now - chat._lastCatchUpAt <= dedupMs;
  chat._lastCatchUpSig = signature;
  chat._lastCatchUpAt = now;
  return sameSignature && recent;
}

