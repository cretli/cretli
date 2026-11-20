/**
 * One word for "what is this agent doing", for a driver glancing at a phone.
 *
 * Pure: takes the server presence row (`resolveChatAgentPresence` /
 * `summarizeChatRunStates` in `lib/agent-run-state.js`; a missing row means
 * idle) and the decision cards that wait for this agent. The first rule that
 * matches wins, so the order below is the contract.
 */

/** @typedef {'needs_decision'|'working'|'done'|'error'|'idle'|'unknown'} CarAgentStatusId */

export const CAR_AGENT_STATUSES = Object.freeze(['needs_decision', 'working', 'done', 'error', 'idle', 'unknown']);

/** Sort weight: what needs the driver first. */
export const CAR_STATUS_PRIORITY = Object.freeze({
  needs_decision: 0,
  error: 1,
  working: 2,
  done: 3,
  unknown: 4,
  idle: 5,
});

/**
 * @param {Array<{ status?: string }>|number|null|undefined} cards
 * @returns {boolean}
 */
function hasOpenCard(cards) {
  if (typeof cards === 'number') return cards > 0;
  if (!Array.isArray(cards)) return false;
  return cards.some((card) => card && (card.status === undefined || card.status === 'pending'));
}

/**
 * @param {Record<string, any>|null|undefined} presence
 * @param {Array<{ status?: string }>|number|null|undefined} [openDecisionCards]
 * @returns {'needs_decision'|'working'|'done'|'error'|'idle'|'unknown'}
 */
export function deriveCarAgentStatus(presence, openDecisionCards) {
  if (hasOpenCard(openDecisionCards) || presence?.inputRequested === true) return 'needs_decision';
  const recovery = String(presence?.recoveryStatus || '');
  if (recovery === 'unknown') return 'unknown';
  if (recovery === 'interrupted' || recovery === 'interrupted_restart') return 'error';
  if (recovery === 'resuming') return 'working';
  const state = String(presence?.state || '');
  if (state === 'busy') return 'working';
  if (Number(presence?.waitingAgentCount) > 0 || Number(presence?.inFlightChildCount) > 0) return 'working';
  if (state === 'attention') {
    const delegation = String(presence?.delegationStatus || '');
    if (delegation === 'failed' || delegation === 'interrupted') return 'error';
    if (delegation === 'completed') return 'done';
    return 'unknown';
  }
  if (!presence || state === 'idle') return 'idle';
  return 'unknown';
}
