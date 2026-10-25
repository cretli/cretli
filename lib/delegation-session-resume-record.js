/**
 * Import-free helpers for the session-resume decision (stored record
 * normalizer and prompt block), kept apart from the gate so the persistence layer can use it without an import cycle.
 */

/**
 * Normalize a stored value (legacy rows and garbage collapse to `null`).
 *
 * @param {Record<string, any>} value
 * @returns {Record<string, any> | null}
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
    // Work role of the resumed start (plan / implement / fix); '' for reviews.
    workRole: ['plan', 'implement', 'fix'].includes(String(value.workRole ?? '').trim()) ? String(value.workRole).trim() : '',
    // Opt-in cross-role resume (code review <-> implement/fix), for the card.
    ...(value.crossRole === true && raw === 'resumed'
      ? { crossRole: true, sourceWorkRole: normalizeCrossRoleSource(value.sourceWorkRole) }
      : {}),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCrossRoleSource(value) {
  const role = String(value ?? '').trim();
  return ['review_code', 'implement', 'fix'].includes(role) ? role : '';
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
  const crossRole = resume?.crossRole === true;
  if (resume?.workRole) {
    return [
      `[RESUMED ${String(resume.workRole).toUpperCase()} SESSION, ROUND ${round}]`,
      'This is a NEW delegation in a session you already hold, for the same leaf. Treat the assignment above as the current one.',
      ...(crossRole
        ? [`Your role is now ${String(resume.workRole).toUpperCase()}; this session also holds code review work for this leaf. Address the current assignment, not the earlier review role.`]
        : []),
      'Earlier reports, verdicts and verification from this session do not apply to the current material and are not evidence for this round.',
      'Re-read the files you rely on before changing or judging them, then report and verify the current state afresh.',
    ].join('\n');
  }
  return [
    `[RESUMED REVIEW ROUND ${round}]`,
    'This is a NEW review round in a session you already hold. Treat the assignment above as the current one.',
    ...(crossRole
      ? ['Your role is now CODE REVIEW (read-only); this session also holds implementation or fix work for this leaf. Base every finding on the current material you re-read now, never on this chat\'s own earlier claims about the code.']
      : []),
    'An earlier verdict from this session does not apply to the current material and is not evidence for this round.',
    'Re-read every changed file before judging, re-check the findings you reported earlier, and look for new problems and regressions.',
    'Report: new problems, the status of each earlier finding, and a fresh verdict for this round.',
  ].join('\n');
}
