/** Wait for SDK send acceptance, without waiting for the response stream. */
export async function acceptSdkRoomPrompt(room, input) {
  let acknowledge;
  const accepted = new Promise((resolve) => { acknowledge = resolve; });
  const execution = room.startPrompt(
    input.prompt,
    input.mode || 'agent',
    false,
    null,
    input.displayText || '',
    (run) => {
      const runId = String(run?.id || '').trim();
      if (runId) acknowledge({ runId, accepted: true });
    },
  );
  return Promise.race([
    accepted,
    // A setup failure or cancellation can end the attempt before SDK send.
    // Keep acceptance unconfirmed instead of borrowing a previous run's id.
    Promise.resolve(execution).then(() => ({ runId: '', accepted: true })),
  ]);
}
