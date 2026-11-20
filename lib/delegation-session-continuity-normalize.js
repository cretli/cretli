/** Normalize a durable session boundary without server dependencies. */
export function normalizeSessionContinuity(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const identity = String(raw.identity || '').trim();
  if (!identity) return null;
  const head = Number(raw.historyHeadSeq);
  return {
    identity,
    generation: Math.max(0, Math.floor(Number(raw.generation) || 0)),
    historyHeadSeq: Number.isFinite(head) && head >= 0 ? Math.floor(head) : null,
  };
}
