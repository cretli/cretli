import { requestCanUseToolPermission, replyCanUseToolPermission } from './can-use-tool-permission.ts';
import type { CanUseToolPermissionHost, CanUseToolPermissionRoom } from './can-use-tool-permission.ts';
import { notifyAgentNeedsInput } from '../agent-needs-input-push.js';

/** Bridge host-executed tools to the shared permission cards and reply channel. */
type HostedPermissionRoom = CanUseToolPermissionRoom & { _hostedPermissionHost?: CanUseToolPermissionHost };

export function createHostedToolPermissionGate({ harness, room, broadcastRoom, sendRoomState, settings }: {
  harness: string,
  room: HostedPermissionRoom,
  broadcastRoom: (room: HostedPermissionRoom, payload: Record<string, unknown>, options?: Record<string, unknown>) => void,
  sendRoomState?: (room: HostedPermissionRoom) => void,
  settings?: Parameters<typeof requestCanUseToolPermission>[0]['settings'],
}) {
  const host: CanUseToolPermissionHost = {
    broadcast: (payload, options) => broadcastRoom(room, payload, options),
    onPendingChange: () => sendRoomState?.(room),
    notify: (event) => notifyAgentNeedsInput({ room, event }),
  };
  room._hostedPermissionHost = host;
  return async (toolName: unknown, input?: Record<string, unknown>) => {
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
export function handleHostedToolPermissionReply(room: HostedPermissionRoom, payload: { requestId?: string, reply?: string, message?: string }): boolean {
  return replyCanUseToolPermission(room, room._hostedPermissionHost || {}, payload);
}
