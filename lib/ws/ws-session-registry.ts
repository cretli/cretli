import type { WebSocket } from 'ws';

const sessionSockets = new Map<string, Set<WebSocket>>();

export function registerSessionWebSocket(sessionId: string, ws: WebSocket): void {
  if (typeof sessionId !== 'string' || !sessionId || !ws) return;
  let sockets = sessionSockets.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(sessionId, sockets);
  }
  sockets.add(ws);
}

export function unregisterSessionWebSocket(sessionId: string, ws: WebSocket): void {
  if (typeof sessionId !== 'string' || !sessionId || !ws) return;
  const sockets = sessionSockets.get(sessionId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) sessionSockets.delete(sessionId);
}

export function revokeSessionWebSockets(sessionIds: string[], closeCode: number = 4401, closeReason: string = 'session ended'): number {
  let closedCount = 0;
  for (const sessionId of sessionIds) {
    const sockets = sessionSockets.get(sessionId);
    if (!sockets) continue;
    for (const ws of sockets) {
      try {
        ws.close(closeCode, closeReason);
        closedCount += 1;
      } catch {
        // socket may already be gone
      }
    }
    sessionSockets.delete(sessionId);
  }
  return closedCount;
}

export function revokeAllSessionWebSockets(closeCode: number = 4401, closeReason: string = 'session ended'): number {
  const sessionIds = [...sessionSockets.keys()];
  return revokeSessionWebSockets(sessionIds, closeCode, closeReason);
}

/** Clears the registry (tests only). */
export function __clearSessionWebSocketRegistryForTest(): void {
  sessionSockets.clear();
}

/** Socket count for tests (one session, or the whole registry when sessionId is omitted). */
export function __countSessionWebSocketsForTest(sessionId?: string): number {
  if (typeof sessionId === 'string' && sessionId) {
    return sessionSockets.get(sessionId)?.size || 0;
  }
  let count = 0;
  for (const sockets of sessionSockets.values()) count += sockets.size;
  return count;
}
