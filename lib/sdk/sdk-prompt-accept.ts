import { selectionFromSkillIds } from '../skills/skill-selection.js';

const PERSISTED_ORIGIN_KINDS = new Set(['operator', 'delegation', 'mailbox', 'watcher', 'system']);

export function buildSdkLocalUserRecord(input: {
  text: string;
  createdAt: string;
  requestId?: string;
  origin?: { kind: string; subtype?: string; clientId?: string; clientName?: string; sourceChatId?: string; sourceChatTitle?: string };
}): Record<string, unknown> {
  const origin = input.origin && PERSISTED_ORIGIN_KINDS.has(input.origin.kind) ? input.origin : undefined;
  return {
    kind: 'localUser',
    text: input.text,
    ...(origin ? { origin } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    createdAt: input.createdAt,
  };
}

/** Wait for SDK send acceptance, without waiting for the response stream. */
export async function acceptSdkRoomPrompt(
  room: any,
  input: { prompt: string; mode?: string; displayText?: string; selectedSkillIds?: string[]; origin?: { kind: string; subtype?: string; clientId?: string; clientName?: string; sourceChatId?: string; sourceChatTitle?: string }; requestId?: string }
): Promise<{ runId: string; accepted: boolean }> {
  let acknowledge!: (value: { runId: string; accepted: boolean }) => void;
  const accepted = new Promise<{ runId: string; accepted: boolean }>((resolve) => { acknowledge = resolve; });
  const execution = room.startPrompt(
    input.prompt,
    input.mode || 'agent',
    false,
    null,
    input.displayText || '',
    (run: { id?: unknown } | null | undefined) => {
      const runId = String(run?.id || '').trim();
      if (runId) acknowledge({ runId, accepted: true });
    },
    selectionFromSkillIds(input.selectedSkillIds),
    input.origin,
    input.requestId,
  );
  return Promise.race([
    accepted,
    // A setup failure or cancellation can end the attempt before SDK send.
    // Keep acceptance unconfirmed instead of borrowing a previous run's id.
    Promise.resolve(execution).then(() => ({ runId: '', accepted: true })),
  ]);
}
