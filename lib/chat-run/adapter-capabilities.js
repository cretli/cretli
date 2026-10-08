/**
 * Single-source narrowing of the static recovery contract by a runtime adapter's
 * own capability declarations (leaf R6, finding F1).
 *
 * Two surfaces describe what a transport can do at runtime: the aggregate
 * `getChatRunAdapterCapabilities` view in `lib/chat-run-service.js` and the
 * per-run `createDurableRequestLookup` in `lib/chat-run/kernel-adapter.js`. They
 * MUST answer the same way, so both compute the intersection here. A runtime may
 * report LESS than `RECOVERY_MVP_ADAPTERS` grants, but it can never DISAGREE with
 * the other surface — clause 3 of the recovery contract (one authoritative
 * table).
 *
 * `RECOVERY_MVP_ADAPTERS` (through `describeRecoveryAdapterContract`) stays the
 * single source of the CONTRACT half; this module only intersects that half with
 * the runtime's declarations and derives the effective resume strategy and
 * transcript-loss signal. It is pure and side-effect free.
 */

/**
 * @param {{
 *   contract: object,
 *   canReattachDeclared?: boolean,
 *   canResumeSessionDeclared?: boolean,
 * }} input `canReattachDeclared` / `canResumeSessionDeclared` are the runtime's
 *   own claims. An absent value means "no narrowing": the contract decides. Only
 *   an explicit `false` withholds a capability the contract grants.
 * @returns {{
 *   canReattach: boolean,
 *   canResumeSession: boolean,
 *   resumeStrategy: string,
 *   transcriptLost: boolean,
 *   transcriptLossReason: string,
 * }}
 */
export function resolveEffectiveRecoveryCapabilities(input = {}) {
  const contract = input.contract || {};
  const canReattach = contract.reattach === true && input.canReattachDeclared !== false;
  const canResumeSession = contract.canResumeSession && input.canResumeSessionDeclared !== false;
  // A reattach-only strategy (`server_reattach`) is worthless once reattach is
  // denied, so the strategy is withheld together with it.
  const reattachOnlyStrategy = contract.resumeStrategy === 'server_reattach';
  const resumeStrategy = canResumeSession && (!reattachOnlyStrategy || canReattach)
    ? contract.resumeStrategy
    : '';
  // A contract that promised preserved context only keeps that promise while
  // reattach survives; every other path re-enters a saved session as a fresh turn.
  const transcriptLossReason = contract.transcriptLossReason === 'none' && !canReattach
    ? 'fresh_turn_in_saved_session'
    : contract.transcriptLossReason;
  return {
    canReattach,
    canResumeSession,
    resumeStrategy,
    transcriptLost: transcriptLossReason !== 'none',
    transcriptLossReason,
  };
}
