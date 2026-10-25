/**
 * Safe resume of an earlier reviewer or work session.
 *
 * The server policy may select a finished source automatically, or an enabled
 * policy may accept `resume_session_of`. When every check below passes, the new
 * delegation re-enters the SAME child chat (and harness session) as a new turn.
 * It still owns a new attempt, report, verdict and material id: nothing from an
 * earlier round is carried over as evidence.
 *
 * Every refusal is a deterministic FALLBACK, not an error: the slot starts a
 * new chat and the reason is recorded on the delegation. The decision is a pure
 * function of its inputs so the start path can re-run it synchronously right
 * before the record is created (concurrent starts never share a live session).
 */

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

import { decodeModelValue } from './model-catalog.js';
import { resolveAgentTransportProfile } from './agent-transport.js';
import { delegationController } from './delegation-control.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { isImplementOrFixDelegationRow } from './delegation-implement-verify-gate.js';
import {
  CROSS_ROLE_SESSION_ROLES,
  allowedResumeSourceRoles,
  isCrossRoleSessionPair,
  readRowWorkRole,
} from './delegation-work-role.js';
import { findRoundImplementer } from './delegation-round-implementer.js';
import { normalizeSessionContinuity } from './delegation-session-continuity.js';
import { sameCanonicalModel } from './model-identity.js';
import {
  buildSessionResumePromptBlock,
  normalizeSessionResumeRecord,
} from './delegation-session-resume-record.js';

export { buildSessionResumePromptBlock, normalizeSessionResumeRecord };

/** Stable reason codes recorded on `delegation.sessionResume.reasonCode`. */
export const SESSION_RESUME_REASON = Object.freeze({
  RESUMED: 'resumed',
  // Opt-in `continue_cross_role_sessions`: the chat holds work of another role.
  RESUMED_CROSS_ROLE: 'resumed_cross_role',
  CROSS_ROLE_UNSUPPORTED: 'resume_cross_role_unsupported',
  REVIEW_ONLY: 'resume_review_only',
  SOURCE_NOT_FOUND: 'resume_source_not_found',
  SCOPE_CHANGED: 'resume_scope_changed',
  CONFIG_CHANGED: 'resume_config_changed',
  UNSUPPORTED: 'resume_unsupported',
  LOCKED_OUT: 'resume_locked_out',
  INDEPENDENCE: 'resume_independence',
  SOURCE_BUSY: 'resume_source_busy',
  SOURCE_CLAIMED: 'resume_session_claimed',
  SOURCE_CANCELLED: 'resume_source_cancelled',
  SOURCE_UNUSABLE: 'resume_source_unusable',
  AFTER_RESTART: 'resume_after_restart',
  CHAT_MISSING: 'resume_chat_missing',
  SESSION_MISSING: 'resume_session_missing',
  SESSION_RESET: 'resume_session_reset',
  CONTINUITY_UNKNOWN: 'resume_continuity_unknown',
  PEER_CONTEXT: 'resume_peer_context',
  SOURCE_SUPERSEDED: 'resume_source_superseded',
  PHASE_CHANGED: 'phase_changed',
  CONTAMINATED: 'resume_implementation_history',
  ROLE_CHANGED: 'resume_role_changed',
  UNCLASSIFIED: 'resume_unclassified_source',
  NO_LEAF: 'resume_no_leaf',
  WORK_HISTORY: 'resume_foreign_history',
  // Policy-level decisions (no source session was even considered).
  FRESH_BY_POLICY: 'reuse_fresh_by_policy',
  FIRST_SESSION: 'reuse_first_session',
  LEARNING: 'reuse_learning_pair',
  NO_ELIGIBLE_SOURCE: 'reuse_no_eligible_source',
  NOT_POOL_MEMBER: 'reuse_not_pool_member',
  WORK_FRESH_BY_POLICY: 'work_fresh_by_policy',
  WORK_NO_SOURCE: 'work_no_eligible_source',
  // Work-role fail-safe guards (per candidate source, never for an explicit pointer).
  WORK_CACHE_EXPIRED: 'work_cache_expired',
  WORK_PREVIOUS_EMPTY_REPORT: 'work_previous_empty_report',
  // Optional `resume_context_cap_rounds`: the resumed chat already holds too many rounds.
  RESUME_CONTEXT_CAP: 'resume_context_cap',
});

const REASON_TEXT = Object.freeze({
  [SESSION_RESUME_REASON.REVIEW_ONLY]: 'Session resume is unavailable for this delegation role; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_NOT_FOUND]: 'The named review delegation was not found for this controller; started a new chat.',
  [SESSION_RESUME_REASON.SCOPE_CHANGED]: 'The review subject, mode or leaf differs from the named delegation; started a new chat.',
  [SESSION_RESUME_REASON.CONFIG_CHANGED]: 'Harness, model, options, execution mode or folder differ from the named session; started a new chat.',
  [SESSION_RESUME_REASON.UNSUPPORTED]: 'The harness adapter cannot resume a session; started a new chat.',
  [SESSION_RESUME_REASON.LOCKED_OUT]: 'The harness/model pair is under an active lockout; started a new chat.',
  [SESSION_RESUME_REASON.INDEPENDENCE]: 'The reviewer shares a base model with an implementer of this leaf; a resumed session could not be proven independent, started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_BUSY]: 'The named session is still running; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_CLAIMED]: 'Another delegation already holds the named session; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_CANCELLED]: 'The named delegation was cancelled; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_UNUSABLE]: 'The named delegation did not finish with a usable report; started a new chat.',
  [SESSION_RESUME_REASON.AFTER_RESTART]: 'The named session was interrupted by a server restart; started a new chat.',
  [SESSION_RESUME_REASON.CHAT_MISSING]: 'The named session chat no longer exists; started a new chat.',
  [SESSION_RESUME_REASON.SESSION_MISSING]: 'The named chat has no harness session id to resume; started a new chat.',
  [SESSION_RESUME_REASON.SESSION_RESET]: 'The session was reset or compacted since the named delegation; started a new chat.',
  [SESSION_RESUME_REASON.CONTINUITY_UNKNOWN]: 'The server cannot prove that the persisted session survived unchanged; started a new chat.',
  [SESSION_RESUME_REASON.SOURCE_SUPERSEDED]: 'A newer delegation already used the named session chat; started a new chat.',
  [SESSION_RESUME_REASON.PHASE_CHANGED]: 'The review phase changed (audit and closure never share a session); started a new chat.',
  [SESSION_RESUME_REASON.ROLE_CHANGED]: 'The named session belongs to a role this start may not re-enter (plan, implement and fix only reuse their own or implement-to-fix history); started a new chat.',
  [SESSION_RESUME_REASON.UNCLASSIFIED]: 'The named delegation predates role classification, so its history cannot be trusted for this role; started a new chat.',
  [SESSION_RESUME_REASON.NO_LEAF]: 'The selected per-TODO scope needs leaf_id (or an unambiguous linked TODO); started a new chat.',
  [SESSION_RESUME_REASON.WORK_HISTORY]: 'The named session chat received other work or turns after the source delegation; started a new chat.',
  [SESSION_RESUME_REASON.CONTAMINATED]: 'The named session also ran implementation or fix work; a reviewer must not reuse it, started a new chat.',
  [SESSION_RESUME_REASON.FRESH_BY_POLICY]: 'Session continuation is off for this review subject; started a new chat.',
  [SESSION_RESUME_REASON.WORK_FRESH_BY_POLICY]: 'Session continuation is off for this role in Settings; started a new chat.',
  [SESSION_RESUME_REASON.WORK_NO_SOURCE]: 'No earlier finished session matches this role, selected scope, executor and configuration; started a new chat.',
  [SESSION_RESUME_REASON.WORK_CACHE_EXPIRED]: 'The earlier session prompt cache expired (TTL elapsed), so resuming would re-read the whole history at full price; started a new chat.',
  [SESSION_RESUME_REASON.WORK_PREVIOUS_EMPTY_REPORT]: 'The newest attempt in the earlier session chat ended with an empty report; started a new chat instead of resuming a possibly broken session.',
  [SESSION_RESUME_REASON.RESUME_CONTEXT_CAP]: 'The earlier session reached the configured round cap (resume_context_cap_rounds), so its accumulated context is not carried further; started a new chat.',
  [SESSION_RESUME_REASON.FIRST_SESSION]: 'First review session of this reviewer under the reuse policy; started a new chat.',
  [SESSION_RESUME_REASON.LEARNING]: 'The reviewer pair is still being learned; this reviewer has no earlier session yet, started a new chat.',
  [SESSION_RESUME_REASON.NO_ELIGIBLE_SOURCE]: 'No earlier finished review session of this reviewer matches the policy scope; started a new chat.',
  [SESSION_RESUME_REASON.NOT_POOL_MEMBER]: 'This reviewer is not a member of the fixed pair, so no session is reused; started a new chat.',
  [SESSION_RESUME_REASON.CROSS_ROLE_UNSUPPORTED]: 'This harness cannot guarantee the permissions of the new role inside a resumed chat, so it never crosses between review and implement/fix; started a new chat.',
  [SESSION_RESUME_REASON.PEER_CONTEXT]: 'The named session saw peer opinions (exchange phase) and this start is independent; started a new chat.',
});

/** Policy-level codes that are a plain "fresh chat", not a refused resume. */
const FRESH_REASON_CODES = new Set([
  SESSION_RESUME_REASON.FRESH_BY_POLICY,
  SESSION_RESUME_REASON.FIRST_SESSION,
  SESSION_RESUME_REASON.LEARNING,
  SESSION_RESUME_REASON.NO_ELIGIBLE_SOURCE,
  SESSION_RESUME_REASON.NOT_POOL_MEMBER,
  SESSION_RESUME_REASON.WORK_FRESH_BY_POLICY,
  SESSION_RESUME_REASON.WORK_NO_SOURCE,
]);

/**
 * Chat family per work role: a plan chat only ever holds plan work; an
 * implement/fix chat only implement and fix work. Reviews never join either.
 */
const WORK_FAMILY = Object.freeze({ plan: ['plan'], implement: ['implement', 'fix'], fix: ['implement', 'fix'] });

const USABLE_VERDICTS = new Set(['PASS', 'FAIL', 'BLOCKED']);

/**
 * Transports audited for cross-role resume: each applies the permissions of the
 * NEW delegation on every run of a resumed chat (review read-only, write access
 * back for implement/fix), because the run reads the active job's assignment.
 * claude switches the permission mode (or restarts with resume), codex resumes
 * the thread with per-run sandbox options, qwen / sdk guard every tool call.
 * deepseek is excluded: a read-only switch rebuilds its harness and drops the
 * session, so a cross-role resume cannot keep the context. opencode is excluded:
 * its permission sync (`session.update`) only logs a failure and the run
 * continues, so a review could inherit the earlier write permissions.
 */
const CROSS_ROLE_TRANSPORTS = new Set(['claude', 'codex', 'qwen', 'sdk']);

/** Chat field holding the harness session id, per transport. */
const SESSION_ID_FIELD = Object.freeze({
  sdk: 'cursorSessionId',
  opencode: 'opencodeSessionId',
  codebuddy: 'codebuddySessionId',
  deepseek: 'deepseekSessionId',
  codex: 'codexThreadId',
  qwen: 'qwenSessionId',
  claude: 'claudeSessionId',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function baseModel(model) {
  const raw = text(model);
  return raw ? text(decodeModelValue(raw).modelId).toLowerCase() : '';
}

/**
 * Normalized `::` params (`effort=...`) of a stored model value, so param order
 * never reads as a config change.
 *
 * @param {unknown} model
 * @returns {string}
 */
function modelParamsKey(model) {
  const params = decodeModelValue(text(model)).params || [];
  return JSON.stringify(
    params
      .map((row) => [String(row.id).trim(), String(row.value).trim()])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/**
 * @param {unknown} options
 * @returns {string}
 */
function optionsKey(options) {
  const bag = options && typeof options === 'object' ? options : {};
  const sorted = Object.keys(bag).sort().map((key) => [key, bag[key]]);
  return JSON.stringify(sorted);
}

/**
 * True when two executor configs name the same session: same canonical model
 * (a Claude alias equals the numbered id it resolves to), same `::` params and
 * the same option bag. The callers compare the transport separately.
 *
 * @param {string} transport
 * @param {{ model?: unknown, options?: unknown }} a
 * @param {{ model?: unknown, options?: unknown }} b
 * @returns {boolean}
 */
function sameExecutorConfig(transport, a, b) {
  return modelParamsKey(a?.model) === modelParamsKey(b?.model)
    && optionsKey(a?.options) === optionsKey(b?.options)
    && sameCanonicalModel(transport, baseModel(a?.model), baseModel(b?.model));
}

/**
 * Newest finished review of the same controller, subject and executor config,
 * so the start can re-enter that reviewer session. `scope=leaf` (default) also
 * requires the same leaf; `scope=orchestrator` accepts any leaf of the
 * controller. With `reviewMode`, a source of the same phase wins over a newer
 * one of another phase (audit and closure never share a session; the other
 * phase is returned only so the gate can record `phase_changed`).
 * Returns '' when none exists; `inspectDelegationSessionResume` still applies
 * every gate and falls back to a new chat.
 *
 * @param {{ delegations?: Record<string, any>[], parentChatId?: unknown, reviewSubject?: unknown, leafId?: unknown, reviewMode?: unknown, scope?: unknown, executor?: { transport?: unknown, model?: unknown, options?: unknown } }} input
 * @returns {string}
 */
export function findPairResumeSource(input = {}) {
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  if (!parentChatId) return '';
  const transport = text(input.executor?.transport).toLowerCase();
  const acrossLeaves = text(input.scope).toLowerCase() === 'orchestrator';
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const candidates = rows
    .filter((row) => text(row?.assignment).toLowerCase() === 'review'
      && delegationController(row) === parentChatId
      && text(row.status) === 'completed'
      && text(row.childChatId) !== ''
      && text(row.executor?.transport).toLowerCase() === transport
      && sameExecutorConfig(transport, row.executor, input.executor)
      && text(row.reviewSubject).toLowerCase() === text(input.reviewSubject).toLowerCase()
      && (acrossLeaves || text(row.leafId) === text(input.leafId)))
    .sort((a, b) => stamp(b) - stamp(a));
  const mode = text(input.reviewMode).toLowerCase();
  const sameMode = mode ? candidates.filter((row) => text(row.reviewMode).toLowerCase() === mode) : [];
  const match = sameMode[0] || candidates[0];
  return match ? text(match.id) : '';
}

/**
 * @param {string} transport
 * @param {Record<string, any> | null | undefined} chat
 * @returns {string}
 */
export function readChatHarnessSessionId(transport, chat) {
  const field = SESSION_ID_FIELD[resolveAgentTransportProfile(transport)];
  return field ? text(chat?.[field]) : '';
}

/**
 * Read the optional resume pointer from a start input (camel or snake case).
 *
 * @param {Record<string, any> | null | undefined} input
 * @returns {string}
 */
export function readResumeSessionOfInput(input) {
  return text(input?.resumeSessionOf ?? input?.resume_session_of);
}

/**
 * @param {string} code
 * @param {Record<string, any>} [extra]
 * @returns {{ requested: true, resume: false, reasonCode: string, reason: string, sourceDelegationId: string }}
 */
function fallback(code, extra = {}) {
  return {
    requested: true,
    resume: false,
    reasonCode: code,
    reason: REASON_TEXT[code] || code,
    sourceDelegationId: text(extra.sourceDelegationId),
  };
}

/**
 * Optional round cap: true when re-entering would make the chat exceed
 * `resumeContextCapRounds` rounds. A missing / non-positive cap is off.
 *
 * @param {Record<string, any>} input
 * @param {number} nextRound
 * @returns {boolean}
 */
function exceedsResumeContextCap(input, nextRound) {
  const cap = Number(input.resumeContextCapRounds);
  return Number.isSafeInteger(cap) && cap > 0 && nextRound > cap;
}

/**
 * Decide whether a review start may re-enter an earlier reviewer chat.
 *
 * Order matters and is part of the contract: structural refusals first, then
 * hard exclusions (lockout, independence), then liveness/claim checks.
 *
 * @param {{
 *   resumeSessionOf?: unknown,
 *   parentChatId?: unknown,
 *   assignment?: unknown,
 *   reviewSubject?: unknown,
 *   reviewMode?: unknown,
 *   leafId?: unknown,
 *   sessionScope?: 'leaf' | 'orchestrator',
 *   executor?: { transport?: unknown, model?: unknown, options?: unknown },
 *   executionMode?: unknown,
 *   executionFolder?: unknown,
 *   allowChildDelegations?: boolean,
 *   depth?: number,
 *   rootChatId?: string,
 *   planReviewerPhase?: unknown,
 *   exchangeOfDelegationId?: unknown,
 *   delegations?: object[],
 *   findChat?: (chatId: string) => object | null,
 *   capabilities?: { canResumeSession?: boolean } | null,
 *   lockoutActive?: boolean,
 *   resumeContextCapRounds?: number,
 *   isRunActive?: (chatId: string) => boolean,
 *   currentContinuity?: (chatId: string) => object | null,
 * }} input
 * @returns {{
 *   requested: boolean,
 *   resume: boolean,
 *   reasonCode: string,
 *   reason: string,
 *   sourceDelegationId: string,
 *   childChatId?: string,
 *   round?: number,
 *   sessionGeneration?: number,
 *   sessionContinuity?: object,
 * }}
 */
export function inspectDelegationSessionResume(input = {}) {
  const sourceId = readResumeSessionOfInput(input);
  if (!sourceId) {
    return { requested: false, resume: false, reasonCode: '', reason: '', sourceDelegationId: '' };
  }
  const workRole = text(input.workRole).toLowerCase();
  const isWorkStart = WORK_FAMILY[workRole] !== undefined;
  if (text(input.assignment).toLowerCase() !== 'review' && !isWorkStart) {
    return fallback(SESSION_RESUME_REASON.REVIEW_ONLY, { sourceDelegationId: sourceId });
  }
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  const source = /** @type {Record<string, any>} */ (rows.find((/** @type {Record<string, any>} */ row) => text(row?.id) === sourceId) || null);
  // A foreign controller's row is reported as missing so existence is not leaked.
  const controller = delegationController(source);
  if (!source || !parentChatId || controller !== parentChatId) {
    return fallback(SESSION_RESUME_REASON.SOURCE_NOT_FOUND, { sourceDelegationId: sourceId });
  }
  const failWith = (code) => fallback(code, { sourceDelegationId: sourceId });
  if (isWorkStart) return inspectWorkSessionResume(input, { source, sourceId, rows, parentChatId, workRole, failWith });
  // `orchestrator` scope lets a session travel between leaves of one
  // controller; every other gate below still applies.
  const acrossLeaves = text(input.sessionScope).toLowerCase() === 'orchestrator';
  const cross = readCrossRoleContext(input, 'review_code', source);
  if (cross.sourceIsCross) {
    // A cross-role source is an implement/fix row: only the leaf clause stays,
    // and it is never widened to the orchestrator scope.
    if (!text(input.leafId) || text(source.leafId) !== text(input.leafId)) {
      return failWith(SESSION_RESUME_REASON.SCOPE_CHANGED);
    }
  } else if (text(source.assignment).toLowerCase() !== 'review'
    || isImplementOrFixDelegationRow(source)
    || text(source.reviewSubject).toLowerCase() !== text(input.reviewSubject).toLowerCase()
    || (!acrossLeaves && text(source.leafId) !== text(input.leafId))) {
    return failWith(SESSION_RESUME_REASON.SCOPE_CHANGED);
  }
  const wantedMode = text(input.reviewMode).toLowerCase();
  if (!cross.sourceIsCross && wantedMode && text(source.reviewMode).toLowerCase() !== wantedMode) {
    return failWith(SESSION_RESUME_REASON.PHASE_CHANGED);
  }
  const transport = text(input.executor?.transport).toLowerCase();
  const sameConfig = text(source.executor?.transport).toLowerCase() === transport
    && sameExecutorConfig(transport, source.executor, input.executor)
    && text(source.executionMode) === text(input.executionMode)
    && text(source.executionFolder) === text(input.executionFolder)
    // Delegation rights and tree position are part of the session config: a
    // resumed chat must not keep a grant the new round was not given.
    && (source.allowChildDelegations === true) === (input.allowChildDelegations === true)
    && (Number(source.depth) || 1) === (Number(input.depth) || 1)
    && text(source.rootChatId) === text(input.rootChatId);
  if (!sameConfig) return failWith(SESSION_RESUME_REASON.CONFIG_CHANGED);
  if (input.capabilities?.canResumeSession !== true) return failWith(SESSION_RESUME_REASON.UNSUPPORTED);
  if (cross.sourceIsCross && !cross.active) return failWith(SESSION_RESUME_REASON.CROSS_ROLE_UNSUPPORTED);
  if (input.lockoutActive === true) return failWith(SESSION_RESUME_REASON.LOCKED_OUT);
  // Every delegation that ever ran in the source chat shares its context, so
  // the peer check and the round counter look at the whole chat, not one row.
  const chatRows = rows.filter((/** @type {Record<string, any>} */ row) => text(row?.childChatId) !== ''
    && text(row.childChatId) === text(source.childChatId));
  const reviewerBase = baseModel(input.executor?.model);
  const sharesImplementer = rows.some((/** @type {Record<string, any>} */ row) => text(row?.leafId) === text(input.leafId)
    && delegationController(row) === parentChatId
    && isImplementOrFixDelegationRow(row)
    && reviewerBase !== ''
    && baseModel(row?.executor?.model) === reviewerBase);
  // Cross-role: re-entering the chat of the CURRENT round implementer cannot
  // hide anything (the server classifies that review as not independent);
  // any other chat of a same-model implementer still refuses.
  if (sharesImplementer && !(cross.active && isRoundImplementerChat(rows, input.leafId, source.childChatId))) {
    return failWith(SESSION_RESUME_REASON.INDEPENDENCE);
  }
  const holdsWork = chatRows.some((/** @type {Record<string, any>} */ row) => isImplementOrFixDelegationRow(row));
  // A reviewer session must never carry implementation or fix history, unless
  // cross-role reuse is on and the chat only holds this leaf's code review and
  // implement/fix work of this controller.
  if (holdsWork && !(cross.active && isCrossRoleChatHistory(chatRows, input.leafId, parentChatId))) {
    return failWith(SESSION_RESUME_REASON.CONTAMINATED);
  }
  const sawExchange = (/** @type {Record<string, any>} */ row) => text(row?.planReviewerPhase).toLowerCase() === 'exchange'
    || text(row?.exchangeOfDelegationId) !== '';
  const sourceSawPeers = chatRows.some(sawExchange) || sawExchange(source);
  const stamp = (/** @type {Record<string, any>} */ row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const superseded = chatRows.some((/** @type {Record<string, any>} */ row) => text(row.id) !== sourceId
    && isTerminalDelegationStatus(row.status)
    && (row.sessionResume?.status === 'resumed'
      ? text(row.sessionResume.sourceDelegationId) === sourceId || stamp(row) >= stamp(source)
      : stamp(row) > stamp(source)));
  if (superseded) return failWith(SESSION_RESUME_REASON.SOURCE_SUPERSEDED);
  const phase = text(input.planReviewerPhase).toLowerCase() || 'independent';
  if (phase === 'independent' && sourceSawPeers) return failWith(SESSION_RESUME_REASON.PEER_CONTEXT);
  if (!isTerminalDelegationStatus(source.status)) return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  if (text(source.status) === 'cancelled') return failWith(SESSION_RESUME_REASON.SOURCE_CANCELLED);
  if (text(source.status) === 'interrupted') return failWith(SESSION_RESUME_REASON.AFTER_RESTART);
  // An implement/fix source carries no review verdict; `completed` suffices.
  const verdict = text(source.reportVerdict || source.verdict).toUpperCase();
  if (text(source.status) !== 'completed' || (!cross.sourceIsCross && !USABLE_VERDICTS.has(verdict))) {
    return failWith(SESSION_RESUME_REASON.SOURCE_UNUSABLE);
  }
  const childChatId = text(source.childChatId);
  const claimed = rows.some((/** @type {Record<string, any>} */ row) => text(row?.id) !== sourceId
    && text(row?.childChatId) === childChatId
    && !isTerminalDelegationStatus(row.status));
  if (!childChatId || claimed) return failWith(SESSION_RESUME_REASON.SOURCE_CLAIMED);
  const chat = typeof input.findChat === 'function' ? input.findChat(childChatId) : null;
  if (!chat) return failWith(SESSION_RESUME_REASON.CHAT_MISSING);
  if (!readChatHarnessSessionId(transport, chat)) return failWith(SESSION_RESUME_REASON.SESSION_MISSING);
  if (typeof input.isRunActive === 'function' && input.isRunActive(childChatId)) {
    return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  }
  const continuity = inspectSessionContinuity(input, source, childChatId);
  if (!continuity.ok) return failWith(continuity.reasonCode);
  const previousRound = chatRows.reduce(
    (max, /** @type {Record<string, any>} */ row) => Math.max(max, Number(row.sessionResume?.round) || 1),
    1,
  );
  if (exceedsResumeContextCap(input, previousRound + 1)) return failWith(SESSION_RESUME_REASON.RESUME_CONTEXT_CAP);
  const crossRole = cross.sourceIsCross || holdsWork;
  return {
    requested: true,
    resume: true,
    reasonCode: crossRole ? SESSION_RESUME_REASON.RESUMED_CROSS_ROLE : SESSION_RESUME_REASON.RESUMED,
    reason: crossRole
      ? 'Re-entered the implementation chat of this leaf as a new code review round (not independent).'
      : 'Re-entered the named reviewer session as a new round.',
    sourceDelegationId: sourceId,
    childChatId,
    round: previousRound + 1,
    sessionGeneration: continuity.current.generation,
    sessionContinuity: continuity.current,
    ...(crossRole ? { crossRole: true, sourceWorkRole: readRowWorkRole(source) } : {}),
  };
}

/**
 * Cross-role context of one start/source pair. `sourceIsCross`: the opt-in is
 * on and the source row has the other role of {review_code, implement/fix};
 * `active`: the opt-in applies to this start on an audited transport.
 *
 * @param {Record<string, any>} input gate input (`crossRoleSessions`, `executor`, `reviewSubject`)
 * @param {string} startRole
 * @param {Record<string, any>} source
 * @returns {{ sourceIsCross: boolean, active: boolean }}
 */
function readCrossRoleContext(input, startRole, source) {
  const enabled = input.crossRoleSessions === true
    && CROSS_ROLE_SESSION_ROLES.includes(startRole)
    && (startRole !== 'review_code' || text(input.reviewSubject).toLowerCase() === 'code');
  if (!enabled) return { sourceIsCross: false, active: false };
  const transport = text(input.executor?.transport).toLowerCase();
  return {
    sourceIsCross: isCrossRoleSessionPair(startRole, readRowWorkRole(source)),
    active: CROSS_ROLE_TRANSPORTS.has(resolveAgentTransportProfile(transport)),
  };
}

/**
 * True when every row of the chat is a code review or implement/fix of this
 * leaf under this controller (the counterpart of the WORK_HISTORY clauses).
 *
 * @param {Record<string, any>[]} chatRows
 * @param {unknown} leafId
 * @param {string} parentChatId
 * @returns {boolean}
 */
function isCrossRoleChatHistory(chatRows, leafId, parentChatId) {
  const leaf = text(leafId);
  return leaf !== '' && chatRows.every((row) => CROSS_ROLE_SESSION_ROLES.includes(readRowWorkRole(row))
    && text(row.leafId) === leaf
    && delegationController(row) === parentChatId);
}

/**
 * True when `chatId` is the chat of the leaf's current round implementer (the
 * same choice as the todo review sync).
 *
 * @param {Record<string, any>[]} rows
 * @param {unknown} leafId
 * @param {unknown} chatId
 * @returns {boolean}
 */
function isRoundImplementerChat(rows, leafId, chatId) {
  const implementer = findRoundImplementer({ delegations: rows, leafId });
  return Boolean(implementer?.childChatId) && implementer.childChatId === text(chatId);
}

/**
 * A policy-level decision that never reached the resume gate (no source was
 * considered): fresh by policy, first session, learning, no eligible source...
 * Same shape as a gate fallback so cards and records treat both alike.
 *
 * @param {string} code a `SESSION_RESUME_REASON` value
 * @returns {ReturnType<typeof inspectDelegationSessionResume>}
 */
export function buildPolicyReuseDecision(code) {
  return {
    requested: true,
    resume: false,
    reasonCode: code,
    reason: REASON_TEXT[code] || code,
    sourceDelegationId: '',
  };
}

/**
 * Durable shape stored on the delegation row. `null` when resume was never
 * requested so legacy and default rows are unchanged. Plain "fresh chat"
 * outcomes (first session, learning, fresh by policy) get status `fresh`; a
 * refused resume stays `fallback`.
 *
 * @param {ReturnType<typeof inspectDelegationSessionResume>} decision
 * @param {{ generation?: number }} [extra]
 * @returns {Record<string, any> | null}
 */
export function buildSessionResumeRecord(decision, extra = {}) {
  if (!decision?.requested) return null;
  const status = decision.resume ? 'resumed' : FRESH_REASON_CODES.has(decision.reasonCode) ? 'fresh' : 'fallback';
  return {
    requested: true,
    status,
    reasonCode: decision.reasonCode,
    reason: decision.reason,
    sourceDelegationId: decision.sourceDelegationId,
    round: decision.resume ? decision.round : 1,
    sessionGeneration: decision.resume
      ? decision.sessionGeneration
      : Math.max(0, Number(extra.generation) || 0),
    workRole: text(decision.workRole || extra.workRole),
    // Card-only audit marker of an opt-in cross-role resume.
    ...(decision.resume && decision.crossRole === true
      ? { crossRole: true, sourceWorkRole: text(decision.sourceWorkRole) }
      : {}),
  };
}

/**
 * Gate for plan / implement / fix starts. Same liveness, claim, config and
 * generation checks as a review resume, within the selected leaf or controller scope,
 * to the role family (plan; implement+fix), and never crossing into review
 * history. implement -> fix is the only cross-role edge. Every outcome is a
 * new delegation: no earlier report or verification carries over.
 *
 * @param {Record<string, any>} input same input as `inspectDelegationSessionResume`
 * @param {{ source: Record<string, any>, sourceId: string, rows: Record<string, any>[], parentChatId: string, workRole: string, failWith: (code: string) => ReturnType<typeof inspectDelegationSessionResume> }} ctx
 * @returns {ReturnType<typeof inspectDelegationSessionResume>}
 */
function inspectWorkSessionResume(input, ctx) {
  const { source, sourceId, rows, parentChatId, workRole, failWith } = ctx;
  const leafId = text(input.leafId);
  const acrossLeaves = text(input.sessionScope).toLowerCase() === 'orchestrator';
  if (!acrossLeaves && !leafId) return failWith(SESSION_RESUME_REASON.NO_LEAF);
  const sourceRole = readRowWorkRole(source);
  if (!sourceRole) return failWith(SESSION_RESUME_REASON.UNCLASSIFIED);
  const cross = readCrossRoleContext(input, workRole, source);
  if (!cross.sourceIsCross && !allowedResumeSourceRoles(workRole).includes(sourceRole)) {
    return failWith(SESSION_RESUME_REASON.ROLE_CHANGED);
  }
  // A cross-role (code review) source is only reused inside its own leaf.
  if ((cross.sourceIsCross || !acrossLeaves) && text(source.leafId) !== leafId) {
    return failWith(SESSION_RESUME_REASON.SCOPE_CHANGED);
  }
  const transport = text(input.executor?.transport).toLowerCase();
  const sameConfig = text(source.executor?.transport).toLowerCase() === transport
    && sameExecutorConfig(transport, source.executor, input.executor)
    && text(source.executionMode) === text(input.executionMode)
    && text(source.executionFolder) === text(input.executionFolder)
    && (source.allowChildDelegations === true) === (input.allowChildDelegations === true)
    && (Number(source.depth) || 1) === (Number(input.depth) || 1)
    && text(source.rootChatId) === text(input.rootChatId);
  if (!sameConfig) return failWith(SESSION_RESUME_REASON.CONFIG_CHANGED);
  if (input.capabilities?.canResumeSession !== true) return failWith(SESSION_RESUME_REASON.UNSUPPORTED);
  if (cross.sourceIsCross && !cross.active) return failWith(SESSION_RESUME_REASON.CROSS_ROLE_UNSUPPORTED);
  if (input.lockoutActive === true) return failWith(SESSION_RESUME_REASON.LOCKED_OUT);
  const childChatId = text(source.childChatId);
  const chatRows = rows.filter((row) => childChatId !== '' && text(row?.childChatId) === childChatId);
  const family = WORK_FAMILY[workRole];
  // Cross-role reuse relaxes only the role clause: a code review row may sit in
  // the chat, but every row of the chat must belong to this leaf (never widened
  // by the orchestrator scope).
  const isForeignRow = (row) => {
    const role = readRowWorkRole(row);
    const relaxed = cross.active && role === 'review_code';
    if (!family.includes(role) && !relaxed) return true;
    if ((cross.active || !acrossLeaves) && text(row.leafId) !== leafId) return true;
    return delegationController(row) !== parentChatId;
  };
  if (chatRows.some(isForeignRow)) return failWith(SESSION_RESUME_REASON.WORK_HISTORY);
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const superseded = chatRows.some((row) => text(row.id) !== sourceId
    && isTerminalDelegationStatus(row.status)
    && (row.sessionResume?.status === 'resumed'
      ? text(row.sessionResume.sourceDelegationId) === sourceId || stamp(row) >= stamp(source)
      : stamp(row) > stamp(source)));
  if (superseded) return failWith(SESSION_RESUME_REASON.SOURCE_SUPERSEDED);
  if (!isTerminalDelegationStatus(source.status)) return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  if (text(source.status) === 'cancelled') return failWith(SESSION_RESUME_REASON.SOURCE_CANCELLED);
  if (text(source.status) === 'interrupted') return failWith(SESSION_RESUME_REASON.AFTER_RESTART);
  if (text(source.status) !== 'completed') return failWith(SESSION_RESUME_REASON.SOURCE_UNUSABLE);
  // A code review source still needs a usable verdict.
  if (sourceRole === 'review_code' && !USABLE_VERDICTS.has(text(source.reportVerdict || source.verdict).toUpperCase())) {
    return failWith(SESSION_RESUME_REASON.SOURCE_UNUSABLE);
  }
  // Claim: an active row on the chat (including a queued one created a moment
  // ago by a concurrent start) means the session is taken.
  const claimed = rows.some((row) => text(row?.id) !== sourceId
    && text(row?.childChatId) === childChatId
    && !isTerminalDelegationStatus(row.status));
  if (!childChatId || claimed) return failWith(SESSION_RESUME_REASON.SOURCE_CLAIMED);
  const chat = typeof input.findChat === 'function' ? input.findChat(childChatId) : null;
  if (!chat) return failWith(SESSION_RESUME_REASON.CHAT_MISSING);
  if (!readChatHarnessSessionId(transport, chat)) return failWith(SESSION_RESUME_REASON.SESSION_MISSING);
  if (typeof input.isRunActive === 'function' && input.isRunActive(childChatId)) {
    return failWith(SESSION_RESUME_REASON.SOURCE_BUSY);
  }
  const continuity = inspectSessionContinuity(input, source, childChatId);
  if (!continuity.ok) return failWith(continuity.reasonCode);
  const previousRound = chatRows.reduce((max, row) => Math.max(max, Number(row.sessionResume?.round) || 1), 1);
  if (exceedsResumeContextCap(input, previousRound + 1)) return failWith(SESSION_RESUME_REASON.RESUME_CONTEXT_CAP);
  const crossRole = chatRows.some((row) => readRowWorkRole(row) === 'review_code');
  return {
    requested: true,
    resume: true,
    reasonCode: crossRole ? SESSION_RESUME_REASON.RESUMED_CROSS_ROLE : SESSION_RESUME_REASON.RESUMED,
    reason: `Re-entered the earlier ${sourceRole} session as a new ${workRole} round.`,
    sourceDelegationId: sourceId,
    childChatId,
    round: previousRound + 1,
    sessionGeneration: continuity.current.generation,
    sessionContinuity: continuity.current,
    workRole,
    ...(crossRole ? { crossRole: true, sourceWorkRole: sourceRole } : {}),
  };
}

/**
 * A resume requires two durable proofs: the harness session identity/generation
 * did not change and no history event was appended after the source finished.
 *
 * @param {Record<string, any>} input
 * @param {Record<string, any>} source
 * @param {string} childChatId
 * @returns {{ ok: true, current: { identity: string, generation: number, historyHeadSeq: number | null } } | { ok: false, reasonCode: string }}
 */
function inspectSessionContinuity(input, source, childChatId) {
  const recorded = normalizeSessionContinuity(source?.sessionContinuity);
  const current = normalizeSessionContinuity(
    typeof input.currentContinuity === 'function'
      ? input.currentContinuity(childChatId)
      : null,
  );
  if (!recorded || !current || recorded.historyHeadSeq == null || current.historyHeadSeq == null) {
    return { ok: false, reasonCode: SESSION_RESUME_REASON.CONTINUITY_UNKNOWN };
  }
  if (recorded.identity !== current.identity || recorded.generation !== current.generation) {
    return { ok: false, reasonCode: SESSION_RESUME_REASON.SESSION_RESET };
  }
  if (source.sessionContinuityConfirmed !== true) {
    return { ok: false, reasonCode: SESSION_RESUME_REASON.CONTINUITY_UNKNOWN };
  }
  if (recorded.historyHeadSeq !== current.historyHeadSeq) {
    return { ok: false, reasonCode: SESSION_RESUME_REASON.WORK_HISTORY };
  }
  return { ok: true, current };
}

/**
 * Newest finished delegation in the selected controller/leaf scope whose session a
 * plan / implement / fix start may re-enter (auto-selection when the caller
 * names none). The executor was already chosen by the picker / explicit
 * request; only a source with the same transport and config is returned, and
 * `inspectDelegationSessionResume` still applies every gate. '' = none.
 *
 * @param {{ delegations?: Record<string, any>[], parentChatId?: unknown, leafId?: unknown, workRole?: unknown, sessionScope?: unknown, executor?: { transport?: unknown, model?: unknown, options?: unknown } }} input
 * @returns {string}
 */
export function findWorkResumeSource(input = {}) {
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  const leafId = text(input.leafId);
  const workRole = text(input.workRole).toLowerCase();
  const allowed = allowedResumeSourceRoles(workRole);
  const acrossLeaves = text(input.sessionScope).toLowerCase() === 'orchestrator';
  if (!parentChatId || (!acrossLeaves && !leafId) || allowed.length === 0) return '';
  const transport = text(input.executor?.transport).toLowerCase();
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const match = rows
    .filter((row) => allowed.includes(readRowWorkRole(row))
      && delegationController(row) === parentChatId
      && (acrossLeaves || text(row.leafId) === leafId)
      && text(row.status) === 'completed'
      && text(row.childChatId) !== ''
      && text(row.executor?.transport).toLowerCase() === transport
      && sameExecutorConfig(transport, row.executor, input.executor))
    .sort((a, b) => stamp(b) - stamp(a))[0];
  return match ? text(match.id) : '';
}

/**
 * Cross-role candidates for `continue_cross_role_sessions`, newest first: one
 * per child chat of this controller and leaf whose LATEST finished row has the
 * other role of {review_code, implement/fix} and the same transport and config
 * as the start. A code review start looks for implement/fix chats, an
 * implement/fix start for code review chats. Plan roles and `review_other`
 * get none. `inspectDelegationSessionResume` still applies every gate.
 *
 * @param {{ delegations?: Record<string, any>[], parentChatId?: unknown, leafId?: unknown, workRole?: unknown, executor?: { transport?: unknown, model?: unknown, options?: unknown } }} [input]
 * @returns {string[]}
 */
export function findCrossRoleResumeSources(input = {}) {
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const parentChatId = text(input.parentChatId);
  const leafId = text(input.leafId);
  const startRole = text(input.workRole).toLowerCase();
  if (!parentChatId || !leafId || !CROSS_ROLE_SESSION_ROLES.includes(startRole)) return [];
  const transport = text(input.executor?.transport).toLowerCase();
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const latestByChat = new Map();
  for (const row of rows) {
    const chatId = text(row?.childChatId);
    if (!chatId || delegationController(row) !== parentChatId || !isTerminalDelegationStatus(row.status)) continue;
    const current = latestByChat.get(chatId);
    if (!current || stamp(row) > stamp(current)) latestByChat.set(chatId, row);
  }
  return [...latestByChat.values()]
    .filter((row) => text(row.status) === 'completed'
      && text(row.leafId) === leafId
      && isCrossRoleSessionPair(startRole, readRowWorkRole(row))
      && text(row.executor?.transport).toLowerCase() === transport
      && sameExecutorConfig(transport, row.executor, input.executor))
    .sort((a, b) => stamp(b) - stamp(a))
    .map((row) => text(row.id));
}

/**
 * Empty-report guard. Keyed on the candidate's SOURCE CHAT (not on the start's
 * role): true when the newest terminal (failed or completed) delegation of
 * that chat under the same controller was itself a resumed attempt that ended
 * with an empty report. Cancelled or interrupted attempts do not count, and a
 * later healthy attempt makes the chat resumable again.
 *
 * @param {{ delegations?: Record<string, any>[], sourceId?: unknown, parentChatId?: unknown }} [input]
 * @returns {boolean}
 */
export function hasEmptyResumedReport(input = {}) {
  const rows = Array.isArray(input.delegations) ? input.delegations : [];
  const sourceId = text(input.sourceId);
  const parentChatId = text(input.parentChatId);
  const source = /** @type {Record<string, any>} */ (rows.find((row) => text(row?.id) === sourceId));
  const chatId = text(source?.childChatId);
  if (!chatId) return false;
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const newest = rows
    .filter((row) => text(row?.childChatId) === chatId
      && delegationController(row) === parentChatId
      && ['failed', 'completed'].includes(text(row?.status)))
    .sort((a, b) => stamp(b) - stamp(a))[0];
  return Boolean(newest) && text(newest.sessionResume?.status) === 'resumed' && text(newest.report) === '';
}
