/**
 * Import-free helpers for the session-resume decision (stored record
 * normalizer and prompt block), kept apart from the gate so the persistence layer can use it without an import cycle.
 */

/**
 * Normalize a stored value (legacy rows and garbage collapse to `null`).
 *
 * @param {unknown} value
 * @returns {object | null}
 */
export function normalizeSessionResumeRecord(value) {
  if (!value || typeof value !== 'object' || value.requested !== true) return null;
  const raw = String(value.status ?? '').trim();
  const status = raw === 'resumed' || raw === 'fresh' ? raw : 'fallback';
  return {
    requested: true,
    status,
    reasonCode: String(value.reasonCode ?? '').trim(),
    reason: String(value.reason ?? '').trim(),
    sourceDelegationId: String(value.sourceDelegationId ?? '').trim(),
    round: Math.max(1, Math.floor(Number(value.round)) || 1),
    sessionGeneration: Math.max(0, Math.floor(Number(value.sessionGeneration)) || 0),
  };
}

/**
 * Prompt block appended at the END of the history of a resumed session. It
 * restates only the round contract; it never embeds an earlier verdict or any
 * peer opinion, so the independent phase stays independent.
 *
 * @param {{ round?: number }} resume
 * @returns {string}
 */
export function buildSessionResumePromptBlock(resume) {
  const round = Math.max(2, Math.floor(Number(resume?.round)) || 2);
  return [
    `[RESUMED REVIEW ROUND ${round}]`,
    'This is a NEW review round in a session you already hold. Treat the assignment above as the current one.',
    'An earlier verdict from this session does not apply to the current material and is not evidence for this round.',
    'Re-read every changed file before judging, re-check the findings you reported earlier, and look for new problems and regressions.',
    'Report: new problems, the status of each earlier finding, and a fresh verdict for this round.',
  ].join('\n');
}
