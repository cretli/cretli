import { selectionFromSkillIds } from '../skills/skill-selection.js';

/** Wait for SDK send acceptance, without waiting for the response stream. */
export async function acceptSdkRoomPrompt(
  room: any,
  input: { prompt: string; mode?: string; displayText?: string; selectedSkillIds?: string[] }
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
  );
  return Promise.race([
    accepted,
    // A setup failure or cancellation can end the attempt before SDK send.
    // Keep acceptance unconfirmed instead of borrowing a previous run's id.
    Promise.resolve(execution).then(() => ({ runId: '', accepted: true })),
  ]);
}
