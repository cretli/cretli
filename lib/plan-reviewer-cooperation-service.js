/**
 * Runtime orchestration for plan-reviewer cooperation sessions.
 * Coordinator = parent chat that created the session (refine orchestrator).
 */

import { randomUUID } from 'node:crypto';
import { getTodoById } from './persist/todos-persist.js';
import { resolveDataPath } from './runtime-paths.js';
import { isTerminalDelegationStatus } from './delegation-status.js';
import { resolveDelegationRecordVerdict } from './delegation-verdict.js';
import {
  buildPlanReviewerCollaborativePromptBlock,
  buildPlanReviewerExchangePromptBlock,
  buildPlanReviewerPeerSummary,
  buildPlanReviewerReadOnlyPromptBlock,
  canOpenPlanReviewerExchangePhase,
  canPostPlanReviewerCollaborativeMessage,
  canonicalPlanReviewerSessionReviewers,
  computeTodoPlanRevisionKey,
  isPlanReviewerSessionStale,
  normalizePlanReviewerCooperationMode,
  resolvePlanReviewerSelfRowDelegationId,
  sanitizePlanReviewerPeerText,
  summarizePlanReviewerDivergence,
} from './plan-reviewer-cooperation.js';
import {
  getPlanReviewerSessionById as getSessionById,
  listPlanReviewerSessionsForTodo as listSessionsForTodo,
  upsertPlanReviewerSession as upsertSession,
} from './persist/plan-reviewer-sessions-persist.js';

// The persist layer returns loosely typed rows; widen them here so session fields type-check.
const getPlanReviewerSessionById = /** @type {(...args: any[]) => any} */ (getSessionById);
const listPlanReviewerSessionsForTodo = /** @type {(...args: any[]) => any[]} */ (listSessionsForTodo);
const upsertPlanReviewerSession = /** @type {(...args: any[]) => any} */ (upsertSession);

/**
 * @param {Record<string, any>} session
 * @param {string} currentRevisionKey
 * @returns {Record<string, any>}
 */
export function markPlanReviewerSessionStaleIfRevisionChanged(session, currentRevisionKey) {
  if (!session || typeof session !== 'object') return session;
  const stored = String(session.planRevisionKey || '').trim();
  const current = String(currentRevisionKey || '').trim();
  if (!stored || !current || stored === current) return session;
  return upsertPlanReviewerSession({
    ...session,
    phase: 'stale',
    staleReason: 'plan_revision_changed',
  });
}

/**
 * @param {{
 *   dataDir: string,
 *   workspaceFolder: string,
 *   todoId: string,
 *   coordinatorChatId: string,
 *   cooperationMode?: unknown,
 * }} input
 * @returns {{ ok: true, session: Record<string, any> } | { ok: false, status: number, error: string, code: string }}
 */
export function createPlanReviewerSession(input) {
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  const todoId = String(input.todoId || '').trim();
  const coordinatorChatId = String(input.coordinatorChatId || '').trim();
  if (!workspaceFolder || !todoId || !coordinatorChatId) {
    return { ok: false, status: 400, error: 'todoId, workspaceFolder and coordinatorChatId are required.', code: 'validation' };
  }
  const todo = getTodoById(input.dataDir, workspaceFolder, todoId);
  if (!todo) {
    return { ok: false, status: 404, error: 'Todo not found.', code: 'not_found' };
  }
  const planRevisionKey = computeTodoPlanRevisionKey(todo);
  const session = upsertPlanReviewerSession({
    id: randomUUID(),
    todoId: todoId.toLowerCase(),
    workspaceFolder,
    coordinatorChatId,
    cooperationMode: normalizePlanReviewerCooperationMode(input.cooperationMode),
    planRevisionKey,
    phase: 'independent',
    exchangeRoundUsed: false,
    reviewers: [],
    messages: [],
    aggregatedVerdict: '',
    divergenceSummary: '',
  });
  return { ok: true, session };
}

/**
 * Reuse a coordinator's session for the saved revision, or create a new round.
 * Closed sessions are returned as-is; this never resets their review evidence.
 * @param {Parameters<typeof createPlanReviewerSession>[0]} input
 * @returns {ReturnType<typeof createPlanReviewerSession>}
 */
export function ensurePlanReviewerSession(input) {
  const todo = getTodoById(input.dataDir, input.workspaceFolder, input.todoId);
  const revisionKey = computeTodoPlanRevisionKey(todo);
  const mode = normalizePlanReviewerCooperationMode(input.cooperationMode);
  const existing = todo && listPlanReviewerSessionsForTodo(input.todoId, input.workspaceFolder)
    .find((session) => session.coordinatorChatId === input.coordinatorChatId
      && session.planRevisionKey === revisionKey
      && session.cooperationMode === mode
      && !isPlanReviewerSessionStale(session));
  if (existing) return { ok: true, session: existing };
  return createPlanReviewerSession(input);
}

/**
 * @param {any} value
 * @returns {string}
 */
export function resolvePlanReviewerExchangeOriginDelegationId(value) {
  const row = value && typeof value === 'object' ? value : {};
  return String(
    row.exchangeOfDelegationId
    ?? row.exchange_of_delegation_id
    ?? row.originDelegationId
    ?? row.origin_delegation_id
    ?? '',
  ).trim();
}

/**
 * Session row key for a plan-review delegation (exchange jobs map to the independent row).
 *
 * @param {Record<string, any>} delegation
 * @returns {string}
 */
export function resolvePlanReviewerSessionRowDelegationId(delegation) {
  const phase = String(delegation?.planReviewerPhase || 'independent').trim() || 'independent';
  const origin = resolvePlanReviewerExchangeOriginDelegationId(delegation);
  if (phase === 'exchange' && origin) return origin;
  return String(delegation?.id || '').trim();
}

/**
 * @param {Record<string, any>} session
 * @param {string} delegationId
 * @param {number} [slotIndex]
 * @param {{ phase?: string, originDelegationId?: string, exchangeOfDelegationId?: string }} [options]
 * @returns {Record<string, any>}
 */
export function registerPlanReviewerDelegation(session, delegationId, slotIndex = 0, options = {}) {
  const id = String(delegationId || '').trim();
  if (!session || !id) return session;
  const phase = String(options?.phase || 'independent').trim() || 'independent';
  const originDelegationId = String(
    options?.originDelegationId ?? options?.exchangeOfDelegationId ?? '',
  ).trim();
  if (phase === 'exchange') {
    if (!originDelegationId) return session;
    const reviewers = Array.isArray(session.reviewers) ? [...session.reviewers] : [];
    let touched = false;
    const next = reviewers.map((row) => {
      if (row.delegationId !== originDelegationId) return row;
      touched = true;
      return {
        ...row,
        phase: 'exchange',
        exchangeDelegationId: id,
      };
    });
    if (!touched) return session;
    return upsertPlanReviewerSession({ ...session, reviewers: next });
  }
  const reviewers = Array.isArray(session.reviewers) ? [...session.reviewers] : [];
  if (reviewers.some((row) => row.delegationId === id)) return session;
  reviewers.push({
    delegationId: id,
    slotIndex: Math.max(0, Math.floor(Number(slotIndex) || 0)),
    phase: 'independent',
    verdict: '',
    reportSummary: '',
    exchangeVerdict: '',
    exchangeDelegationId: '',
    exchangeUsed: false,
    independentFinished: false,
    finishedAt: '',
  });
  return upsertPlanReviewerSession({ ...session, reviewers });
}

/**
 * @param {Record<string, any>} session
 * @returns {Record<string, any>}
 */
function recomputePlanReviewerSessionAggregation(session) {
  const reviewers = canonicalPlanReviewerSessionReviewers(session.reviewers);
  const { aggregated, divergence } = summarizePlanReviewerDivergence(reviewers, session.phase === 'exchange' ? 'exchange' : 'independent');
  return upsertPlanReviewerSession({
    ...session,
    aggregatedVerdict: aggregated,
    divergenceSummary: divergence.summary,
  });
}

/**
 * @param {Record<string, any>} session
 * @returns {Record<string, any>}
 */
export function maybeAdvancePlanReviewerExchangePhase(session) {
  if (!canOpenPlanReviewerExchangePhase(session)) return session;
  return upsertPlanReviewerSession({
    ...session,
    phase: 'exchange',
    exchangeRoundUsed: true,
  });
}

/**
 * @param {Record<string, any>} session
 * @returns {Record<string, any>}
 */
function maybeClosePlanReviewerSession(session) {
  const mode = normalizePlanReviewerCooperationMode(session.cooperationMode);
  const phase = String(session.phase || '');
  const reviewers = canonicalPlanReviewerSessionReviewers(session.reviewers);
  if (phase === 'stale' || phase === 'closed') return session;
  if (mode === 'exchange' && phase === 'exchange') {
    const allExchangeDone = reviewers.length > 0 && reviewers.every((row) => row.exchangeUsed || row.exchangeVerdict);
    if (allExchangeDone) {
      return upsertPlanReviewerSession({ ...session, phase: 'closed' });
    }
    return session;
  }
  const allIndependentDone = reviewers.length > 0 && reviewers.every((row) => row.independentFinished);
  if (!allIndependentDone) return session;
  if (mode === 'exchange') return maybeAdvancePlanReviewerExchangePhase(session);
  // A reviewer that ended without a usable verdict (provider limit, adapter
  // failure) must stay replaceable: closing here would reject the replacement
  // start with phase_closed and strand the whole review round.
  const hasUnusableReviewer = reviewers.some((row) => !['PASS', 'FAIL', 'BLOCKED'].includes(String(row.verdict || '').toUpperCase()));
  if (hasUnusableReviewer) return session;
  return upsertPlanReviewerSession({ ...session, phase: 'closed' });
}

/**
 * Called when a linked plan-review delegation reaches a terminal status.
 *
 * @param {Record<string, any>} delegation
 * @returns {Record<string, any> | null}
 */
export function syncPlanReviewerSessionAfterDelegationFinish(delegation) {
  const sessionId = String(delegation?.planReviewerSessionId || '').trim();
  if (!sessionId) return null;
  let session = getPlanReviewerSessionById(sessionId);
  if (!session) return null;
  const dataDir = resolveDataPath();
  const todo = getTodoById(dataDir, delegation.workspaceFolder, session.todoId);
  session = markPlanReviewerSessionStaleIfRevisionChanged(session, computeTodoPlanRevisionKey(todo));
  if (isPlanReviewerSessionStale(session)) return session;
  const rowDelegationId = resolvePlanReviewerSessionRowDelegationId(delegation);
  const phase = String(delegation.planReviewerPhase || 'independent').trim() || 'independent';
  const verdict = resolveDelegationRecordVerdict(delegation);
  const summary = buildPlanReviewerPeerSummary(delegation.report || '');
  const reviewers = (Array.isArray(session.reviewers) ? session.reviewers : []).map((/** @type {any} */ row) => {
    if (row.delegationId !== rowDelegationId) return row;
    if (phase === 'exchange') {
      return {
        ...row,
        phase: 'exchange',
        exchangeVerdict: verdict,
        exchangeUsed: true,
        finishedAt: String(delegation.finishedAt || new Date().toISOString()),
      };
    }
    return {
      ...row,
      phase: 'independent',
      verdict,
      reportSummary: summary,
      independentFinished: true,
      finishedAt: String(delegation.finishedAt || new Date().toISOString()),
    };
  });
  session = upsertPlanReviewerSession({ ...session, reviewers });
  session = recomputePlanReviewerSessionAggregation(session);
  session = maybeClosePlanReviewerSession(session);
  return session;
}

/**
 * @param {{
 *   sessionId: string,
 *   delegationId: string,
 *   text: unknown,
 * }} input
 * @returns {{ ok: true, session: Record<string, any>, message: Record<string, any> } | { ok: false, status: number, error: string, code: string }}
 */
export function postPlanReviewerCollaborativeMessage(input) {
  const sessionId = String(input.sessionId || '').trim();
  const delegationId = String(input.delegationId || '').trim();
  let session = getPlanReviewerSessionById(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: 'Session not found.', code: 'not_found' };
  }
  if (!canPostPlanReviewerCollaborativeMessage(session, delegationId)) {
    return { ok: false, status: 409, error: 'Collaborative messaging is not allowed in this state.', code: 'not_allowed' };
  }
  const text = sanitizePlanReviewerPeerText(input.text);
  if (!text) {
    return { ok: false, status: 400, error: 'Message text is required.', code: 'validation' };
  }
  const message = {
    id: randomUUID(),
    fromDelegationId: delegationId,
    text,
    planRevisionKey: String(session.planRevisionKey || ''),
    createdAt: new Date().toISOString(),
  };
  const messages = [...(Array.isArray(session.messages) ? session.messages : []), message];
  session = upsertPlanReviewerSession({ ...session, messages });
  return { ok: true, session, message };
}

/**
 * Peer summaries for exchange phase (excluding the requesting delegation).
 *
 * @param {string} sessionId
 * @param {string} forDelegationId
 * @returns {{ ok: true, session: Record<string, any>, peerSummaries: string[] } | { ok: false, status: number, error: string, code: string }}
 */
export function getPlanReviewerExchangePayload(sessionId, forDelegationId) {
  let session = getPlanReviewerSessionById(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: 'Session not found.', code: 'not_found' };
  }
  if (String(session.phase || '') !== 'exchange') {
    return { ok: false, status: 409, error: 'Exchange phase is not open yet.', code: 'exchange_not_ready' };
  }
  const reviewers = Array.isArray(session.reviewers) ? session.reviewers : [];
  const selfRowId = resolvePlanReviewerSelfRowDelegationId(reviewers, forDelegationId);
  const peerSummaries = reviewers
    .filter((/** @type {any} */ row) => {
      if (selfRowId && row.delegationId === selfRowId) return false;
      return row.independentFinished === true && Boolean(row.reportSummary);
    })
    .map((/** @type {any} */ row) => row.reportSummary);
  return { ok: true, session, peerSummaries };
}

/**
 * @param {string} baseExtra
 * @param {{ planReviewerSessionId?: string, planReviewerPhase?: string, id?: string }} record
 * @returns {string}
 */
export function mergePlanReviewerDelegationExtraInstructions(baseExtra, record) {
  const sessionId = String(record?.planReviewerSessionId || '').trim();
  if (!sessionId) return String(baseExtra || '').trim();
  const cooperation = buildPlanReviewerCooperationPromptExtras({
    sessionId,
    delegationId: String(record?.id || '').trim(),
    phase: String(record?.planReviewerPhase || 'independent').trim() || 'independent',
  });
  return [
    String(baseExtra || '').trim(),
    buildPlanReviewerReadOnlyPromptBlock(),
    cooperation,
  ].filter(Boolean).join('\n\n');
}

/**
 * Prompt extras for a plan review delegation tied to a cooperation session.
 *
 * @param {{
 *   sessionId?: string,
 *   delegationId?: string,
 *   phase?: string,
 * }} input
 * @returns {string}
 */
export function buildPlanReviewerCooperationPromptExtras(input) {
  const sessionId = String(input?.sessionId || '').trim();
  if (!sessionId) return '';
  const session = getPlanReviewerSessionById(sessionId);
  if (!session || isPlanReviewerSessionStale(session)) return '';
  const phase = String(input?.phase || 'independent').trim() || 'independent';
  const delegationId = String(input?.delegationId || '').trim();
  const mode = normalizePlanReviewerCooperationMode(session.cooperationMode);
  const blocks = [];
  blocks.push(
    `[PLAN REVIEW COOPERATION]\nMode: ${mode}. Coordinator chat: ${session.coordinatorChatId}. Session: ${session.id}. Phase: ${phase}.`,
  );
  if (mode === 'collaborative' && phase === 'independent') {
    const revisionKey = String(session.planRevisionKey || '').trim();
    const messages = (Array.isArray(session.messages) ? session.messages : [])
      .filter((/** @type {any} */ row) => !revisionKey || String(row.planRevisionKey || '').trim() === revisionKey)
      .map((/** @type {any} */ row) => {
      const slot = (session.reviewers || []).find((/** @type {any} */ r) => r.delegationId === row.fromDelegationId);
      const fromLabel = slot ? `reviewer slot ${Number(slot.slotIndex) + 1}` : 'reviewer';
      return { fromLabel, text: row.text, createdAt: row.createdAt };
    });
    const collaborative = buildPlanReviewerCollaborativePromptBlock(messages);
    if (collaborative) blocks.push(collaborative);
  }
  if (mode === 'exchange' && phase === 'exchange') {
    const payload = getPlanReviewerExchangePayload(sessionId, delegationId);
    if (payload.ok) {
      const exchange = buildPlanReviewerExchangePromptBlock(payload.peerSummaries);
      if (exchange) blocks.push(exchange);
    }
  }
  return blocks.filter(Boolean).join('\n\n');
}

/**
 * Invalidate open sessions when a todo plan changes.
 *
 * @param {{ dataDir: string, workspaceFolder: string, todoId: string }} input
 */
export function stalePlanReviewerSessionsForTodoPlanChange(input) {
  const sessions = listPlanReviewerSessionsForTodo(input.todoId, input.workspaceFolder);
  const todo = getTodoById(input.dataDir, input.workspaceFolder, input.todoId);
  const revisionKey = computeTodoPlanRevisionKey(todo);
  for (const session of sessions) {
    if (String(session.phase || '') === 'closed') continue;
    markPlanReviewerSessionStaleIfRevisionChanged(session, revisionKey);
  }
}

/**
 * @param {string} sessionId
 * @returns {Record<string, any> | null}
 */
export function refreshPlanReviewerSessionView(sessionId) {
  const session = getPlanReviewerSessionById(sessionId);
  if (!session) return null;
  return recomputePlanReviewerSessionAggregation(session);
}

/**
 * @param {{
 *   planReviewerSessionId?: unknown,
 *   planReviewerPhase?: unknown,
 *   reviewSubject?: unknown,
 * }} input
 * @returns {{ ok: true, session?: Record<string, any> } | { ok: false, status: number, error: string, code: string }}
 */
export function inspectPlanReviewerDelegationStart(input) {
  const sessionId = String(input?.planReviewerSessionId || '').trim();
  if (!sessionId) return { ok: true };
  const subject = String(input?.reviewSubject || '').trim();
  if (subject !== 'plan') {
    return {
      ok: false,
      status: 400,
      error: 'Plan reviewer sessions require review_subject plan.',
      code: 'validation',
    };
  }
  const phase = String(input?.planReviewerPhase || 'independent').trim() || 'independent';
  let session = getPlanReviewerSessionById(sessionId);
  if (!session) {
    return { ok: false, status: 404, error: 'Plan reviewer session not found.', code: 'not_found' };
  }
  const dataDir = resolveDataPath();
  const todo = getTodoById(dataDir, session.workspaceFolder, session.todoId);
  session = markPlanReviewerSessionStaleIfRevisionChanged(session, computeTodoPlanRevisionKey(todo));
  if (isPlanReviewerSessionStale(session)) {
    return { ok: false, status: 409, error: 'Plan reviewer session is stale (plan changed).', code: 'stale' };
  }
  if (phase === 'exchange') {
    if (String(session.phase || '') !== 'exchange') {
      return {
        ok: false,
        status: 409,
        error: 'Exchange phase is not open yet.',
        code: 'exchange_not_ready',
      };
    }
    return { ok: true, session };
  }
  if (String(session.phase || '') !== 'independent') {
    return {
      ok: false,
      status: 409,
      error: 'Independent review phase is closed for this session.',
      code: 'phase_closed',
    };
  }
  return { ok: true, session };
}

/**
 * @param {Record<string, any>} delegation
 * @returns {boolean}
 */
export function isPlanReviewerCooperationDelegation(delegation) {
  return Boolean(String(delegation?.planReviewerSessionId || '').trim());
}

/**
 * @param {Record<string, any>} delegation
 * @returns {boolean}
 */
export function isDelegationTerminalForPlanReviewer(delegation) {
  return isTerminalDelegationStatus(String(delegation?.status || ''));
}
