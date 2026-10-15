import { requestCanUseToolPermission, replyCanUseToolPermission } from './can-use-tool-permission.js';
import { notifyAgentNeedsInput } from '../agent-needs-input-push.js';

/** Bridge host-executed tools to the shared permission cards and reply channel. */
export function createHostedToolPermissionGate({ harness, room, broadcastRoom, sendRoomState, settings }) {
  const host = {
    broadcast: (payload, options) => broadcastRoom(room, payload, options),
    onPendingChange: () => sendRoomState?.(room),
    notify: (event) => notifyAgentNeedsInput({ room, event }),
  };
  room._hostedPermissionHost = host;
  return async (toolName, input) => {
    try {
      return await requestCanUseToolPermission({
        harness, room, toolName, input, host, settings,
        signal: room.abortController?.signal,
        sdkMode: room.sdkMode,
        timeoutMs: 120000,
      });
    } catch {
      return { outcome: 'deny', message: 'Permission check failed' };
    }
  };
}

/** Only pending human cards can resolve through the WebSocket channel. */
export function handleHostedToolPermissionReply(room, payload) {
  return replyCanUseToolPermission(room, room._hostedPermissionHost || {}, payload);
}
