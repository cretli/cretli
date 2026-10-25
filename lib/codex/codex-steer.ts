import { buildSdkSteerAckPayload, STEER_ACK_DELIVERED, STEER_ACK_REVERT } from '../sdk/sdk-run-steer.ts';
import { selectionRequestsSkill } from '../skills/skill-selection.js';

/** Track acknowledgements separately from observed user items, including cancel races. */
export interface CodexSteerEntry {
  text: string;
  mode: string | undefined;
  displayText: string;
  selection: unknown;
  turnId: string | undefined;
  seen: boolean;
  queued: boolean;
  accepted?: boolean;
}

/** The slice of a chat room the steering tracker touches. */
export interface CodexSteerRoom {
  _appServer?: { turnId?: string; steer(text: string, expectedTurnId?: string): Promise<{ turnId?: string }> } | null;
  currentRun?: { id?: string } | null;
  busy?: boolean;
  cancelled?: boolean;
}

export interface CodexSteeringNotification {
  method: string;
  params: {
    turnId?: string;
    item?: { type?: string; id?: string; content?: Array<{ type?: string; text?: string }> };
  };
}

export function createCodexSteering({ room, enqueue, delivered, broadcast, recordSteer = () => {} }: {
  room: CodexSteerRoom;
  enqueue: (text: string, mode: string | undefined, displayText: string, selection?: unknown) => void;
  delivered: (text: string) => void;
  broadcast: (payload: ReturnType<typeof buildSdkSteerAckPayload>) => void;
  recordSteer?: (info: { status: string; text: string }) => void;
}) {
  const entries: CodexSteerEntry[] = [];
  const seenItems = new Set<string>();
  let cancelled = false;
  function requeue(entry: CodexSteerEntry): void {
    if (entry.queued || entry.seen) return;
    entry.queued = true;
    enqueue(entry.text, entry.mode, entry.displayText, entry.selection);
  }
  return {
    async steer(text: unknown, mode?: string, displayText: string = '', selection: unknown = null) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      const client = room._appServer;
      const entry: CodexSteerEntry = { text: trimmed, mode, displayText, selection, turnId: client?.turnId, seen: false, queued: false };
      entries.push(entry);
      const runId = room.currentRun?.id || '';
      // A steer that asks for a skill goes through the full prompt builder as a
      // follow-up; it is never injected raw into the running turn.
      if (selectionRequestsSkill(trimmed, selection)) {
        requeue(entry);
        recordSteer({ status: 'reverted_to_followup', text: trimmed });
        broadcast(buildSdkSteerAckPayload({ runId, text: displayText || trimmed, outcome: STEER_ACK_REVERT }));
        return;
      }
      let accepted = false;
      try {
        if (!room.busy || room.cancelled || !client?.turnId) throw new Error('No active turn');
        const result = await client.steer(trimmed, entry.turnId);
        accepted = result.turnId === entry.turnId;
      } catch { /* RPC rejection falls back to the regular queue. */ }
      if (accepted) {
        entry.accepted = true;
        delivered(displayText || trimmed);
        if (cancelled || room.cancelled) requeue(entry);
      } else requeue(entry);
      recordSteer({ status: accepted ? 'delivered' : 'reverted_to_followup', text: trimmed });
      broadcast(buildSdkSteerAckPayload({ runId, text: displayText || trimmed, outcome: accepted ? STEER_ACK_DELIVERED : STEER_ACK_REVERT }));
    },
    observe({ method, params }: CodexSteeringNotification) {
      if (!['item/started', 'item/completed'].includes(method) || params.item?.type !== 'userMessage') return;
      const item0 = params.item;
      const key = `${params.turnId}:${item0.id}`;
      if (seenItems.has(key)) return;
      seenItems.add(key);
      const text = (item0.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('');
      const entry = entries.find((item) => !item.seen && item.turnId === params.turnId && item.text === text);
      if (entry) entry.seen = true;
    },
    cancel() { cancelled = true; for (const entry of entries) if (entry.accepted) requeue(entry); },
  };
}

/**
 * Maps a client message type to the prompt path. A `steer` message only keeps
 * steer semantics when the app-server is enabled; otherwise it is a plain send,
 * so no steer state is ever created.
 */
export function resolveCodexPromptKind(type: unknown, appServerEnabled: boolean): 'steer' | 'send' | null {
  if (type === 'steer') return appServerEnabled ? 'steer' : 'send';
  return type === 'send' ? 'send' : null;
}
