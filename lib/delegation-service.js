/**
 * Create, start, cancel, and retry plan-execution delegations.
 */

/** @import { DelegationRecord, ChatRow } from "./shared-types/index.ts" */

/** @typedef {DelegationRecord & Record<string, any>} DelegationRow */
/** @typedef {ChatRow & Record<string, any>} ChatRowAny */

import { prepareOrchestrationTakeover, executeOrchestrationTakeoverUnlocked } from './delegation-takeover.js';
import { loadDelegationTakeovers, takeoverInProgressResult } from './persist/delegation-takeovers-persist.js';
import { withChatLock } from './delegation-mailbox.js';
import { randomUUID } from 'crypto';
import { canChatControlDelegation, delegationController, delegationScopeChatIds } from './delegation-control.js';
import { addChat, loadChats, updateChat } from './persist/chats-persist.js';
import { isChatArchived } from './chat-tree.js';
import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-service.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import { broadcastChatHistoryUpdate } from './sdk/sdk-history-updates.ts';
import {
  createDelegationRecord,
  findDelegationByChildChatId,
  findDelegationByIdempotencyKey,
  getDelegationById,
  listActiveDelegations,
  listActiveDelegationsForController,
  listDelegationsForController,
  listDelegationsForTreeRoot,
  loadDelegations,
  loadDelegationsReadonly,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { collectDelegationSubtreePostOrder } from './delegation-tree-cancel.js';
import {
  finishCancellingWithStopProof,
  finishDelegationInterruptedRestart,
  interruptDelegationsWithRestartEvidence,
  isChildConfirmedGone,
  resolveCancellingDeadline,
} from './delegation-cancelling-deadline.js';
import { hasWorkspaceWatcherLeafRestartEvidence } from './workspace-watcher-restart-evidence.js';
import { normalizeDelegationRunDeadlineAt, resolveEffectiveRunDeadlineEpoch } from './delegation-run-deadline.js';
import { isDelegationStartupFailure, resolveStartupRetryCount, resolveStartupRetryDelayMs } from './delegation-startup-failure.js';
import {
  confirmDelegationManualSlotRelease,
  delegationHarnessSupportsAbort,
  isCancelUnconfirmedDelegationSlot,
} from './delegation-slot-stop.js';
import {
  resolveDelegationParentWidth,
  isQueueableDelegationConflict,
  readDelegationQueueMax,
  resolveDelegationTreeSlots,
} from './delegation-width.js';
import { resolveIncomingTreeRootId } from './delegation-tree-lock.js';
import { assertPlannerAdapterAllowed, assertReviewAdapterAllowed } from './delegation-adapter-capabilities.js';
import {
  buildNamedDelegationStartHardGateInputAsync,
  evaluateDelegationStartHardGates,
  resolveDelegationGateRole,
} from './delegation-model-gates.js';
import {
  clearHarnessStartupFailureLockout,
  noteDelegationFailureLockout,
  getHarnessUsageLimit,
  listHarnessUsageLimits,
  listHarnessUsageLimitsForWorkspace,
  noteHarnessUsageLimit,
} from './harness-usage-limits.js';
import { findActiveLockoutRow } from './model-pick-gate-primitives.js';
import { resolveDelegationTechnicalSuccess } from './delegation-cycle-classify.js';
import { findLatestTerminalImplementFixForLeaf, inspectImplementVerifyBeforeReview, isImplementOrFixDelegationRow, waitForImplementVerifyBeforeReview } from './delegation-implement-verify-gate.js';
import { trackAutoVerifyChain } from './auto-verify-inflight.js';
import { REVIEW_VERIFY_CATALOG, REVIEW_VERIFY_IDS, resolveDefaultReviewVerifyIds, resolveReviewVerifyCatalog, resolveReviewVerifyIdsForPath, runReviewVerify } from './sdk/sdk-review-verify.ts';
import { inspectReviewRecheckWithoutChange } from './delegation-review-recheck-gate.js';
import { inspectReviewIndependence } from './delegation-review-independence-gate.js';
import { listReviewLessons } from './persist/review-lessons-persist.js';
import { isReviewLessonsEnabled, selectReviewLessons } from './review-lessons-select.js';
import { addReviewerPairMember, removeReviewerPairMember } from './persist/reviewer-pairs-persist.js';
import { buildReviewerPolicySnapshot, isSameReviewer } from './reviewer-policy.js';
import { isReviewerMemberStartable } from './reviewer-member-startable.js';
import { listReviewCandidates } from './model-role-profiles.js';
import { readControllerChatModel } from './model-pick-service.js';
import { readLatestOperatorEventsByLeaf, recordOperatorEvent } from './persist/operator-journal-persist.js';
import {
  SESSION_RESUME_REASON,
  buildPolicyReuseDecision,
  buildSessionResumeRecord,
  findPairResumeSource,
  findCrossRoleResumeSources,
  findWorkResumeSource,
  inspectDelegationSessionResume,
  hasEmptyResumedReport,
  readResumeSessionOfInput,
} from './delegation-session-resume.js';
import { getCacheStateForChat } from './usage/cache-state.ts';
import { buildChatCacheView } from './usage/cache-freshness-view.ts';
import {
  createSessionContinuity,
  normalizeSessionContinuity,
  readCurrentSessionContinuity,
} from './delegation-session-continuity.js';
import { readAttemptUsageMetrics } from './usage/attempt-usage.ts';
import {
  areMetricsEqual,
  isMetricsEmpty,
  mergeLateMetrics,
  resetMetricsPatch,
} from './delegation-metrics.js';
import {
  applyDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
  resolveDelegationWorkflowRow,
} from './delegation-workflow.js';
import { evaluateReviewRoundOnFinish, onReviewRoundResolved } from './review-round-resolution.js';
import { installLessonDistillation } from './review-lessons-distill.js';
import { installLessonFeedback } from './review-lessons-feedback.js';
import { parseReviewFindings, summarizeParsedReviewFindings } from './review-findings-parse.js';
import { isReviewFindingsBlockEnabled } from './review-findings-taxonomy.js';
import {
  closeReviewFindingsCycle,
  listOpenReviewFindings,
  markReviewFindingsStillOpenAtStop,
  recordReviewFindings,
} from './persist/review-findings-ledger-persist.js';
import {
  buildCodeReviewWorkflowPatchOnFinish,
  buildCodeReviewWorkflowPatchOnStart,
  DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED,
  REVIEWER_PAIR_UNSATISFIABLE_CODE,
  evaluateReviewerPairStartGate,
  inspectDelegationCodeReviewStart,
  isCredibleCodeReviewTerminal,
  resolveCodeReviewPhaseWorkflowIdempotencyKey,
  resolveEffectiveCodeReviewReportVerdict,
} from './delegation-code-review-phase.js';
import {
  normalizeDelegationWorkflowLeafId,
  readDelegationWorkflowLeafIdFromRow,
} from './delegation-workflow-leaf.js';
import { extractLeafAcceptanceCriteria } from './delegation-review-gate.js';
import { getTodo as getTodoById, linkTodoChat, listTodos } from './persist/todos-store.js';
import { isFeedbackDerivedTodo } from './persist/feedback-store.js';
import { resolveCrossRoleContinuation, resolveDelegationContinuationPolicy, resolveResumeContextCapRounds } from './delegation-settings.js';
import {
  classifyDelegationWorkRole,
  delegationRuntimeAssignment,
  isPlanAuthoringDelegationRow,
  isWorkContinuationRole,
  readRowWorkRole,
} from './delegation-work-role.js';
import { collectTodoLeafScopePaths } from './todo-parallel-scope.js';
import {
  listOccupiedDelegations,
  resolveDelegationGlobalLimit,
  resolveDelegationWorkspaceWriteConflict,
} from './delegation-workspace-guard.js';
import { readChatPlanDocument } from './chat-plan-persist.js';
import { normalizeSkillIds } from './skills/skill-selection.js';

/**
 * Explicit skill IDs stored on a delegation row (empty for rows from before the field).
 *
 * @param {any} row
 * @returns {string[]}
 */
function skillIdsOfRow(row) {
  return Array.isArray(row?.selectedSkillIds) ? row.selectedSkillIds : [];
}
import { cancelChatRun, getChatRunAdapterCapabilities, getChatRunState, hasChatRunAdapter, isChatRunConfirmedIdle, probeChatRunLiveness, startChatRun } from './chat-run-service.js';
import { buildDelegationExecutorPrompt } from './delegation-prompt.js';
import { resolveHistoryMessageSource } from './delegation-source.js';
import {
  buildDelegationRequestHash,
  hashDelegationContent,
  normalizeDelegationAssignment,
  resolveDelegationChildExecutionMode,
  normalizeDelegationSourceKind,
  normalizeDelegationPickReason,
  isDelegationPickReasonTooLong,
  resolveDelegationReviewSubject,
  MAX_DELEGATION_PICK_REASON_LENGTH,
} from './delegation-request.js';
import { drainChatMailbox, enqueueMailboxMessage, ensureDelegationParentMailboxReply, reconcileMailboxOnBoot } from './delegation-mailbox.js';
import { enqueueDelegationStoreWork } from './delegation-store-lock.js';
import { snapshotDelegationAttempt, countDelegationAttempts, listDelegationAttempts } from './delegation-attempt.js';
import { normalizeDelegationAckActor } from './delegation-ack-actor.js';
import { syncTodoReviewForDelegation } from './todo-review-sync-hooks.js';
import {
  inspectPlanReviewerDelegationStart,
  mergePlanReviewerDelegationExtraInstructions,
  registerPlanReviewerDelegation,
  resolvePlanReviewerExchangeOriginDelegationId,
  syncPlanReviewerSessionAfterDelegationFinish,
} from './plan-reviewer-cooperation-service.js';
import { computeTodoPlanContentKey, computeTodoPlanRevisionKey } from './plan-reviewer-cooperation.js';
import { readDelegationMaterialRevisionForRecord } from './delegation-material-revision.js';
import {
  buildLeafMaterialPromptBlock,
  ensureLeafMaterialBase,
  readLeafScopedMaterialRevisionForTodo,
  updateLeafMaterialPartialPaths,
} from './todo-leaf-material.js';
import { logDelegationEvent } from './delegation-log.js';
import { resolveDataPath } from './runtime-paths.js';
import {
  armDelegationUsageLimitPause,
  cancelParentDelegationUsageLimitPauses,
  cancelSubjectUsageLimitPauses,
} from './usage-limit-paused.js';
import { BASELINE_ASYNC_BUDGET_MS, BASELINE_CONTROL_ID, buildVerifyClassificationFields, classifyReviewVerify } from './review-verify-baseline.js';
import { buildImportIndex, collectDependencies } from './job-queue/import-graph.js';
import { getDefaultVerifyRunner } from './job-queue/default-queue.js';
import { readLeafTodoReviewerPair, resolveDelegationEnv, resolveDelegationSettings, resolvePlanWindowSettings, resolveTodoReviewerPolicy } from './delegation-settings.js';

setDelegationStatusEnvResolver(resolveDelegationEnv);
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  attachLeafResolutionFields,
  resolveRequestLeafContext,
} from './orchestrator-leaf-resolution.js';
import { getWorkspaceWatcher, getWorkspaceWatcherActiveCycles } from './persist/workspace-watchers-persist.js';
import { readWorkspaceWatcherTodoFindings } from './workspace-watcher-guardrails.js';

/**
 * @param {{
 *   parentChatId?: string,
 *   leafId?: string,
 *   cwd?: string,
 *   assignment?: string,
 *   executionMode?: string,
 *   workRole?: string,
 *   reviewSubject?: string,
 * }} input
 * @returns {Promise<{ workflowRow: Record<string, any> | null, leafAcceptanceText: string, leafMaterialText: string, watcherFindingsText: string, leafTodo: Record<string, any> | null, openLedgerFindings: Record<string, any>[] }>}
 */
async function readExecutorPromptExtras(input) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = normalizeDelegationWorkflowLeafId({ leafId: input.leafId });
  if (!parentChatId) {
    return { workflowRow: null, leafAcceptanceText: '', leafMaterialText: '', watcherFindingsText: '', leafTodo: null, openLedgerFindings: [] };
  }
  const workflowRow = resolveDelegationWorkflowRow({ parentChatId, leafId });
  let leafAcceptanceText = '';
  let leafMaterialText = '';
  let leafTodo = null;
  const cwd = String(input.cwd || '').trim();
  const dataDir = resolveDataPath();
  if (leafId && cwd) {
    const assignment = String(input.assignment || '').trim();
    const isPlanReview = assignment === 'review' && input.reviewSubject === 'plan';
    if (input.workRole !== 'plan' && !isPlanReview
      && (assignment === 'implement' || assignment === 'fix' || assignment === 'review')) {
      const watcherPolicy = /** @type {any} */ (getWorkspaceWatcher(cwd, { dataDir }))?.policy ?? null;
      leafTodo = (await ensureLeafMaterialBase({ dataDir, workspaceFolder: cwd, leafId, policy: watcherPolicy }))
        || await getTodoById(dataDir, cwd, leafId);
    } else {
      leafTodo = await getTodoById(dataDir, cwd, leafId);
    }
    if (leafTodo?.body) {
      leafAcceptanceText = extractLeafAcceptanceCriteria(leafTodo.body);
    }
    if (leafTodo) {
      leafMaterialText = buildLeafMaterialPromptBlock(leafTodo);
    }
  }
  // The workflow row is keyed by parent chat + leaf, so a new Watcher cycle
  // (new orchestrator chat) would lose earlier findings. The Watcher findings
  // store is keyed by leaf and is written by `record_findings`, so merge it in.
  let watcherFindingsText = '';
  if (leafId && cwd) {
    /** @type {any} */ const watcher = getWorkspaceWatcher(cwd, { dataDir: resolveDataPath() });
    const entry = readWorkspaceWatcherTodoFindings(watcher?.findings, leafId);
    watcherFindingsText = String(entry.summary || '').trim();
  }
  let openLedgerFindings = [];
  if (leafId && cwd && isReviewFindingsBlockEnabled(resolveDelegationEnv(cwd))) {
    try {
      openLedgerFindings = listOpenReviewFindings(cwd, leafId);
    } catch {
      // The ledger is additive; prompts fall back to the prior-findings text.
    }
  }
  return { workflowRow, leafAcceptanceText, leafMaterialText, watcherFindingsText, leafTodo, openLedgerFindings };
}

/**
 * Lesson audience for a run: implementers get do/avoid lessons, audit code
 * reviewers get suppressions, plan reviewers get planner lessons.
 *
 * @param {{ assignment?: string, workRole?: string, reviewSubject?: string, reviewMode?: string }} run
 * @returns {'implementer' | 'reviewer' | 'planner' | ''}
 */
function resolveLessonAudience(run) {
  if (run.workRole === 'plan') return 'planner';
  if (run.assignment !== 'review') return 'implementer';
  if (run.reviewSubject === 'plan') return 'planner';
  if (run.reviewSubject === 'code' && run.reviewMode === 'audit') return 'reviewer';
  return '';
}

/**
 * Pick the active review lessons for this run and report which ids were shown.
 * A record that already resolved its lessons (retry / replay) keeps its ids so
 * the persisted exposure never drifts. Never throws: lessons are additive.
 *
 * @param {any} record
 * @param {{ cwd?: string, assignment?: string, model?: string, sourceText?: string, planMarkdown?: string, extraInstructions?: string, leafMaterialText?: string }} ctx
 * @returns {{ reviewLessons: { audience: string, lessons: Record<string, any>[] } | null, injectedLessonIds: string[], enabled: boolean }}
 */
export function resolveRunReviewLessons(record, ctx) {
  const audience = resolveLessonAudience({
    assignment: ctx.assignment,
    workRole: readRowWorkRole(record),
    reviewSubject: record.reviewSubject,
    reviewMode: record.reviewMode,
  });
  const none = { reviewLessons: null, injectedLessonIds: [], enabled: false };
  const folder = String(ctx.cwd || record.workspaceFolder || '').trim();
  // Resolved once: the prompt builder trusts this value instead of re-reading
  // the flag from its own (possibly different) execution folder.
  const enabled = Boolean(audience && folder && isReviewLessonsEnabled(resolveDelegationEnv(folder), audience));
  if (!enabled) return none;
  try {
    const all = listReviewLessons(folder);
    // Replay: rebuild in injection order (stable L1/L2 labels). A pinned lesson
    // retired since the first start is still shown so the run matches its record.
    const lessons = record.lessonsInjectedAt
      ? (record.injectedLessonIds || []).map((id) => all.find((lesson) => lesson.id === id)).filter(Boolean)
      : selectReviewLessons({
        lessons: all,
        audience: /** @type {'implementer' | 'reviewer' | 'planner'} */ (audience),
        leafText: [ctx.sourceText, ctx.planMarkdown, ctx.extraInstructions, ctx.leafMaterialText].filter(Boolean).join('\n'),
        executorModel: ctx.model,
      });
    return { reviewLessons: { audience, lessons }, injectedLessonIds: lessons.map((lesson) => lesson.id), enabled: true };
  } catch {
    return none;
  }
}

/**
 * True for a terminal, credible code review whose findings the ledger tracks.
 *
 * @param {any} delegation
 * @returns {boolean}
 */
function isLedgerTrackedCodeReview(delegation) {
  return String(delegation?.assignment || '').trim() === 'review'
    && String(delegation?.reviewSubject || '').trim() === 'code'
    && isCredibleCodeReviewTerminal(delegation)
    && isReviewFindingsBlockEnabled(resolveDelegationEnv(delegation?.workspaceFolder));
}

/**
 * Record the parsed findings of a finished code review in the server ledger.
 * Runs before the verdict/round hooks and never throws: the ledger is additive.
 *
 * @param {DelegationRow} delegation
 * @param {string} leafId
 * @param {Record<string, unknown> | null} patch workflow patch of this finish
 */
function recordFindingsLedgerAfterFinish(delegation, leafId, patch) {
  try {
    if (!leafId || !isLedgerTrackedCodeReview(delegation)) return;
    const parsed = parseReviewFindings(delegation.report);
    const workspaceFolder = String(delegation.workspaceFolder || '').trim();
    recordReviewFindings({
      workspaceFolder,
      leafId,
      delegationId: delegation.id,
      attemptId: delegation.attemptId,
      mode: delegation.reviewMode,
      createdAt: delegation.createdAt,
      findings: parsed.findings,
    });
    if (String(patch?.stopReason || '') === DELEGATION_WORKFLOW_STOP_CLOSURE_ROUNDS_EXHAUSTED) {
      markReviewFindingsStillOpenAtStop({ workspaceFolder, leafId });
    }
  } catch {
    // Observability must never break delegation finalization.
  }
}

/**
 * `reviewFindings` roll-up for a finishing code review (empty patch otherwise).
 *
 * @param {DelegationRow} current
 * @param {string} report
 * @returns {{ reviewFindings?: Record<string, any> }}
 */
function buildReviewFindingsSummaryPatch(current, report) {
  try {
    if (String(current?.assignment || '').trim() !== 'review'
      || String(current?.reviewSubject || '').trim() !== 'code'
      || !isReviewFindingsBlockEnabled(resolveDelegationEnv(current?.workspaceFolder))) {
      return {};
    }
    const summary = summarizeParsedReviewFindings(parseReviewFindings(report));
    return { reviewFindings: { ...summary, parsedAt: new Date().toISOString() } };
  } catch {
    return {};
  }
}

/**
 * @param {any} delegation
 */
export function syncCodeReviewWorkflowAfterFinish(delegation) {
  if (!delegation || typeof delegation !== 'object') return;
  const leafId = readDelegationWorkflowLeafIdFromRow(delegation);
  const parentChatId = delegationController(delegation);
  if (!parentChatId) return;
  const workflow = resolveDelegationWorkflowRow({ parentChatId, leafId });
  const patch = buildCodeReviewWorkflowPatchOnFinish(delegation, workflow);
  // Late pool siblings and replayed finishes produce a null patch but are still
  // recorded (the ledger de-duplicates per delegation attempt).
  recordFindingsLedgerAfterFinish(delegation, leafId, patch);
  // Evaluated before the early return: the feature flag off or a phase-less
  // review produces no patch but still ends a single-reviewer round.
  try {
    const round = evaluateReviewRoundOnFinish({
      delegation,
      workflow,
      patch,
      delegations: /** @type {DelegationRow[]} */ (listDelegationsForController(parentChatId)),
    });
    if (round) {
      const workspaceFolder = String(delegation.workspaceFolder || '').trim();
      installLessonDistillation();
      installLessonFeedback();
      const announced = onReviewRoundResolved({ leafId, parentChatId, workspaceFolder }, round);
      if (announced && round.verdict === 'PASS' && isReviewFindingsBlockEnabled(resolveDelegationEnv(workspaceFolder))) {
        closeReviewFindingsCycle({ workspaceFolder, leafId, roundId: round.id, memberIds: round.memberIds });
      }
    }
  } catch {
    // Observability must never break delegation finalization.
  }
  if (!patch) return;
  applyDelegationWorkflowPatch({
    ...patch,
    parentChatId,
    idempotencyKey: resolveCodeReviewPhaseWorkflowIdempotencyKey(delegation, workflow),
    countReview: false,
  });
}

/**
 * Resolve the logical todo a delegation belongs to and the revision an
 * acceptance screen must have displayed (`docs/todo-review-contract.md` §7.3).
 *
 * The leaf binding on a job can be a compact id prefix (`cretli-ref todo=` and
 * the MCP tools accept prefixes), while the todo store is keyed by the full id.
 * Resolving here — exact id first, then a prefix that matches exactly one item —
 * keeps the compare-and-set from failing open on a prefix that silently matched
 * nothing. `resolution` names the outcome so the caller never has to guess
 * between "this job has no todo", "the todo is gone" and "the prefix is
 * ambiguous".
 *
 * @param {any} row
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<{
 *   leafId: string, todoId: string, revision: string,
 *   resolution: 'unattributed'|'exact'|'prefix'|'ambiguous'|'missing'|'unavailable',
 * }>}
 */
export async function resolveDelegationAcceptTodo(row, options = {}) {
  const leafId = readDelegationWorkflowLeafIdFromRow(row);
  const cwd = String(row?.workspaceFolder || '').trim();
  if (!leafId || !cwd) {
    return { leafId, todoId: '', revision: '', resolution: 'unattributed' };
  }
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  /** @type {any[]} */
  let items = [];
  try {
    items = (await listTodos(dataDir, cwd)).items;
  } catch {
    // A failed read is not "the todo is gone": acceptance must not pass on it.
    return { leafId, todoId: '', revision: '', resolution: 'unavailable' };
  }
  /** @type {any} */ const exact = items.find((/** @type {any} */ item) => String(item?.id || '').trim().toLowerCase() === leafId);
  if (exact) {
    return {
      leafId,
      todoId: String(exact.id || '').trim(),
      revision: String(exact.updatedAt || '').trim(),
      resolution: 'exact',
    };
  }
  const prefixed = items.filter((/** @type {any} */ item) => String(item?.id || '').trim().toLowerCase().startsWith(leafId));
  if (prefixed.length === 1) {
    return {
      leafId,
      todoId: String(prefixed[0].id || '').trim(),
      revision: String(prefixed[0].updatedAt || '').trim(),
      resolution: 'prefix',
    };
  }
  if (prefixed.length > 1) return { leafId, todoId: '', revision: '', resolution: 'ambiguous' };
  return { leafId, todoId: '', revision: '', resolution: 'missing' };
}

/**
 * Whether `chatId` may steer this delegation: either its controller (the chat that started it
 * unless control was moved) or the current orchestrator of the todo (or one of its
 * ancestors) the job is bound to. The second case lets a fresh orchestrator finish a loop when the
 * original parent chat is no longer available; `parentChatId` stays historical.
 *
 * @param {any} row
 * @param {string} chatId
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function canChatSteerDelegation(row, chatId, options = {}) {
  const caller = String(chatId || '').trim();
  if (!row || !caller) return false;
  if (canChatControlDelegation(row, caller)) return true;
  const leafId = readDelegationWorkflowLeafIdFromRow(row);
  const cwd = String(row.workspaceFolder || '').trim();
  if (!leafId || !cwd) return false;
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  /** @type {any[]} */
  let items = [];
  try {
    items = (await listTodos(dataDir, cwd)).items;
  } catch {
    return false;
  }
  const exact = items.find((/** @type {any} */ item) => String(item?.id || '').trim().toLowerCase() === leafId);
  const prefixed = exact ? [] : items.filter((/** @type {any} */ item) => String(item?.id || '').trim().toLowerCase().startsWith(leafId));
  const leaf = exact || (prefixed.length === 1 ? prefixed[0] : null);
  if (!leaf) return false;
  const byId = new Map(items.map((/** @type {any} */ item) => [String(item?.id || ''), item]));
  const seen = new Set();
  for (let node = leaf; node && !seen.has(String(node.id || '')); node = byId.get(String(node.parentId || '').trim())) {
    seen.add(String(node.id || ''));
    if (String(node.orchestratorChatId || '').trim() === caller) return true;
  }
  return false;
}

/**
 * Read an optional client expectation. `undefined` means the client omitted it;
 * an empty string means it explicitly captured "nothing" (§6.3).
 *
 * @param {...unknown} candidates first non-nullish candidate wins
 * @returns {string | undefined}
 */
function readOptionalExpectation(...candidates) {
  for (const value of candidates) {
    if (value !== undefined && value !== null) return String(value).trim();
  }
  return undefined;
}

/**
 * Current todo revision the acceptance card must display and echo back (§7.3).
 * An empty string means there is nothing to compare (unattributed job), never
 * "the todo is up to date".
 *
 * @param {any} row
 * @param {{ dataDir?: string }} [options]
 * @returns {Promise<{ todoId: string, todoRevision: string, resolution: string }>}
 */
export async function readDelegationAcceptContext(row, options = {}) {
  const target = await resolveDelegationAcceptTodo(row, options);
  return {
    todoId: target.todoId,
    todoRevision: target.resolution === 'exact' || target.resolution === 'prefix'
      ? target.revision
      : '',
    resolution: target.resolution,
  };
}

/**
 * Best-effort read of the active lockout/quota store. A broken store must not
 * refuse a start; it degrades to an empty list, matching the availability probe.
 *
 * @returns {any[]}
 */
function safeListHarnessUsageLimits(workspaceFolder) {
  try {
    if (String(workspaceFolder || '').trim()) {
      return listHarnessUsageLimitsForWorkspace({ workspaceFolder });
    }
    return listHarnessUsageLimits();
  } catch {
    return [];
  }
}
import { isDelegationRuntimeAcceptingWork, getDelegationLifecycleState } from './delegation-lifecycle.js';
import {
  canTransitionDelegationStatus,
  DELEGATION_INTERRUPT_RUNNING_ORPHAN,
  DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED,
  DELEGATION_INTERRUPT_SERVER_RESTART,
  DELEGATION_INTERRUPT_STARTING_TIMEOUT,
  DELEGATION_OUTBOX_BACKOFF_MAX_MS,
  DELEGATION_OUTBOX_BACKOFF_MS,
  DELEGATION_RUNNING_ORPHAN_GRACE_MS,
  DELEGATION_SLOT_REASONS,
  DELEGATION_STARTING_TIMEOUT_MS,
  isActiveDelegationStatus,
  isDelegationSlotOccupied,
  isStaleTerminalRunStopping,
  isTerminalDelegationStatus,
  normalizeDelegationInterruptCode,
  normalizeDelegationTaskOutcome,
  setDelegationStatusEnvResolver,
} from './delegation-status.js';
import { findMailboxFinalReplyForAttempt } from './persist/delegation-mailbox-persist.js';
import {
  DELEGATION_VERDICTS,
  assessDelegationReport,
  resolveDelegationFinishReport,
  resolveDelegationRecordVerdict,
} from './delegation-verdict.js';
import {
  describeUnavailableDelegationModel,
  isDelegationModelAvailable,
  resolveDelegationModelDetailed,
  describeEffortUnavailable,
} from './delegation-executor.js';
import { appendRelatedChatHistoryLinks } from './chat-relation-history.js';
import { normalizeAgentTransport } from './agent-transport.js';
import { resolveSdkCwdForChat } from './workspace.js';
import { resolveExecutionFolderForChat } from './execution-folder.js';
import { isAskSdkMode } from './sdk/sdk-mode.ts';
// The leaf module, not `sdk-plan-guard.ts`: that one imports the MCP policy,
// which imports the builtin tool catalog, which imports the delegation tools
// and would close an import cycle back into this file.
import { ASK_GUARD_USER_MESSAGE } from './sdk/sdk-guard-messages.ts';
import { decodeModelValue } from './model-catalog.js';
import { delegationPersistedRole, rowExecutor } from './model-pick-history.js';
import {
  applyPlanWindowReservations,
  flushPlanWindowReservations,
  queuePlanWindowReservation,
  recordPlanWindowReservation,
} from './plan-window-reservations.js';
import { buildPlanHeadroomSnapshot, buildPlanPaceSnapshot } from './model-pick-plan-window.js';
import { estimateModelCostTier } from './model-catalog-meta.js';
import { normalizeComplexity } from './model-pick-complexity.js';
import { readHarnessPlanLimits } from './usage/harness-health.ts';
import { buildVerifyManifest, computeVerifyEnvKey, decideVerifyReuse, evaluateVerifyManifestEvidence, rebindVerifyEvidence, resolveDelegationReviewVerifyPlan, selectVerifyIdsForChange } from './delegation-review-verify-plan.js';
import {
  evaluateNoVerdictReviewFallback,
  finalizeDelegationPickSlotReservation,
  getModelPickRecord,
  releaseModelPickSlotsForDelegation,
  resolveDelegationPickLinkFields,
  resolveDelegationPickRole,
} from './model-pick-decisions.js';
import {
  DELEGATION_START_CONTEXTS,
  consumeDelegationUiAction,
  hashDelegationUiActionTask,
  inspectDelegationUiAction,
  resolveDelegationStartContext,
  validateDelegationContinuation,
} from './delegation-start-context.js';
import { classifyDelegationFailure } from './delegation-failure-class.js';
import {
  finishModelPickExploreAttemptForDelegation,
  loadModelPickExploreConfig,
  MODEL_PICK_EXPLORE_ORIGIN_DETAIL,
  releaseModelPickExploreAttemptForDelegation,
  reserveModelPickExploreBudget,
  startModelPickExploreAttemptForDelegation,
} from './model-pick-explore.js';
import {
  DELEGATION_RATING_RATERS,
  delegationRatingCardSnapshot,
  fingerprintDelegationRating,
  normalizeDelegationRatingPayload,
  normalizeDelegationRatingRater,
} from './delegation-ratings.js';
import {
  appendDelegationRating,
  findDelegationRating,
} from './persist/delegation-ratings-persist.js';
import { canAcceptNewRun } from './update-gate.js';
import {
  evaluateDelegationDepthGate,
  normalizeAllowChildDelegations,
  remainingDelegationDepth,
  resolveChildDelegationGrant,
  resolveDelegationMaxDepth,
  resolveRecordTreeFields,
} from './delegation-tree.js';

/**
 * Plan-window headroom snapshot for the executor pair (D9). Stored on its own
 * field so it shows on the card even when the user supplied a `pick_reason`.
 * Best-effort: any failure yields `null` and never blocks a start.
 *
 * @param {string} harness
 * @param {string} model
 * @param {string} workspaceFolder
 * @param {string} [dataDir] store root; default data/ when omitted
 * @returns {any}
 */
export function planHeadroomSnapshotFor(harness, model, workspaceFolder, dataDir = undefined) {
  try {
    const config = resolvePlanWindowSettings(workspaceFolder);
    if (!config.enabled || !harness) return null;
    const planLimits = applyPlanWindowReservations(readHarnessPlanLimits('', { dataDir }), { dataDir });
    return buildPlanHeadroomSnapshot({ planLimits, harnessId: harness, modelId: model, now: Date.now(), config });
  } catch {
    return null;
  }
}

/**
 * Weekly pace snapshot for the executor pair (D9), stored next to the headroom
 * one. Cost tier is resolved from the model id with the same heuristic the
 * catalog uses for `cost_tier` (`estimateModelCostTier`), so the stored factor
 * matches the picker's. Best-effort: any failure yields `null` and never blocks
 * a start.
 *
 * @param {string} harness
 * @param {string} model
 * @param {string} workspaceFolder
 * @param {string} [dataDir] store root; default data/ when omitted
 * @returns {any}
 */
export function planPaceSnapshotFor(harness, model, workspaceFolder, dataDir = undefined) {
  try {
    const config = resolvePlanWindowSettings(workspaceFolder);
    if (!config.enabled || !harness) return null;
    const planLimits = applyPlanWindowReservations(readHarnessPlanLimits('', { dataDir }), { dataDir });
    const decoded = decodeModelValue(model);
    const costTier = estimateModelCostTier(decoded.modelId, decoded.params);
    return buildPlanPaceSnapshot({ planLimits, harnessId: harness, modelId: model, now: Date.now(), config, costTier });
  } catch {
    return null;
  }
}

/**
 * Local usage correction (D7): reserve the estimated plan-window consumption of
 * a delegation that REALLY started (running transition or an actual retry).
 * Idempotent per delegation id + attempt id. Fire-and-forget: the work is
 * deferred to the next macrotask (the store has a short lock timeout) and
 * never throws into, or delays, the start path.
 *
 * A skipped write (held store lock) is retried a few times; when every local
 * retry loses the race the payload waits in a bounded in-memory queue that the
 * next start drains first, so the correction is delayed, not dropped.
 *
 * @param {DelegationRow} record delegation row of the accepted attempt
 * @param {{ dataDir?: string }} [deps]
 * @returns {void}
 */
function reservePlanWindowUsage(record, deps = {}) {
  try {
    const { harness, model } = rowExecutor(record);
    if (!harness || !record?.id) return;
    const role = delegationPersistedRole(record);
    const idempotencyKey = `${record.id}:${record.attemptId || ''}`;
    const dataDir = deps.dataDir;
    setImmediate(() => {
      // Drain reservations skipped by earlier starts before writing this one.
      try {
        flushPlanWindowReservations(dataDir === undefined ? {} : { dataDir });
      } catch {
        // A failed flush must never affect the start path.
      }
      let planLimits;
      try {
        planLimits = readHarnessPlanLimits(harness, { dataDir });
      } catch {
        planLimits = [];
      }
      const payload = { harness, model, role, idempotencyKey, planLimits, dataDir };
      const attempt = (retriesLeft) => {
        try {
          const result = recordPlanWindowReservation(payload);
          // The store never waits on a held lock; a skipped write is retried
          // later (idempotent per key) without blocking the event loop.
          if (result?.skipped === 'lock-timeout') {
            if (retriesLeft > 0) {
              const timer = setTimeout(() => attempt(retriesLeft - 1), 50);
              timer.unref?.();
              return;
            }
            // Out of local retries: keep it for the next start to flush.
            queuePlanWindowReservation(payload);
          }
        } catch {
          // A failed estimate must never fail a delegation start.
        }
      };
      attempt(5);
    });
  } catch {
    // A failed estimate must never fail a delegation start.
  }
}

/** @type {Map<string, Promise<unknown>>} */
const parentLocks = new Map();

/** @type {Map<string, Record<string, any>>} */
const pendingStartAdmissions = new Map();

/** @type {Map<string, { attemptId: string, childChatId: string }>} */
const inFlightStarts = new Map();

/** @type {Map<string, Promise<Record<string, any>>>} */
const retryJobInFlight = new Map();

/** @type {null | ((phase: string, record: Record<string, any>) => void)} */
let crashHook = null;

/**
 * Refusal returned when the shared update/install slot is active. Admission
 * checks call `canAcceptNewRun()` so no new child run starts while files are
 * being replaced by a self-update.
 *
 * @returns {{ ok: false, status: number, error: string, code: string }}
 */
function updateOperationConflict() {
  return {
    ok: false,
    status: 409,
    error: 'An update or install is in progress. New runs are not accepted until it finishes.',
    code: 'update_in_progress',
  };
}

/**
 * Count of delegations still occupying the runtime (queued/starting/running/
 * waiting_for_input/cancelling). The shared update gate reads this so a
 * self-update cannot replace files under a live run.
 *
 * @returns {number}
 */
export function countActiveDelegationRuns() {
  return /** @type {DelegationRow[]} */ (loadDelegationsReadonly()).filter((row) => isActiveDelegationStatus(row.status)).length;
}

/**
 * Shutdown flush: the first shutdown phase SIGTERMs every harness child, so an
 * active delegation's executor run is gone by the time this runs. Record that
 * durably — `interrupted` / `server_restart` (retryable exactly once) — instead
 * of letting the 60 s orphan watchdog mislabel the same rows `running_orphan`
 * (stop-only) on the next boot. Rows with a durable end proof for the current
 * attempt are already finished work and stay untouched; `cancelling` rows are
 * left for the user's stop to conclude. The parent mailbox reply is enqueued
 * per row, so the parent learns the outcome without a parent run.
 *
 * Must run inside `enqueueDelegationStoreWork` (the shutdown flush holds it).
 * Idempotent: a row another path already finished terminal is left as-is.
 *
 * @returns {{ interrupted: string[], untouched: string[] }}
 */
export function interruptActiveDelegationsForServerRestart() {
  const interrupted = [];
  const untouched = [];
  for (const row of /** @type {DelegationRow[]} */ (loadDelegations())) {
    if (!isActiveDelegationStatus(row.status) || row.status === 'cancelling') {
      continue;
    }
    if (hasDurableAttemptEndProof(row)) {
      untouched.push(row.id);
      continue;
    }
    const finished = finishDelegation(row, {
      status: 'interrupted',
      interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
      error: SERVER_RESTART_ERROR,
      enqueueParentReply: true,
    });
    if (finished && String(finished.status || '') === 'interrupted') {
      interrupted.push(row.id);
      releaseDelegationRunSlot(finished);
    } else {
      untouched.push(row.id);
    }
  }
  return { interrupted, untouched };
}

/**
 * Interrupt messages. Only `server_restart` is retryable (once); the other
 * codes must not invite another run of the same record.
 */
const SERVER_RESTART_ERROR = 'Server restarted before this run could be confirmed. This is not success. Retry this record once to continue.';
const STARTING_TIMEOUT_ERROR = 'Timed out while starting. The run was not confirmed. This is not success. Do not retry this record; start a new delegation.';
const RUNNING_ORPHAN_ERROR = 'The executor run was lost after the grace period. This is not success. Do not retry this record; start a new delegation.';

/**
 * True while create/retry is awaiting adapter accept. Idle getState is not "no run".
 *
 * @param {unknown} delegationId
 * @returns {boolean}
 */
export function hasInFlightDelegationStart(delegationId) {
  return inFlightStarts.has(String(delegationId || '').trim());
}

/**
 * @param {unknown} delegationId
 * @param {{ attemptId?: string, childChatId?: string }} meta
 */
function rememberInFlightStart(delegationId, meta = {}) {
  const id = String(delegationId || '').trim();
  if (!id) return;
  inFlightStarts.set(id, {
    attemptId: String(meta.attemptId || '').trim(),
    childChatId: String(meta.childChatId || '').trim(),
  });
}

/**
 * @param {unknown} delegationId
 */
function forgetInFlightStart(delegationId) {
  inFlightStarts.delete(String(delegationId || '').trim());
}

/**
 * Test hook: throw or delay a lifecycle phase (crash injection / slow adapter).
 *
 * @param {null | ((phase: string, record: Record<string, any>) => (void | Promise<void>))} fn
 */
export function setDelegationCrashHook(fn) {
  crashHook = typeof fn === 'function' ? fn : null;
}

/**
 * @param {string} phase
 * @param {any} [record]
 * @returns {void | Promise<void>}
 */
export function runDelegationCrashHook(phase, record = {}) {
  if (!crashHook) return undefined;
  return crashHook(String(phase || ''), record);
}

/**
 * Mark a start/retry result that ran review without a hard write guarantee
 * (`CRETLI_DELEGATION_REVIEW_ALLOW_UNCERTIFIED=1`).
 *
 * @param {any} result
 * @param {unknown} reviewUncertified
 * @returns {any}
 */
function tagReviewUncertified(result, reviewUncertified) {
  if (reviewUncertified !== true || !result || typeof result !== 'object') return result;
  return { ...result, reviewUncertified: true };
}

/**
 * @param {any} warning
 * @param {any} result
 * @returns {any}
 */
function attachDelegationStartWarning(result, warning) {
  if (!warning || !result || typeof result !== 'object') return result;
  return { ...result, warning };
}

/**
 * Early satisfiability check of a complete fixed pair at review start; also
 * writes the operator journal alert once per leaf + round (and the clearing
 * event when a previously flagged leaf is satisfiable again). Best effort.
 *
 * @param {{ cwd: string, dataDir: string, controllerChatId: string, workflow: Record<string, any> | null, leafId: string, delegations: Record<string, any>[], members: Array<{ harness: string, model: string }>, reviewer: { transport: unknown, model: unknown } }} input
 * @returns {ReturnType<typeof evaluateReviewerPairStartGate> | null}
 */
export function evaluatePairGateAtStart(input) {
  try {
    const workflow = input.workflow;
    // Hard excludes: the leaf's last implementer/fixer and the orchestrator.
    const implementers = input.delegations
      .filter((row) => ['implement', 'fix'].includes(String(row?.assignment || '').toLowerCase())
        && readDelegationWorkflowLeafIdFromRow(row) === input.leafId)
      .sort((a, b) => String(a?.createdAt || '').localeCompare(String(b?.createdAt || '')));
    const lastImpl = implementers[implementers.length - 1];
    const hardExcluded = [];
    if (lastImpl?.executor?.model) hardExcluded.push({ harness: lastImpl.executor.transport, model: lastImpl.executor.model });
    const controllerModel = readControllerChatModel(input.controllerChatId);
    if (controllerModel) hardExcluded.push({ model: controllerModel });
    const gate = evaluateReviewerPairStartGate({
      workflow,
      members: input.members,
      hardExcluded,
      isStartable: isReviewerMemberStartable,
      candidatesFor: () => listReviewCandidates({ excludeModels: hardExcluded.map((row) => row.model) }),
      reviewer: input.reviewer,
    });
    const options = { dataDir: input.dataDir };
    const latest = readLatestOperatorEventsByLeaf(input.cwd, ['reviewer_pair_unsatisfiable', 'reviewer_pair_satisfiable'], options).get(input.leafId);
    const roundMarker = `round ${gate.roundKey},`;
    if (gate.satisfiable) {
      if (latest?.kind === 'reviewer_pair_unsatisfiable') {
        recordOperatorEvent(input.cwd, 'reviewer_pair_satisfiable', `Reviewer pair satisfiable again: leaf ${input.leafId}, round ${gate.roundKey}, missing none`, options);
      }
    } else if (!(latest?.kind === 'reviewer_pair_unsatisfiable' && latest.summary.includes(roundMarker))) {
      recordOperatorEvent(input.cwd, 'reviewer_pair_unsatisfiable', `Reviewer pair unsatisfiable: leaf ${input.leafId}, round ${gate.roundKey}, missing ${gate.missing}`, options);
    }
    return gate;
  } catch {
    // The check is advisory; a failure here never blocks a review start.
    return null;
  }
}

/**
 * A fixed-pair review needs two distinct reviewer identities. Warn when this
 * start repeats a reviewer already used on the leaf while another pair member
 * has not reviewed it yet (e.g. a Claude alias of the same base model), since
 * the round would stay `pair_reviewer_pending`.
 *
 * @param {{ delegations: Record<string, any>[], leafId: string, subject: string, harness: string, model: string, members: Array<{ harness: string, model: string }> }} input
 * @returns {any}
 */
export function readPairDuplicateReviewerWarning({ delegations, leafId, subject, harness, model, members }) {
  if (!leafId || !Array.isArray(members) || members.length < 2) return null;
  const reviews = delegations.filter((/** @type {any} */ row) => String(row?.assignment || '').toLowerCase() === 'review'
    && String(row?.reviewSubject || '').toLowerCase() === String(subject || '').toLowerCase()
    && readDelegationWorkflowLeafIdFromRow(row) === leafId);
  const reviewed = (member) => reviews.some((/** @type {any} */ row) => isSameReviewer(
    { harness: row?.executor?.transport, model: row?.executor?.model },
    member,
  ));
  if (!reviewed({ harness, model })) return null;
  const missing = members.filter((member) => !isSameReviewer(member, { harness, model }) && !reviewed(member));
  if (missing.length === 0) return null;
  const names = missing.map((member) => `${member.harness}/${member.model}`).join(', ');
  return {
    code: 'pair_duplicate_reviewer',
    harness: String(harness || '').trim().toLowerCase(),
    model: String(model || '').trim(),
    missing_members: missing,
    message: `This reviewer already reviewed the leaf; the fixed pair still needs: ${names}. A repeat (or alias of the same base model) does not count as the second reviewer.`,
  };
}

/**
 * @param {...(Record<string, any> | null | undefined)} warnings
 * @returns {any}
 */
function mergeStartWarnings(...warnings) {
  const present = warnings.filter(Boolean);
  if (present.length <= 1) return present[0] || null;
  return { ...present[0], also: present.slice(1) };
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {any[]} lockouts
 * @returns {any}
 */
function readActiveStartupFailureLockoutWarning(harness, model, lockouts) {
  /** @type {any} */ const row = findActiveLockoutRow(lockouts, String(harness || '').trim().toLowerCase(), model, Date.now());
  if (!row || String(row?.code || '') !== 'startup_failure') return null;
  return {
    code: 'startup_failure_lockout',
    reason: 'startup_failure',
    harness: String(harness || '').trim().toLowerCase(),
    model: String(model || '').trim(),
    reset_at: row.resetAt,
    message: `This harness/model pair is cooling down after a recent startup failure until ${row.resetAt}.`,
  };
}

/**
 * Only an `interrupted` job with a durable `server_restart` code may be
 * continued, and at most once per record. Other interrupt codes and legacy
 * rows without a code are stop-only.
 *
 * @param {DelegationRow} row
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string, delegation: Record<string, any> }}
 */
function inspectInterruptedRetryGate(row) {
  if (String(row?.status || '') !== 'interrupted') return { ok: true };
  const code = normalizeDelegationInterruptCode(row?.interruptCode);
  if (code !== DELEGATION_INTERRUPT_SERVER_RESTART) {
    return {
      ok: false,
      status: 409,
      code: 'interrupted_no_retry',
      error: 'This interrupted job was not caused by a server restart. Do not retry this record; review the report or start a new delegation.',
      delegation: row,
    };
  }
  if (String(row?.interruptContinuedAt || '').trim()) {
    return {
      ok: false,
      status: 409,
      code: 'interrupted_retry_exhausted',
      error: 'This interrupted job already used its single server-restart continuation. Do not retry this record again.',
      delegation: row,
    };
  }
  return { ok: true };
}

/**
 * Chat that currently controls the row. Scope gate: a deleted historical
 * parent never hides the controller, and a deleted controller falls back to the
 * historical parent record.
 *
 * @param {any} row
 * @returns {any}
 */
function findControllerChat(row) {
  const chats = /** @type {ChatRowAny[]} */ (loadChats());
  for (const chatId of delegationScopeChatIds(row)) {
    const chat = chats.find((item) => item.id === chatId);
    if (chat) return chat;
  }
  return undefined;
}

/**
 * @param {string} parentChatId
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 * @template T
 */
async function withParentLock(parentChatId, task, timeoutMs = 0) {
  const key = String(parentChatId || '').trim();
  const previous = parentLocks.get(key) || Promise.resolve();
  /** @type {(value?: unknown) => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  parentLocks.set(key, chain);
  let timer;
  try {
    await Promise.race([
      previous.catch(() => {}),
      ...(timeoutMs > 0 ? [new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Takeover lock acquisition timed out.');
          /** @type {any} */ (error).code = 'takeover_busy';
          /** @type {any} */ (error).status = 409;
          reject(error);
        }, timeoutMs);
      })] : []),
    ]);
    clearTimeout(timer);
    return await task();
  } finally {
    clearTimeout(timer);
    release();
    chain.then(() => {
      if (parentLocks.get(key) === chain) parentLocks.delete(key);
    });
  }
}

/**
 * @param {DelegationRow} delegation
 * @param {string} status
 * @param {Record<string, unknown>} [patch]
 * @param {{ expectedRevision?: number, expectedAttemptId?: string, allowStartupRetry?: boolean }} [options]
 */
function transition(delegation, status, patch = {}, options = {}) {
  const current = /** @type {DelegationRow} */ (getDelegationById(delegation?.id)) || delegation;
  if (!current?.id) return null;
  const expectedAttempt = String(options.expectedAttemptId || '').trim();
  if (expectedAttempt && String(current.attemptId || '') !== expectedAttempt) {
    return current;
  }
  // The automatic startup retry regresses an active attempt back to `starting`
  // to hold its slot between attempts. This is deliberately opt-in: the general
  // status table still rejects `running|waiting_for_input -> starting`.
  const startupRetryRegress = options.allowStartupRetry === true
    && status === 'starting'
    && (current.status === 'running' || current.status === 'starting');
  if (!canTransitionDelegationStatus(current.status, status) && current.status !== status && !startupRetryRegress) {
    return current;
  }
  const next = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, { status, ...patch }, {
    expectedRevision: options.expectedRevision,
    expectedAttemptId: options.expectedAttemptId,
  }));
  return next || /** @type {DelegationRow} */ (getDelegationById(current.id)) || current;
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
function parseDelegationHistoryPayload(payload) {
  if (payload && typeof payload === 'object') return /** @type {Record<string, unknown>} */ (payload);
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} parentChatId
 * @param {{ id: string, event?: string, attemptId?: string, eventId?: string }} query
 * @returns {Promise<boolean>}
 */
async function hasDelegationHistoryEvent(parentChatId, query) {
  const store = await loadChatHistory(parentChatId);
  const events = store?.events || [];
  const wantedEventId = String(query.eventId || '');
  const wantedAttempt = String(query.attemptId || '');
  return events.some((row) => {
    if (row.rec?.variant !== 'delegation') return false;
    const data = parseDelegationHistoryPayload(row.rec.payload);
    if (!data) return false;
    if (String(data.id || '') !== query.id) return false;
    if (String(data.event || '') !== String(query.event || '')) return false;
    const storedAttempt = String(data.attemptId || '');
    if (storedAttempt !== wantedAttempt) return false;
    // Acknowledgement shares the terminal status revision, but is a distinct
    // history event. Deduplicate delivery, not all events of that revision.
    return !wantedEventId || String(data.eventId || '') === wantedEventId;
  });
}

/**
 * Append a parent-history card after the disk write succeeds. Terminal
 * `finished` events set historyDeliveredAt only after a successful append
 * of the current attempt.
 *
 * @param {any} delegation
 * @param {string} event
 * @param {Record<string, unknown> | null} [snapshot]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function publishDelegationStatus(delegation, event, snapshot = null) {
  await pendingTodoReviewSyncs.get(String(delegation?.id || ''));
  const current = /** @type {DelegationRow} */ (getDelegationById(delegation?.id)) || delegation;
  const controllerChatId = delegationController(current);
  if (!current?.id || !controllerChatId) return current || null;
  // One publish at a time per controller chat: the duplicate check and the append are separated by awaits now,
  // so two concurrent publishes of the same event must not both pass the check.
  const previous = historyPublishChains.get(controllerChatId) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => publishDelegationStatusExclusive(delegation, event, snapshot));
  historyPublishChains.set(controllerChatId, run);
  try {
    return await run;
  } finally {
    if (historyPublishChains.get(controllerChatId) === run) historyPublishChains.delete(controllerChatId);
  }
}

/** @type {Map<string, Promise<unknown>>} */
const historyPublishChains = new Map();

/**
 * @param {DelegationRow} delegation
 * @param {string} event
 * @param {Record<string, unknown> | null} snapshot
 * @returns {Promise<Record<string, any> | null>}
 */
async function publishDelegationStatusExclusive(delegation, event, snapshot) {
  const current = /** @type {DelegationRow} */ (getDelegationById(delegation?.id)) || delegation;
  const controllerChatId = delegationController(current);
  if (!current?.id || !controllerChatId) return current || null;
  const eventName = String(event || '').trim();
  if (!eventName) return current;
  const view = snapshot && typeof snapshot === 'object'
    ? { ...current, ...snapshot }
    : current;
  const attemptId = String(view.attemptId || '');
  const eventId = String(view.eventId || current.eventId || '');
  const already = await hasDelegationHistoryEvent(controllerChatId, {
    id: current.id,
    event: eventName,
    attemptId,
    eventId,
  });
  const snapshotIsCurrentAttempt = !attemptId || attemptId === String(current.attemptId || '');
  if (already) {
    if (eventName === 'finished' && snapshotIsCurrentAttempt && !String(current.historyDeliveredAt || '').trim()) {
      return /** @type {DelegationRow} */ (updateDelegationRecord(current.id, { historyDeliveredAt: new Date().toISOString() }));
    }
    return current;
  }
  const executor = view.executor && typeof view.executor === 'object' ? view.executor : {};
  // Position of the first card for this job; later status cards reuse it so a
  // tail-windowed view keeps the card where the job started.
  let anchorSeq = 0;
  for (const row of (await loadChatHistory(controllerChatId))?.events || []) {
    if (row.rec?.variant !== 'delegation') continue;
    const prior = parseDelegationHistoryPayload(row.rec.payload);
    if (String(prior?.id || '') !== String(current.id)) continue;
    anchorSeq = Number(prior?.anchorSeq) || Number(row.seq) || 0;
    if (anchorSeq > 0) break;
  }
  const payload = JSON.stringify({
    id: current.id,
    anchorSeq,
    status: view.status,
    childChatId: view.childChatId || current.childChatId,
    executor: view.executor || current.executor,
    report: view.report || '',
    error: view.error || '',
    unverified: view.unverified !== false,
    acknowledgedAt: view.acknowledgedAt || '',
    acknowledgedAttemptId: view.acknowledgedAttemptId || '',
    acknowledgedActor: view.acknowledgedActor || '',
    acknowledgedReason: view.acknowledgedReason || '',
    // Persisted rating (user, else the orchestrator's) for the card (metadata only, never the report).
    // Read fresh on every publish so a later event keeps the rated state.
    userRating: delegationRatingCardSnapshot(
      findDelegationRating(current.id, 'user') || findDelegationRating(current.id, 'parent'),
    ),
    attemptId,
    attemptNumber: countDelegationAttempts(view.attempts ? view : current),
    event: eventName,
    eventId,
    sourceKind: view.sourceKind || current.sourceKind || '',
    assignment: view.assignment || current.assignment || '',
    pickReason: String(view.pickReason || current.pickReason || '').trim(),
    planHeadroomSnapshot: view.planHeadroomSnapshot || current.planHeadroomSnapshot || null,
    planPaceSnapshot: view.planPaceSnapshot || current.planPaceSnapshot || null,
    allowChildDelegations: (view.allowChildDelegations ?? current.allowChildDelegations) === true,
    interruptCode: normalizeDelegationInterruptCode(view.interruptCode || current.interruptCode),
    model: executor.model || '',
    startedAt: view.startedAt || '',
    finishedAt: view.finishedAt || '',
    historyDeliveredAt: view.historyDeliveredAt || '',
    reportDeliveredAt: view.reportDeliveredAt || '',
    attempts: Array.isArray(view.attempts) ? view.attempts : (Array.isArray(current.attempts) ? current.attempts : []),
  });
  const result = await appendChatHistoryEvents(controllerChatId, '', [
    { rec: { kind: 'meta', variant: 'delegation', payload } },
  ]);
  if (!result?.ok) return current;
  markChatHasPendingDelegation(controllerChatId);
  broadcastChatHistoryUpdate(controllerChatId, result.appended, result.identity);
  const patch = {};
  if (snapshotIsCurrentAttempt) {
    patch.lastPublishedStatus = view.status;
    patch.lastPublishedEvent = eventName;
    patch.lastPublishedEventId = eventId;
    if (eventName === 'finished') {
      patch.historyDeliveredAt = new Date().toISOString();
    }
  }
  if (Object.keys(patch).length === 0) return current;
  return /** @type {DelegationRow} */ (updateDelegationRecord(current.id, patch)) || current;
}

/** Background history publishes / outbox flushes that were scheduled by synchronous call sites and have not settled yet. */
const scheduledHistoryTasks = new Set();

/**
 * @param {Promise<unknown>} task
 * @param {string} event
 * @param {DelegationRow} delegation
 */
function trackScheduledHistoryTask(task, event, delegation) {
  const tracked = task.catch((err) => {
    logDelegationEvent('history-publish-failed', delegation, { event, code: String(err?.code || ''), error: String(err?.message || err).slice(0, 200) });
  }).finally(() => scheduledHistoryTasks.delete(tracked));
  scheduledHistoryTasks.add(tracked);
}

/**
 * Wait until every history publish / outbox flush scheduled by a synchronous call site has settled (including the
 * ones scheduled while waiting). Used by the shutdown path before the history backend closes, and by tests that
 * assert on the stored cards right after a synchronous state transition.
 *
 * @returns {Promise<void>}
 */
export async function settleDelegationHistoryTasks() {
  while (scheduledHistoryTasks.size > 0 || pendingTodoReviewSyncs.size > 0) {
    await Promise.all([...scheduledHistoryTasks, ...pendingTodoReviewSyncs.values()]);
  }
}

/**
 * Background history publish for call sites that must stay synchronous. A failure is logged and the card is
 * retried by the next publish/outbox pass (cards are deduplicated by delegation id, event, attempt and event id).
 *
 * @param {any} delegation
 * @param {string} event
 * @param {Record<string, unknown> | null} [snapshot]
 */
export function scheduleDelegationHistoryPublish(delegation, event, snapshot = null) {
  trackScheduledHistoryTask(publishDelegationStatus(delegation, event, snapshot), event, delegation);
}

/**
 * Publish the terminal `finished` card in the background and mark its outbox item delivered once the card is stored.
 * A failure leaves the outbox item pending: `flushDelegationOutbox` (bridge, runtime worker, boot) delivers it later.
 *
 * @param {DelegationRow} delegation
 * @param {Record<string, unknown>} snapshot
 */
function scheduleFinishedHistoryDelivery(delegation, snapshot) {
  trackScheduledHistoryTask((async () => {
    const published = await publishDelegationStatus(delegation, 'finished', snapshot);
    /** @type {any} */ const base = published || delegation;
    const historyItem = (base?.outbox || delegation.outbox || [])
      .find((row) => row.type === 'history' && row.event === 'finished' && row.attemptId === snapshot.attemptId && !row.deliveredAt);
    if (historyItem && await isHistoryOutboxSuccess(base, historyItem)) markOutboxItemDelivered(base, historyItem.id);
  })(), 'finished', delegation);
}

/**
 * @param {DelegationRow} record
 * @returns {Record<string, unknown>}
 */
function buildFinishOutboxSnapshot(record) {
  return {
    status: record.status,
    report: record.report || '',
    error: record.error || '',
    attemptId: record.attemptId,
    eventId: record.eventId,
    parentChatId: record.parentChatId,
    childChatId: record.childChatId,
    unverified: record.unverified !== false,
    interruptCode: normalizeDelegationInterruptCode(record.interruptCode),
    startedAt: record.startedAt || '',
    finishedAt: record.finishedAt || '',
    executor: record.executor,
    sourceKind: record.sourceKind || '',
    assignment: record.assignment || '',
    attempts: Array.isArray(record.attempts) ? record.attempts : [],
  };
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {boolean} enqueueParentReply
 * @returns {any[]}
 */
function buildFinishOutboxItems(snapshot, enqueueParentReply) {
  const createdAt = new Date().toISOString();
  const items = [{
    id: randomUUID(),
    type: 'history',
    event: 'finished',
    attemptId: snapshot.attemptId,
    createdAt,
    deliveredAt: '',
    tryCount: 0,
    nextAttemptAt: '',
    snapshot,
  }];
  if (enqueueParentReply === true) {
    items.push({
      id: randomUUID(),
      type: 'mailbox',
      event: 'parent_reply',
      attemptId: snapshot.attemptId,
      createdAt,
      deliveredAt: '',
      tryCount: 0,
      nextAttemptAt: '',
      snapshot,
    });
  }
  return items;
}

/**
 * @param {{ status?: string, interruptCode?: string }} outcome
 * @returns {'completed' | 'infra_fail' | 'cancelled' | 'timeout' | null}
 */
export function classifyExploreAttemptOutcome(outcome) {
  const status = String(outcome?.status || '').trim().toLowerCase();
  if (status === 'cancelled' || status === 'cancelling') return 'cancelled';
  if (status === 'interrupted') {
    const code = String(outcome?.interruptCode || '').trim().toLowerCase();
    if (code.includes('timeout')) return 'timeout';
    if (code === DELEGATION_INTERRUPT_RUN_DEADLINE_EXCEEDED) return null;
    return 'infra_fail';
  }
  if (status === 'failed') return 'infra_fail';
  if (status === 'completed' || status === 'done') return 'completed';
  return null;
}

/**
 * @param {DelegationRow} row
 * @param {{ status?: string, interruptCode?: string }} outcome
 */
function finishExploreAttemptIfNeeded(row, outcome) {
  if (!row?.id) return;
  if (String(row.pickOriginDetail || '').trim() !== MODEL_PICK_EXPLORE_ORIGIN_DETAIL) return;
  const exploreOutcome = classifyExploreAttemptOutcome(outcome);
  if (!exploreOutcome) return;
  /** @type {any} */ const pick = row.pickId ? getModelPickRecord(String(row.pickId)) : null;
  finishModelPickExploreAttemptForDelegation({
    delegationId: row.id,
    outcome: exploreOutcome,
    marker: pick?.explore || null,
    mode: pick?.explore?.mode,
  });
}

/**
 * Record a real provider limit/balance/model-unavailable signal from a failed
 * delegation into the shared stores the picker reads. Best-effort: a store
 * write failure must never mask the original delegation error.
 *
 * @param {DelegationRow} delegation
 * @param {unknown} error
 * @returns {boolean}
 */
function noteDelegationExecutorLimit(delegation, error) {
  const message = String(error || '').trim();
  const transport = String(delegation?.executor?.transport || '').trim().toLowerCase();
  if (!message || !transport) return false;
  try {
    return noteHarnessUsageLimit({
      harness: transport,
      model: String(delegation?.executor?.model || '').trim(),
      message,
    });
  } catch {
    return false;
  }
}

const pendingTodoReviewSyncs = new Map();

/**
 * Best-effort hook that recomputes the durable `todo.review` snapshot for the
 * leaf a delegation row affects (`docs/todo-review-contract.md` §10.4). A broken
 * sync must never break the delegation transition, so the call is wrapped twice:
 * the hook itself catches, and this wrapper guards even an import-level throw.
 *
 * @param {DelegationRow} row
 * @param {{ dataDir?: string, parentTodoId?: string }} [options]
 * @returns {any}
 */
function safeSyncTodoReview(row, options = {}) {
  if (!row || typeof row !== 'object') return Promise.resolve(null);
  const key = String(row.id || '');
  const previous = pendingTodoReviewSyncs.get(key) || Promise.resolve();
  const run = previous.then(() => syncTodoReviewForDelegation(row, options)).catch(() => null);
  pendingTodoReviewSyncs.set(key, run);
  void run.finally(() => {
    if (pendingTodoReviewSyncs.get(key) === run) pendingTodoReviewSyncs.delete(key);
  });
  return run;
}

/**
 * Server-side startup-retry hook, installed by `createDelegationService`. The
 * standalone `finishDelegation` needs it to take over a transient startup
 * failure before it becomes a terminal `failed` + `startup_failure` lockout.
 * `null` means no service is running (pure unit tests) and the failure finishes
 * exactly as before.
 *
 * @type {null | ((record: Record<string, any>, outcome: Record<string, any>) => Record<string, any> | null)}
 */
let startupRetryScheduler = null;

/**
 * @param {DelegationRow} current
 * @param {any} outcome
 * @returns {any} the non-terminal record when a retry was scheduled
 */
function maybeScheduleDelegationStartupRetry(current, outcome) {
  if (typeof startupRetryScheduler !== 'function') return null;
  const error = String(outcome?.error || '').trim();
  if (!error) return null;
  const attemptId = String(outcome?.attemptId || current.attemptId || '').trim();
  // Only evidence tagged with the current attempt may classify the failure, so
  // a stale startup error from a previous attempt cannot retry a different one.
  const scopedErrors = (Array.isArray(current.errors) ? current.errors : [])
    .filter((entry) => !attemptId || String(entry?.attemptId || '').trim() === attemptId);
  if (!isDelegationStartupFailure({ status: 'failed', error, errors: scopedErrors })) return null;
  const used = Math.max(0, Number(current.startupRetry?.used) || 0);
  if (used >= resolveStartupRetryCount()) return null;
  try {
    return startupRetryScheduler(current, { ...outcome, error }) || null;
  } catch {
    // A retry-scheduling failure must fall through to the normal terminal path.
    return null;
  }
}

/**
 * Fill the metrics of an already-closed attempt, idempotently.
 *
 * Touches only `metrics` (current attempt) or the matching archived snapshot in
 * `attempts[]`: the terminal status, verdict, ACK, slot ownership and every
 * other field are left alone. Known values are never erased by unknown ones,
 * and replaying the same metrics is a no-op (no write, no change signal).
 *
 * @param {string} delegationId
 * @param {string} attemptId
 * @param {Record<string, unknown>} incoming
 * @returns {{ ok: boolean, applied: boolean, reason?: string, delegation?: Record<string, any> | null }}
 */
export function applyLateDelegationMetrics(delegationId, attemptId, incoming) {
  const current = /** @type {DelegationRow} */ (getDelegationById(String(delegationId || '').trim()));
  if (!current) return { ok: false, applied: false, reason: 'not_found' };
  if (isMetricsEmpty(/** @type {any} */ (incoming))) return { ok: true, applied: false, reason: 'empty', delegation: current };
  const wanted = String(attemptId || '').trim();
  const currentAttemptId = String(current.attemptId || '').trim();
  if (!wanted || wanted === currentAttemptId) {
    const merged = mergeLateMetrics(current.metrics, incoming);
    if (areMetricsEqual(merged, current.metrics)) {
      return { ok: true, applied: false, reason: 'unchanged', delegation: current };
    }
    const next = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, { metrics: merged }));
    return { ok: Boolean(next), applied: Boolean(next), delegation: next || current };
  }
  const archived = Array.isArray(current.attempts) ? current.attempts : [];
  const index = archived.findIndex((row) => String(row?.attemptId || '').trim() === wanted);
  if (index < 0) return { ok: true, applied: false, reason: 'stale_attempt', delegation: current };
  const merged = mergeLateMetrics(archived[index].metrics, incoming);
  if (areMetricsEqual(merged, archived[index].metrics)) {
    return { ok: true, applied: false, reason: 'unchanged', delegation: current };
  }
  const attempts = archived.map((row, i) => (i === index ? { ...row, metrics: merged } : row));
  const next = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, { attempts }));
  return { ok: Boolean(next), applied: Boolean(next), delegation: next || current };
}

/**
 * Ledger-derived metrics for one attempt, or null when the ledger is
 * unreadable. Never throws.
 *
 * @param {DelegationRow} record
 * @param {string} [attemptId]
 * @returns {Record<string, number | string | null> | null}
 */
function readLedgerAttemptMetrics(record, attemptId) {
  try {
    return readAttemptUsageMetrics({ delegation: record, attemptId });
  } catch {
    return null;
  }
}

/**
 * @param {any} delegation
 * @param {{
 *   report?: string,
 *   error?: string,
 *   status: string,
 *   enqueueParentReply?: boolean,
 *   attemptId?: string,
 *   runId?: string,
 *   taskOutcome?: string,
 *   interruptCode?: string,
 *   metrics?: Record<string, number | null>,
 *   slotHeldBy?: string,
 *   runStoppingAt?: string,
 *   cancelEscalatedAt?: string,
 * }} outcome
 */
export function finishDelegation(delegation, outcome) {
  const current = /** @type {DelegationRow} */ (getDelegationById(delegation.id));
  if (!current) return null;
  if (!isDelegationEventCurrent(current, outcome?.runId, outcome?.attemptId)) {
    return current;
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    // Metrics may trail the terminal verdict (late adapter finish after an
    // accepted final_report, or after cancel/error). They only fill the
    // attempt's metrics; verdict, ACK and slot ownership stay untouched.
    if (outcome?.metrics && typeof outcome.metrics === 'object') {
      applyLateDelegationMetrics(current.id, outcome.attemptId || current.attemptId, outcome.metrics);
    }
    if (outcome?.error) {
      // A second terminal event for the same attempt (leftover run / double
      // `sdkRunFinished`) is spurious. Count it for diagnostics; never append
      // it to `errors[]` as if it were a job failure.
      return /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
        afterTerminalCount: Number(current.afterTerminalCount || 0) + 1,
        lastAfterTerminalAt: new Date().toISOString(),
        lastAfterTerminalCode: 'adapter_after_terminal',
      })) || current;
    }
    if (!String(current.historyDeliveredAt || '').trim()) {
      scheduleDelegationHistoryPublish(current, 'finished');
    }
    return current;
  }
  // Transient executor startup failure with retry budget: keep the job
  // non-terminal, hand it to the service scheduler, and record no lockout.
  // This is the single decision point for both the synchronous accept path and
  // the asynchronous run-bridge path (including a first-event timeout after the
  // start was accepted).
  if (String(outcome?.status || '') === 'failed') {
    const scheduled = maybeScheduleDelegationStartupRetry(current, outcome);
    if (scheduled) return scheduled;
  }
  const finishedAt = new Date().toISOString();
  const reportAssessment = assessDelegationReport(outcome.report || current.report || '');
  const reportVerdict = resolveEffectiveCodeReviewReportVerdict(
    { ...current, report: reportAssessment.report },
    reportAssessment.verdict,
  );
  const finishedSessionContinuity = readCurrentSessionContinuity(current.childChatId);
  /** @type {any} */ const transitionPatch = {
    report: reportAssessment.report,
    reportVerdict,
    reportDegraded: reportAssessment.degraded,
    reportSummary: reportAssessment.summary,
    ...buildReviewFindingsSummaryPatch(current, reportAssessment.report),
    error: outcome.error || current.error || '',
    finishedAt,
    taskOutcome: normalizeDelegationTaskOutcome(outcome.taskOutcome || current.taskOutcome),
    interruptCode: String(outcome.status || '') === 'interrupted'
      ? normalizeDelegationInterruptCode(outcome.interruptCode)
      : '',
    ...(outcome.metrics && typeof outcome.metrics === 'object' ? { metrics: outcome.metrics } : {}),
    // The retry budget ends with the attempt: this transition is the fenced,
    // durable attempt end (completed, or a failure the retry decision above
    // declined to retry). `expectedAttemptId` below fences the clear to the
    // current attempt, so a stale event can neither spend nor keep a budget.
    // It is deliberately NOT cleared on the `running` transition: adapter
    // acceptance precedes the authoritative first event, and an accepted but
    // silent run can still time out on the async bridge.
    startupRetry: null,
    sessionContinuity: finishedSessionContinuity,
    // Completion is not proof that the adapter terminal record is durable.
    sessionContinuityConfirmed: false,
  };
  if (outcome.slotHeldBy !== undefined) {
    transitionPatch.slotHeldBy = outcome.slotHeldBy;
  }
  if (outcome.runStoppingAt !== undefined) {
    transitionPatch.runStoppingAt = outcome.runStoppingAt;
  }
  if (outcome.cancelEscalatedAt !== undefined) {
    transitionPatch.cancelEscalatedAt = outcome.cancelEscalatedAt;
  }
  const next = transition(current, outcome.status, transitionPatch, { expectedAttemptId: current.attemptId });
  if (!next) return null;
  // Real provider limit / balance / model-unavailable signals in a failed
  // delegation feed the shared lockout + plan-limit stores the picker reads, so
  // `planLimitPenalty`/lockouts fire from actual events instead of waiting for
  // an empty-file free pass. `noteHarnessUsageLimit` no-ops on unrelated errors.
  if (String(outcome.status || '') === 'failed' && outcome.error) {
    const transport = String(next?.executor?.transport || '').trim().toLowerCase();
    const modelId = String(next?.executor?.model || '').trim();
    const lockoutScope = {
      workspaceFolder: String(next?.workspaceFolder || '').trim(),
      executionFolder: String(next?.executionFolder || next?.workspaceFolder || '').trim(),
      dataDir: resolveDataPath(),
    };
    if (classifyDelegationFailure({ error: outcome.error, errors: next?.errors }).failureClass === 'quota') {
      if (noteDelegationExecutorLimit(next, outcome.error)) {
        armDelegationUsageLimitPause(
          { ...next, leafId: readDelegationWorkflowLeafIdFromRow(next) },
          { dataDir: lockoutScope.dataDir, getLimit: getHarnessUsageLimit },
        );
      }
    } else {
      noteDelegationFailureLockout({
        harness: transport, model: modelId, error: outcome.error, errors: next?.errors,
        status: outcome.status, ...lockoutScope,
      });
    }
  }
  if (String(outcome.status || '') === 'completed' && resolveDelegationTechnicalSuccess(next)) {
    const transport = String(next?.executor?.transport || '').trim().toLowerCase();
    const modelId = String(next?.executor?.model || '').trim();
    clearHarnessStartupFailureLockout({
      harness: transport,
      model: modelId,
      workspaceFolder: String(next?.workspaceFolder || '').trim(),
      executionFolder: String(next?.executionFolder || next?.workspaceFolder || '').trim(),
      dataDir: resolveDataPath(),
    });
  }
  // Marker + in-flight run must exist before the outbox tells the parent.
  startAutoVerifyAfterImplement(next);
  const snapshot = buildFinishOutboxSnapshot(next);
  const withOutbox = /** @type {DelegationRow} */ (updateDelegationRecord(next.id, {
    outboxAppend: buildFinishOutboxItems(snapshot, outcome.enqueueParentReply === true),
  })) || next;
  logDelegationEvent('finished', withOutbox);
  runDelegationCrashHook('after-result-write', withOutbox);
  finishExploreAttemptIfNeeded(withOutbox, outcome);
  // The parent-history card is delivered from the outbox item written above (durable intent, at-least-once,
  // deduplicated): the terminal transition itself stays synchronous and never waits for the history store.
  const final = /** @type {DelegationRow} */ (getDelegationById(next.id)) || withOutbox;
  // Terminal transition (completion, cancel, timeout) — one shared hook for the
  // worker and the bridge. The stored attempt now carries its verdict/verify
  // evidence, so the snapshot can settle `passed`/`failed`/`unknown`.
  safeSyncTodoReview(final);
  scheduleFinishedHistoryDelivery(withOutbox, snapshot);
  // Fire-and-forget: the session sync reads the todo through the async store.
  try {
    Promise.resolve(syncPlanReviewerSessionAfterDelegationFinish(final)).catch(() => {});
  } catch {
    // Cooperation sync must not break delegation finalization.
  }
  syncCodeReviewWorkflowAfterFinish(final);
  const leafId = readDelegationWorkflowLeafIdFromRow(final);
  if (leafId) {
    // Fire-and-forget: the Git reads run off the event loop and the result is
    // an additive todo annotation, so finalization does not wait for it.
    updateLeafMaterialPartialPaths({
      dataDir: resolveDataPath(),
      workspaceFolder: String(final.workspaceFolder || '').trim(),
      leafId,
      executionFolder: String(final.executionFolder || final.workspaceFolder || '').trim(),
      delegation: final,
    }).catch(() => {});
  }
  return final;
}

/**
 * Refresh the terminal session boundary after the adapter's final history
 * record (normally `runFinished`) is durably committed. The attempt fence
 * prevents a late event from moving the boundary of a newer retry.
 *
 * @param {{ delegationId?: unknown, attemptId?: unknown, boundary?: Record<string, any>, expectedSession?: Record<string, any> }} input
 * @returns {any}
 */
export function refreshFinishedDelegationSessionContinuity(input = {}) {
  const delegationId = String(input.delegationId || '').trim();
  const attemptId = String(input.attemptId || '').trim();
  const current = delegationId ? /** @type {DelegationRow} */ (getDelegationById(delegationId)) : null;
  if (!current || !isTerminalDelegationStatus(current.status)) return current;
  if (!attemptId || String(current.attemptId || '').trim() !== attemptId) return current;
  if (current.sessionContinuityConfirmed === true) return current;
  const live = readCurrentSessionContinuity(current.childChatId);
  const expected = normalizeSessionContinuity(input.expectedSession);
  const continuity = normalizeSessionContinuity(input.boundary);
  if (!expected || !live || !continuity || continuity.historyHeadSeq == null) return current;
  if (live.identity !== expected.identity || live.generation !== expected.generation) return current;
  if (continuity.identity !== expected.identity || continuity.generation !== expected.generation) return current;
  if (live.historyHeadSeq == null || continuity.historyHeadSeq > live.historyHeadSeq) return current;
  return /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
    sessionContinuity: continuity,
    sessionContinuityConfirmed: true,
  })) || current;
}

/**
 * @param {any} existing
 * @param {DelegationRow} next
 * @returns {boolean}
 */
function isEquivalentDelegationVerifyResult(existing, next) {
  if (!existing || typeof existing !== 'object') return false;
  const fields = ['status', 'exitCode', 'verdict', 'source', 'dataDir', 'attemptId', 'materialRevision', 'outputTail', 'stale', 'rawOk'];
  if (!fields.every((key) => String(existing[key] ?? '') === String(next[key] ?? ''))) return false;
  if (String(existing.manifest?.testSetKey ?? '') !== String(next.manifest?.testSetKey ?? '')) return false;
  if (String(existing.manifest?.envKey ?? '') !== String(next.manifest?.envKey ?? '')) return false;
  const lists = ['newFailures', 'preexistingFailures', 'flakyFailures'];
  if (!lists.every((key) => (existing[key] || []).join(',') === (next[key] || []).join(','))) return false;
  return String(existing.baseline?.source ?? '') === String(next.baseline?.source ?? '');
}

/**
 * Manifest of the audited ids a verify covers, bound to attempt, revision and
 * environment. Ids resolve only through the dynamic catalog; a rejected id
 * yields null (no manifest means no usable manifest evidence, never a throw).
 *
 * @param {{ ids: unknown, root: string, attemptId: string, materialRevision: string }} input
 * @returns {any}
 */
function captureVerifyManifest({ ids, root, attemptId, materialRevision }) {
  try {
    const built = buildVerifyManifest({
      ids,
      catalog: resolveReviewVerifyCatalog(root),
      curated: REVIEW_VERIFY_CATALOG,
      projectRoot: root,
      attemptId,
      materialRevision,
    });
    return built.ok ? built.manifest : null;
  } catch {
    return null;
  }
}

/** Persist the host-owned review runner result for the current delegation attempt. */
/**
 * A controller (a Watcher cycle or a Todo orchestrator) often ends its turn
 * while the automatic host verify of an implement/fix runs, because a review
 * cannot start before it. Nothing else wakes it when the verify settles, and a
 * Watcher cycle chat idle without a report is closed as `missing_report`.
 * When the controller is confirmed idle, a mailbox note wakes it with the
 * result; a busy controller is polling and gets nothing. Best effort.
 *
 * @param {string} delegationId
 * @returns {Promise<void>}
 */
async function wakeIdleControllerAfterAutoVerify(delegationId) {
  try {
    /** @type {any} */ const row = /** @type {any} */ (getDelegationById(delegationId));
    const controller = delegationController(row);
    const child = String(row?.childChatId || '').trim();
    if (!row || !controller || !child) return;
    if (!isChatRunConfirmedIdle({ chatId: controller })) return;
    const verify = row.verifyResult || {};
    const status = String(verify.status || 'unknown');
    const newFailures = Array.isArray(verify.newFailures) ? verify.newFailures.map(String) : [];
    await enqueueMailboxMessage(/** @type {any} */ ({
      fromChatId: child,
      toChatId: controller,
      delegationId: row.id,
      kind: 'reply',
      replyKind: 'progress',
      body: [
        `Automatic host verify for delegation ${row.id} finished: ${status}${newFailures.length ? ` (new failures: ${newFailures.join(', ')})` : ''}.`,
        'Continue the workflow now: read it with delegation_show, then start the review or a fix.',
        'Keep waiting inside the same turn (delegation_wait) instead of ending the turn.',
      ].join('\n'),
      idempotencyKey: `auto-verify-settled:${row.id}:${row.attemptId || ''}:${verify.recordedAt || verify.materialRevision || ''}`,
    }));
  } catch (error) {
    console.warn(`[delegation] auto-verify wake for ${delegationId} failed: ${error?.message || error}`);
  }
}

export async function recordDelegationVerifyResult(input = {}) {
  const id = String(input.delegationId || '').trim();
  const attemptId = String(input.attemptId || '').trim();
  const current = id ? /** @type {DelegationRow} */ (getDelegationById(id)) : null;
  if (!current || !attemptId || attemptId !== String(current.attemptId || '').trim()) return null;
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const verdict = String(input.verdict || '').trim() || resolveDelegationRecordVerdict(current);
  const leafTodo = await getTodoById(resolveDataPath(), String(current.workspaceFolder || '').trim(), readDelegationWorkflowLeafIdFromRow(current));
  const scopedRevision = leafTodo
    ? readLeafScopedMaterialRevisionForTodo(leafTodo, String(current.executionFolder || current.workspaceFolder || '').trim())
    : '';
  const liveRevision = scopedRevision || readDelegationMaterialRevisionForRecord(current);
  // An auto run captures the revision before it starts; a different live
  // revision at record time means the material moved under the run.
  const capturedRevision = String(input.materialRevision || '').trim();
  const materialRevision = capturedRevision || liveRevision;
  const manifestRoot = String(current.executionFolder || current.workspaceFolder || '').trim();
  // Explicit ids win; otherwise derive them from the executed results (each id
  // was already checked against the catalog by the runner), so manual and
  // runner-driven records carry a manifest too. Nothing new becomes executable.
  const explicitIds = Array.isArray(input.ids) ? input.ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const resultIds = Array.isArray(result.results) ? result.results.map((r) => String(r?.id || '').trim()).filter(Boolean) : [];
  const manifestIds = explicitIds.length > 0 ? explicitIds : [...new Set(resultIds)];
  const manifest = manifestIds.length > 0 && manifestRoot
    ? captureVerifyManifest({ ids: manifestIds, root: manifestRoot, attemptId, materialRevision })
    : null;
  // Test files edited (or removed) while the run executed make the captured set stale too.
  const testsChanged = Boolean(input.manifest?.testSetKey && (!manifest || input.manifest.testSetKey !== manifest.testSetKey));
  const isStale = Boolean(capturedRevision && liveRevision && capturedRevision !== liveRevision) || testsChanged;
  // Gate status: a baseline classification (when present) decides; otherwise
  // (reviewer-run path, unavailable baseline) the raw outcome stands.
  const classification = input.classification && typeof input.classification === 'object' ? input.classification : null;
  const gateStatus = classification?.status === 'passed' || classification?.status === 'failed'
    ? classification.status
    : (result.ok === true ? 'passed' : 'failed');
  /** @type {any} */ const verifyResult = {
    status: gateStatus,
    exitCode: gateStatus === 'passed' ? 0 : 1,
    ...(classification ? buildVerifyClassificationFields(classification, result) : {}),
    verdict: DELEGATION_VERDICTS.includes(verdict) ? verdict : '',
    source: String(input.source || '').trim(),
    dataDir: String(result.dataDir || ''),
    recordedAt: new Date().toISOString(),
    attemptId,
    materialRevision,
    ids: Array.isArray(input.ids) ? input.ids : [],
    outputTail: String(result.output || result.error || '').slice(-4096),
    implementDelegationId: String(input.implementDelegationId || '').trim(),
    stale: isStale,
    ...(manifest ? { manifest } : {}),
  };
  // Informational classification only: never feeds a status gate on `done`.
  const evidence = evaluateVerifyManifestEvidence({
    verifyResult: { ...verifyResult, results: Array.isArray(result.results) ? result.results : undefined },
    requiredIds: manifestIds,
    attemptId,
    materialRevision,
    envKey: computeVerifyEnvKey(),
  });
  verifyResult.manifestEvidence = { usable: evidence.usable, reason: evidence.reason };
  if (isEquivalentDelegationVerifyResult(current.verifyResult, verifyResult)) {
    return current;
  }
  const updated = /** @type {DelegationRow} */ (updateDelegationRecord(id, input.clearVerifyPending === true
    ? { verifyResult, verifyPending: null }
    : { verifyResult }));
  // A host verify answers the attempt's verify obligation: recompute so a
  // required-missing `unknown` becomes `passed`/`failed` (`§10.4`).
  await safeSyncTodoReview(updated || current);
  return updated;
}

/**
 * Classify a raw verify result against the leaf's base commit. Never throws;
 * an unusable baseline degrades to the raw outcome.
 *
 * @param {{ result: Record<string, any>, row: Record<string, any>, root: string, budgetMs?: number }} input
 * @returns {Promise<Record<string, any> | null>}
 */
export async function classifyVerifyForRow({ result, row, root, budgetMs }) {
  try {
    /** @type {any} */ const leafTodo = await getTodoById(resolveDataPath(), String(/** @type {any} */ (row).workspaceFolder || '').trim(), readDelegationWorkflowLeafIdFromRow(row));
    const baseCommit = String(leafTodo?.leafMaterial?.baseCommit || '').trim();
    return await classifyReviewVerify({ raw: /** @type {any} */ (result), projectRoot: root, baseCommit, budgetMs });
  } catch {
    return null;
  }
}

const AUTO_VERIFY_SOURCE = 'auto_after_implement';
const INHERITED_VERIFY_SOURCE = 'inherited_from_implement';

/**
 * May the implement's recorded pass stand in for a fresh run? Re-hashes the
 * manifest's ids against the current files and environment; a missing manifest,
 * changed test file, changed environment or unresolvable id means no reuse.
 *
 * @param {DelegationRow} implement
 * @param {any} verify
 * @param {string} currentRevision
 * @returns {{ reuse: boolean, reason: string }}
 */
function decideImplementVerifyReuse(implement, verify, currentRevision) {
  const ids = Array.isArray(verify?.manifest?.entries) ? verify.manifest.entries.map((e) => e.id) : [];
  if (ids.length === 0) return { reuse: false, reason: 'no_prior' };
  const root = String(implement.executionFolder || implement.workspaceFolder || '').trim();
  const now = root ? captureVerifyManifest({ ids, root, attemptId: '', materialRevision: currentRevision }) : null;
  if (!now) return { reuse: false, reason: 'tests_unresolvable' };
  return decideVerifyReuse({
    prior: verify,
    next: { materialRevision: currentRevision, envKey: computeVerifyEnvKey(), testSetKey: now.testSetKey, ids },
  });
}

/**
 * Latest implement/fix evidence usable by a code review: a non-stale `passed`
 * result recorded for the current leaf revision. Decision-point only.
 *
 * @param {DelegationRow} reviewRow
 * @returns {Promise<{ implement: Record<string, any>, verify: Record<string, any> } | null>}
 */
async function findInheritableImplementVerify(reviewRow) {
  if (String(reviewRow?.assignment || '').trim().toLowerCase() !== 'review') return null;
  if (String(reviewRow?.reviewSubject || '').trim().toLowerCase() !== 'code') return null;
  const leafId = readDelegationWorkflowLeafIdFromRow(reviewRow);
  const parentChatId = delegationController(reviewRow);
  if (!leafId || !parentChatId) return null;
  /** @type {any} */ const implement = findLatestTerminalImplementFixForLeaf(parentChatId, leafId);
  const verify = implement?.verifyResult;
  if (!verify || verify.status !== 'passed' || verify.stale === true) return null;
  const current = await readLiveMaterialRevisionForRow(implement);
  if (!verify.materialRevision || !current || verify.materialRevision !== current) return null;
  if (!decideImplementVerifyReuse(implement, verify, current).reuse) return null;
  return { implement, verify };
}

/**
 * Copy the implement's passed verify onto the freshly started review attempt.
 * Must run after the `starting` transition so the new `attemptId` is stamped.
 *
 * @param {any} reviewRow
 * @returns {Promise<any>}
 */
export async function applyInheritedVerifyEvidence(reviewRow) {
  try {
    /** @type {any} */ const found = reviewRow ? await findInheritableImplementVerify(reviewRow) : null;
    if (!found) return reviewRow;
    const updated = /** @type {DelegationRow} */ (updateDelegationRecord(reviewRow.id, {
      verifyResult: {
        ...rebindVerifyEvidence(found.verify, String(reviewRow.attemptId || '').trim()),
        source: INHERITED_VERIFY_SOURCE,
        attemptId: String(reviewRow.attemptId || '').trim(),
        manifestEvidence: { usable: true, reason: 'reused' },
        implementDelegationId: found.implement.id,
        recordedAt: new Date().toISOString(),
      },
    }));
    return updated || reviewRow;
  } catch {
    return reviewRow;
  }
}

/**
 * Bounded prompt block with the hard test evidence a reviewer cannot gather.
 *
 * @param {any} input
 * @returns {Promise<string>}
 */
async function buildImplementVerifyEvidenceBlock(input) {
  const found = await findInheritableImplementVerify(/** @type {any} */ ({
    assignment: input.assignment,
    reviewSubject: input.reviewSubject,
    parentChatId: input.parentChatId,
    leafId: input.leafId,
  }));
  if (!found) return '';
  /** @type {any} */ const verify = found.verify;
  return [
    '[HOST VERIFY EVIDENCE]',
    `status=${verify.status} exit=${verify.exitCode} revision=${verify.materialRevision}`,
    `ids=${(verify.ids || []).join(',') || '(full catalog)'}`,
    verify.outputTail ? `output tail:\n${String(verify.outputTail).slice(-2000)}` : '',
    'The host already ran these tests on the current material; do not repeat them unless you suspect gaps.',
  ].filter(Boolean).join('\n');
}

/** @type {Map<string, Promise<unknown>>} serialises auto runs per project root */
const autoVerifyChains = new Map();

/** @returns {boolean} false when CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT is off */
export function isAutoVerifyAfterImplementEnabled() {
  const raw = String(process.env.CRETLI_AUTO_VERIFY_AFTER_IMPLEMENT ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * Leaf-scoped material revision for a record, falling back to the workspace one.
 *
 * @param {DelegationRow} row
 * @returns {Promise<string>}
 */
async function readLiveMaterialRevisionForRow(row) {
  const leafTodo = await getTodoById(resolveDataPath(), String(row.workspaceFolder || '').trim(), readDelegationWorkflowLeafIdFromRow(row));
  const scoped = leafTodo
    ? readLeafScopedMaterialRevisionForTodo(leafTodo, String(row.executionFolder || row.workspaceFolder || '').trim())
    : '';
  return scoped || readDelegationMaterialRevisionForRecord(row);
}

/**
 * Catalog ids a leaf verify covers: the curated path selectors, plus the tests
 * the change reaches through the import graph and the control test. With no
 * change set, or no signal beyond the control test, the whole catalog runs so
 * a missing signal never shrinks verification.
 *
 * @param {{ changed: string[], root: string }} input
 * @returns {{ ids: string[], freshIds: string[] }} `freshIds` must bypass the result cache
 */
export function selectAutoVerifyIds({ changed, root }) {
  const full = [...REVIEW_VERIFY_IDS];
  // No usable signal: run everything, and never from cache (unknown inputs may have changed).
  if (changed.length === 0) return { ids: full, freshIds: full };
  const catalog = resolveReviewVerifyCatalog(root);
  const mappedBy = new Map(changed.map((p) => [p, resolveReviewVerifyIdsForPath(p)]));
  const mapped = [...new Set([...mappedBy.values()].flat())];
  let graph = { ids: /** @type {string[]} */ ([]), affectedIds: /** @type {string[]} */ ([]) };
  /** @type {Map<string, string[]> | null} */ let index = null;
  try {
    index = buildImportIndex(root);
    graph = selectVerifyIdsForChange({ catalog, changed, controlIds: [BASELINE_CONTROL_ID], mode: 'leaf', root, index });
  } catch {
    // An unreadable tree falls back to the curated mapping alone.
  }
  const touched = [...new Set([...mapped, ...graph.affectedIds])];
  if (touched.length === 0) return { ids: full, freshIds: full };
  // A curated id may read a changed file with fs, outside its import closure; the
  // result cache cannot see that, so such ids always run.
  const freshIds = mapped.filter((id) => {
    if (!index || !catalog[id]) return true;
    const closure = new Set(collectDependencies(index, String(catalog[id]).replace(/\\/g, '/')));
    return changed.some((p) => (mappedBy.get(p) || []).includes(id) && !closure.has(p));
  });
  return { ids: [...new Set([...touched, ...graph.ids.filter((id) => id === BASELINE_CONTROL_ID)])], freshIds };
}

/**
 * Raw per-id runner for the verify queue, or the plain full runner when the
 * queue is disabled or could not be opened.
 *
 * @returns {typeof runReviewVerify}
 */
function resolveDefaultAutoVerifyRunner() {
  const queued = getDefaultVerifyRunner({
    runStep: (input) => runReviewVerify(input),
    resolveCatalog: (root) => resolveReviewVerifyCatalog(root),
  });
  return /** @type {any} */ (queued || runReviewVerify);
}

/**
 * Start the host verify for a just-completed implement/fix. The in-flight run
 * is registered synchronously and `verifyPending` is written before the parent
 * is told the implement finished, so a fast review start sees the pending run.
 * Never throws into finalization.
 *
 * @param {any} row terminal implement/fix record
 * @param {{ runner?: typeof runReviewVerify }} [options] test seam: replaces the verify runner (default: the
 *   queue-backed cached runner, or `runReviewVerify` when the queue is off/unavailable)
 * @returns {Promise<unknown> | null}
 */
export function startAutoVerifyAfterImplement(row, { runner } = {}) {
  try {
    if (!row || !isAutoVerifyAfterImplementEnabled()) return null;
    if (String(row.status || '') !== 'completed' || !isImplementOrFixDelegationRow(row)) return null;
    const root = String(row.executionFolder || row.workspaceFolder || '').trim();
    if (!root || !existsSync(root)) return null;
    // A project without review-verify tests has nothing to run; a recorded
    // failure would only block its code review.
    if (resolveDefaultReviewVerifyIds(root).length === 0) return null;
    // The leaf todo is read through the async store, so the pending marker is
    // written first (revision filled in below) and the chain head is registered
    // before the first await: a fast review start still sees the pending run.
    const since = new Date().toISOString();
    /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { verifyPending: { since, revision: '' } }));
    const previous = autoVerifyChains.get(root) || Promise.resolve();
    /** @type {Promise<unknown>} */
    const settled = (async () => {
      const revision = await readLiveMaterialRevisionForRow(row);
      const existing = row.verifyResult;
      if (existing && existing.stale !== true && existing.attemptId === row.attemptId
        && revision && existing.materialRevision === revision) {
        /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { verifyPending: null }));
        return null;
      }
      /** @type {any} */ const leafTodo = await getTodoById(resolveDataPath(), String(row.workspaceFolder || '').trim(), readDelegationWorkflowLeafIdFromRow(row));
      const changed = Array.isArray(leafTodo?.leafMaterial?.partialPaths) ? leafTodo.leafMaterial.partialPaths : [];
      const { ids, freshIds } = selectAutoVerifyIds({ changed, root });
      /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { verifyPending: { since, revision } }));
      const attemptId = String(row.attemptId || '').trim();
      const startManifest = captureVerifyManifest({ ids, root, attemptId, materialRevision: revision });
      const runVerify = runner || resolveDefaultAutoVerifyRunner();
      trackAutoVerifyChain({ delegationId: row.id, projectRoot: root, materialRevision: revision, promise: settled });
      const run = previous.catch(() => {}).then(() => runVerify({ ids, projectRoot: root, materialRevision: revision, freshIds }));
      return run.then(
        async (result) => recordDelegationVerifyResult({
          delegationId: row.id,
          attemptId,
          result,
          classification: await classifyVerifyForRow({ result, row, root, budgetMs: BASELINE_ASYNC_BUDGET_MS }),
          verdict: resolveDelegationRecordVerdict(row),
          source: AUTO_VERIFY_SOURCE,
          ids,
          materialRevision: revision,
          manifest: startManifest,
          implementDelegationId: row.id,
          clearVerifyPending: true,
        }),
        (err) => recordDelegationVerifyResult({
          delegationId: row.id,
          attemptId,
          result: { ok: false, output: '', error: String(err?.message || err), dataDir: '' },
          source: AUTO_VERIFY_SOURCE,
          ids,
          materialRevision: revision,
          implementDelegationId: row.id,
          clearVerifyPending: true,
        }),
      ).then(() => wakeIdleControllerAfterAutoVerify(/** @type {any} */ (row).id));
    })().catch(() => {
      try { /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { verifyPending: null })); } catch { /* best effort */ }
    }).finally(() => {
      if (autoVerifyChains.get(root) === settled) autoVerifyChains.delete(root);
    });
    autoVerifyChains.set(root, settled);
    return settled;
  } catch {
    try { /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { verifyPending: null })); } catch { /* best effort */ }
    return null;
  }
}

/**
 * Patch one outbox intent on the latest record. Never rewrite the whole
 * snapshot from a stale in-memory array — concurrent appends must survive.
 *
 * @param {DelegationRow} record
 * @param {string} itemId
 * @param {Record<string, unknown>} patch
 */
function patchOutboxItem(record, itemId, patch) {
  const id = String(record?.id || '').trim();
  const targetId = String(itemId || '').trim();
  if (!id || !targetId) return record;
  const latest = /** @type {DelegationRow} */ (getDelegationById(id));
  if (!latest) return record;
  /** @type {any} */ const item = (latest.outbox || []).find((row) => String(row.id || '') === targetId);
  if (!item) return latest;
  return /** @type {DelegationRow} */ (updateDelegationRecord(id, {
    outboxItemPatch: {
      id: targetId,
      expectedAttemptId: String(item.attemptId || '').trim(),
      patch,
    },
  })) || latest;
}

/**
 * @param {DelegationRow} record
 * @param {string} itemId
 */
function markOutboxItemDelivered(record, itemId) {
  return patchOutboxItem(record, itemId, {
    deliveredAt: new Date().toISOString(),
    nextAttemptAt: '',
    lastError: '',
  });
}

/**
 * @param {number} tryCount
 * @returns {number}
 */
function computeOutboxBackoffMs(tryCount) {
  const exp = Math.min(8, Math.max(0, Number(tryCount) || 0));
  return Math.min(DELEGATION_OUTBOX_BACKOFF_MAX_MS, DELEGATION_OUTBOX_BACKOFF_MS * (2 ** exp));
}

/**
 * @param {DelegationRow} record
 * @param {DelegationRow} item
 * @param {string} error
 * @param {number} [now]
 */
function markOutboxItemRetry(record, item, error, now = Date.now()) {
  const tryCount = (Number(item.tryCount) || 0) + 1;
  const nextAttemptAt = new Date(now + computeOutboxBackoffMs(tryCount)).toISOString();
  const patched = patchOutboxItem(record, item.id, {
    tryCount,
    nextAttemptAt,
    lastError: String(error || 'delivery_failed'),
  });
  return /** @type {DelegationRow} */ (updateDelegationRecord(patched.id, {
    errorAppend: [{
      at: new Date(now).toISOString(),
      code: 'outbox_retry',
      message: String(error || 'delivery_failed'),
      attemptId: item.attemptId,
      outboxId: item.id,
    }],
  })) || patched;
}

/**
 * @param {DelegationRow} record
 * @param {DelegationRow} item
 * @returns {Promise<boolean>}
 */
async function isHistoryOutboxSuccess(record, item) {
  const snapshotAttempt = String(item?.snapshot?.attemptId || item?.attemptId || '');
  const currentAttempt = String(record?.attemptId || '');
  if (snapshotAttempt && currentAttempt && snapshotAttempt === currentAttempt) {
    return Boolean(String(record?.historyDeliveredAt || '').trim());
  }
  return await hasDelegationHistoryEvent(delegationController(record), {
    id: record.id,
    event: item.event || 'finished',
    attemptId: snapshotAttempt,
    eventId: String(item?.snapshot?.eventId || ''),
  });
}

/**
 * @param {unknown} result
 * @returns {boolean}
 */
function isMailboxOutboxSuccess(result) {
  if (!result || /** @type {any} */ (result).ok === false) return false;
  return Boolean(/** @type {any} */ (result).message);
}

/**
 * Flush without taking the store lock. Callers that already hold
 * `enqueueDelegationStoreWork` must use this to avoid deadlock.
 *
 * @param {any} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function flushDelegationOutboxUnlocked(delegation, options = {}) {
  await pendingTodoReviewSyncs.get(String(delegation?.id || ''));
  let current = /** @type {DelegationRow} */ (getDelegationById(delegation?.id)) || delegation;
  if (!current?.id) return current || null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pending = Array.isArray(current.outbox)
    ? current.outbox.filter((row) => !String(row.deliveredAt || '').trim())
    : [];
  for (const item of pending) {
    current = /** @type {DelegationRow} */ (getDelegationById(current.id)) || current;
    const dueAt = Date.parse(String(item.nextAttemptAt || ''));
    if (Number.isFinite(dueAt) && dueAt > now) continue;
    await Promise.resolve().then(() => runDelegationCrashHook(`outbox:${item.type}`, current));
    const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : null;
    if (item.type === 'history') {
      const published = await publishDelegationStatus(current, /** @type {any} */ (item.event || 'updated'), snapshot);
      current = published || current;
      if (await isHistoryOutboxSuccess(current, item)) {
        current = markOutboxItemDelivered(current, /** @type {any} */ (item.id)) || current;
      } else {
        current = markOutboxItemRetry(current, item, 'history_append_failed', now) || current;
      }
      continue;
    }
    if (item.type !== 'mailbox') continue;
    await Promise.resolve().then(() => runDelegationCrashHook('before-mailbox', current));
    /** @type {any} */ const result = await ensureDelegationParentMailboxReply(current, snapshot, { deferDelivery: true });
    if (isMailboxOutboxSuccess(result)) {
      current = markOutboxItemDelivered(current, /** @type {any} */ (item.id)) || current;
    } else {
      const reason = result?.error || (result == null ? 'mailbox_skipped' : 'mailbox_failed');
      current = markOutboxItemRetry(current, item, reason, now) || current;
    }
  }
  return /** @type {DelegationRow} */ (getDelegationById(current.id)) || current;
}

/**
 * Deliver pending history/mailbox intents after a crash or restart.
 * Marks only the specific outbox id, and only after a confirmed result.
 *
 * @param {any} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function flushDelegationOutbox(delegation, options = {}) {
  const flushed = await enqueueDelegationStoreWork(() => flushDelegationOutboxUnlocked(delegation, options));
  const parentChatId = delegationController(flushed) || delegationController(delegation);
  if (parentChatId) {
    await drainChatMailbox(parentChatId);
  }
  return /** @type {DelegationRow} */ (getDelegationById(delegation?.id)) || flushed;
}

/**
 * @param {any} delegation
 * @param {string} eventRunId
 * @param {string} eventAttemptId
 * @returns {boolean}
 */
export function isDelegationEventCurrent(delegation, eventRunId, eventAttemptId) {
  if (!delegation) return false;
  const attemptId = String(delegation.attemptId || '').trim();
  const runId = String(delegation.runId || '').trim();
  const incomingAttempt = String(eventAttemptId || '').trim();
  const incomingRun = String(eventRunId || '').trim();
  if (incomingAttempt && attemptId && incomingAttempt !== attemptId) return false;
  if (incomingRun && runId && incomingRun !== runId) return false;
  return true;
}

/**
 * @param {any} row
 * @returns {{ attemptId: string, runId: string, childChatId: string }}
 */
function readDelegationCancelFence(row) {
  return {
    attemptId: String(row?.attemptId || '').trim(),
    runId: String(row?.runId || '').trim(),
    childChatId: String(row?.childChatId || '').trim(),
  };
}

/**
 * @param {any} latest
 * @param {{ attemptId?: string, runId?: string }} fence
 * @returns {{ ok: true, status: number, skipped: true, stale: true, delegation: Record<string, any> } | null}
 */
function staleDelegationCancelResult(latest, fence) {
  if (isDelegationEventCurrent(latest, fence?.runId, fence?.attemptId)) return null;
  return { ok: true, status: 200, skipped: true, stale: true, delegation: latest };
}

/**
 * @param {{ chatId?: string, runId?: string }} input
 * @returns {boolean}
 */
export function isChatRunStillActive(input) {
  let state = null;
  try {
    state = getChatRunState(/** @type {any} */ (input));
  } catch {
    state = null;
  }
  return !!(state?.busy || state?.waitingForInput);
}

/**
 * Durable end of this attempt: a fenced final_report, adapter finish, or
 * stored finishedAt for the same attemptId. Age or a null getState is not proof.
 *
 * @param {any} row
 * @param {string} [attemptId]
 * @returns {boolean}
 */
export function hasDurableAttemptEndProof(row, attemptId) {
  if (!row) return false;
  const wanted = String(attemptId || row.attemptId || '').trim();
  if (!wanted) return false;
  const finalReply = findMailboxFinalReplyForAttempt(row.id, wanted);
  if (finalReply) return true;
  const storedFinalAttempt = String(row.finalReportAttemptId || '').trim();
  if (storedFinalAttempt && storedFinalAttempt === wanted && String(row.finalReportAcceptedAt || '').trim()) {
    return true;
  }
  if (isTerminalDelegationStatus(row.status) && String(row.attemptId || '').trim() === wanted) {
    if (String(row.finishedAt || '').trim()) return true;
  }
  const archived = listDelegationAttempts(row);
  return archived.some((/** @type {any} */ item) => {
    if (String(item.attemptId || '').trim() !== wanted) return false;
    return Boolean(String(item.finishedAt || '').trim());
  });
}

/**
 * @param {any} row
 * @returns {{ occupied: boolean, reason: string, code: string, delegationId: string, attemptId: string }}
 */
export function inspectDelegationSlot(row) {
  const delegationId = String(row?.id || '').trim();
  const attemptId = String(row?.attemptId || '').trim();
  const empty = { occupied: false, reason: '', code: '', delegationId, attemptId };
  if (!row || !delegationId) return empty;
  const inFlight = hasInFlightDelegationStart(delegationId);
  const live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
  const runBusy = live.busy === true;
  const runStateKnown = live.known === true;
  const pendingAccept = String(row.acceptState || '') === 'pending';
  const stopping = Boolean(String(row.runStoppingAt || '').trim())
    && !isStaleTerminalRunStopping(row);
  const hasProof = hasDurableAttemptEndProof(row, attemptId);
  const active = isActiveDelegationStatus(row.status);
  if (stopping) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.RUN_STOPPING,
      code: 'run_stopping',
      delegationId,
      attemptId,
    };
  }
  if (inFlight || pendingAccept || row.status === 'waiting_for_input' || row.status === 'cancelling' || (active && runBusy)) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.JOB_IN_PROGRESS,
      code: active && row.status !== 'cancelling' ? 'still_active' : 'job_in_progress',
      delegationId,
      attemptId,
    };
  }
  if (active && hasProof) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.STALE_RUNNING,
      code: 'stale_running',
      delegationId,
      attemptId,
    };
  }
  if (active && !runStateKnown) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.UNKNOWN,
      code: 'unknown',
      delegationId,
      attemptId,
    };
  }
  if (active) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.UNKNOWN,
      code: 'unknown',
      delegationId,
      attemptId,
    };
  }
  if (isDelegationSlotOccupied(row)) {
    return {
      occupied: true,
      reason: DELEGATION_SLOT_REASONS.RUN_STOPPING,
      code: 'run_stopping',
      delegationId,
      attemptId,
    };
  }
  return empty;
}

/**
 * @param {any} blocker
 * @param {string} fallbackCode
 * @param {string} fallbackError
 */
function slotConflict(blocker, fallbackCode, fallbackError) {
  return {
    ok: false,
    status: 409,
    error: fallbackError,
    code: blocker.code || fallbackCode,
    reason: blocker.reason || '',
    delegationId: blocker.delegationId || '',
    attemptId: blocker.attemptId || '',
    id: blocker.delegationId || '',
  };
}

/**
 * Shared start/retry width. Same-job resume is exempt via resumeDelegationId.
 *
 * @param {{
 *   parentChatId: string,
 *   incomingAssignment: unknown,
 *   resumeDelegationId?: string,
 *   gate: 'start' | 'retry',
 *   workspaceFolder?: string,
 *   executionFolder?: string,
 *   ignoreQueued?: boolean,
 *   incomingLeafId?: string,
 *   dataDir?: string,
 * }} input
 */
async function parentWidthConflict(input) {
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  /** @type {Map<string, string[]>} */
  const scopeCache = new Map();
  // The width assessment is synchronous, so leaf scopes are read from the store
  // up front for every leaf it can ask about (incoming leaf + active rows).
  const resolveLeafScopePaths = (leafId) => scopeCache.get(String(leafId || '').trim()) || [];
  const prefetchLeafScopePaths = async (leafId) => {
    const key = String(leafId || '').trim();
    if (!key || scopeCache.has(key)) return;
    const dataDir = String(input?.dataDir || '').trim() || resolveDataPath();
    const todo = workspaceFolder
      ? await getTodoById(dataDir, workspaceFolder, key)
      : null;
    scopeCache.set(key, todo ? collectTodoLeafScopePaths(todo) : []);
  };
  // Workspace-level delegation options (workspace > env > default). Without a
  // workspace this reads env only, exactly as before.
  const settings = resolveDelegationSettings({
    workspaceFolder,
    dataDir: resolveDataPath(),
  });
  const ignoreQueued = input?.ignoreQueued === true;
  const notQueued = (row) => String(row?.status || '') !== 'queued';
  let activeForParent = /** @type {DelegationRow[]} */ (listActiveDelegationsForController(input.parentChatId));
  if (ignoreQueued) {
    activeForParent = activeForParent.filter(notQueued);
  }
  const occupied = listOccupiedDelegations();
  // Tree identity: a resumed/retried/queued row keeps its recorded tree, a new
  // start joins the tree of its (child) parent chat. '' = no shared tree.
  const existing = input.resumeDelegationId
    ? /** @type {DelegationRow[]} */ (loadDelegations()).find((row) => row.id === input.resumeDelegationId)
    : null;
  const rootDelegationId = resolveIncomingTreeRootId({
    existing,
    parent: existing ? null : /** @type {ChatRowAny[]} */ (loadChats()).find((chat) => chat.id === input.parentChatId),
  });
  const incomingLeafId = String(input?.incomingLeafId || '').trim()
    || (existing ? readDelegationWorkflowLeafIdFromRow(existing) : '');
  await prefetchLeafScopePaths(incomingLeafId);
  for (const row of activeForParent) await prefetchLeafScopePaths(readDelegationWorkflowLeafIdFromRow(row));
  const width = resolveDelegationParentWidth({
    active: activeForParent,
    incomingAssignment: input.incomingAssignment,
    resumeDelegationId: input.resumeDelegationId,
    gate: input.gate,
    ignoreQueued,
    incomingLeafId,
    resolveLeafScopePaths,
    fanout: /** @type {any} */ (settings.effective.review_fanout),
    parallelImplementFanout: /** @type {any} */ (settings.effective.parallel_implement_fanout),
  });
  if (!width.ok) {
    const inspected = inspectDelegationSlot(width.blocker);
    return {
      ...slotConflict(inspected, width.code, width.error),
      code: width.code,
      delegation: width.blocker,
    };
  }
  /** @type {any} */ const workspace = resolveDelegationWorkspaceWriteConflict({
    active: occupied,
    workspaceFolder: input.workspaceFolder,
    executionFolder: input.executionFolder,
    parentChatId: input.parentChatId,
    rootDelegationId,
    incomingAssignment: input.incomingAssignment,
    resumeDelegationId: input.resumeDelegationId,
  });
  if (!workspace.ok) {
    const inspected = inspectDelegationSlot(workspace.blocker);
    return {
      ...slotConflict(inspected, workspace.code, workspace.error),
      code: workspace.code,
      delegation: workspace.blocker,
    };
  }
  /** @type {any} */ const treeSlots = resolveDelegationTreeSlots({
    active: occupied,
    rootDelegationId,
    resumeDelegationId: input.resumeDelegationId,
    limit: /** @type {any} */ (settings.effective.tree_slot_limit),
  });
  if (!treeSlots.ok) {
    const inspected = inspectDelegationSlot(treeSlots.blocker);
    return {
      ...slotConflict(inspected, treeSlots.code, treeSlots.error),
      code: treeSlots.code,
      delegation: treeSlots.blocker,
    };
  }
  /** @type {any} */ const global = resolveDelegationGlobalLimit({
    active: occupied,
    resumeDelegationId: input.resumeDelegationId,
  });
  if (!global.ok) {
    const inspected = inspectDelegationSlot(global.blocker);
    return {
      ...slotConflict(inspected, global.code, global.error),
      code: global.code,
      delegation: global.blocker,
    };
  }
  return null;
}

/**
 * Depth of the parent's queue (durable `queued` rows only), oldest-first.
 *
 * @param {string} parentChatId
 * @returns {number}
 */
function queuedDepthForController(parentChatId) {
  return listQueuedForControllerSorted(parentChatId).length;
}

/**
 * @param {DelegationRow} a
 * @param {DelegationRow} b
 * @returns {number}
 */
function compareQueuedDelegations(a, b) {
  const byTime = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  if (byTime !== 0) return byTime;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * @param {string} parentChatId
 * @returns {any[]}
 */
function listQueuedForControllerSorted(parentChatId) {
  return /** @type {DelegationRow[]} */ (listDelegationsForController(parentChatId))
    .filter((row) => String(row.status || '') === 'queued')
    .sort(compareQueuedDelegations);
}

/**
 * @param {any} row
 * @returns {boolean}
 */
function isQueuedHeadForController(row) {
  if (!row?.id || String(row.status || '') !== 'queued') return true;
  const controllerChatId = delegationController(row);
  if (!controllerChatId) return true;
  const head = listQueuedForControllerSorted(controllerChatId)[0];
  return head?.id === row.id;
}

/**
 * Hard rejection when a parent's queue is already at `CRETLI_DELEGATION_QUEUE_MAX`.
 *
 * @param {any} conflict a queueable parent-width conflict
 * @param {number} queueMax
 * @returns {{ ok: false, status: number, code: string, error: string, id: string, delegationId: string }}
 */
function queueFullConflict(conflict, queueMax) {
  const blockerId = String(conflict?.delegationId || conflict?.id || '').trim();
  return /** @type {any} */ ({
    ok: false,
    status: 409,
    code: 'queue_full',
    error: `The delegation queue for this parent is full (max ${queueMax}). Retry once a slot frees or raise CRETLI_DELEGATION_QUEUE_MAX.`,
    delegationId: blockerId,
    id: blockerId,
    blocker: conflict?.delegation || null,
  });
}

/**
 * Clear the parent slot after the child run is confirmed idle.
 *
 * @param {any} row
 * @returns {any}
 */
export function releaseDelegationRunSlot(row) {
  if (!row?.id) return row || null;
  if (isCancelUnconfirmedDelegationSlot(row)) return row;
  if (!String(row.runStoppingAt || '').trim()) return row;
  if (hasInFlightDelegationStart(row.id)) return row;
  const idle = isChatRunConfirmedIdle({ chatId: row.childChatId, runId: row.runId });
  const staleTerminal = isTerminalDelegationStatus(row.status) && isStaleTerminalRunStopping(row);
  if (!idle && !staleTerminal) return row;
  const released = /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { runStoppingAt: '', idleObservedAt: '' })) || row;
  void delegationService.drainQueue({ parentChatId: delegationController(released) }).catch(() => {});
  return released;
}

/** @type {Map<string, { timer: ReturnType<typeof setTimeout>, runId: string }>} */
const pendingChildRunStops = new Map();

/**
 * Ingest window for Cursor to receive the MCP `delegation_reply` tool result
 * before Cretli aborts the leftover executor run. This is not an SLA: quiet
 * rewrite hides `runCancelled` independently of the timer. The timer stores
 * `{ timer, runId }` and adapters fence on that runId / `finalReportRunId`.
 * `setImmediate` still races the MCP return and leaves the tool card running
 * while the UI shows a cancelled-run error.
 */
export const DELEGATION_CHILD_STOP_GRACE_MS = 2500;

/**
 * Stop the child run after the current MCP/HTTP turn. Awaiting cancel inside
 * `delegation_reply` deadlocks: the SDK run waits for the tool result, and
 * cancel waits for that same run.
 *
 * @param {{ chatId?: string, runId?: string, delegationId?: string }} input
 */
export function scheduleDelegationChildRunStop(input) {
  const chatId = String(input?.chatId || '').trim();
  const runId = String(input?.runId || '').trim();
  const delegationId = String(input?.delegationId || '').trim();
  if (!chatId) return;
  const previous = pendingChildRunStops.get(chatId);
  if (previous?.timer) clearTimeout(previous.timer);
  const timer = setTimeout(() => {
    const pending = pendingChildRunStops.get(chatId);
    pendingChildRunStops.delete(chatId);
    if (pending && runId && pending.runId && pending.runId !== runId) return;
    if (!isChatRunStillActive({ chatId, runId })) {
      if (delegationId) releaseDelegationRunSlot(/** @type {DelegationRow} */ (getDelegationById(delegationId)));
      return;
    }
    void cancelChatRun({ chatId, runId })
      .catch(() => {})
      .finally(() => {
        if (!delegationId) return;
        releaseDelegationRunSlot(/** @type {DelegationRow} */ (getDelegationById(delegationId)));
      });
  }, DELEGATION_CHILD_STOP_GRACE_MS);
  timer.unref?.();
  pendingChildRunStops.set(chatId, { timer, runId });
}

/**
 * Persist a child final_report: complete this attempt, keep the slot until
 * the run is idle, and never auto-ack reviewed.
 *
 * @param {{
 *   delegationId: string,
 *   attemptId: string,
 *   runId?: string,
 *   report?: string,
 *   taskOutcome?: string,
 *   mutateCurrent?: boolean,
 * }} input
 */
export async function acceptDelegationFinalReport(input) {
  const id = String(input?.delegationId || '').trim();
  const attemptId = String(input?.attemptId || '').trim();
  const current = id ? /** @type {DelegationRow} */ (getDelegationById(id)) : null;
  if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
  if (!attemptId) return { ok: true, skipped: true, reason: 'unassigned', delegation: current };
  if (input?.mutateCurrent === false || attemptId !== String(current.attemptId || '').trim()) {
    return { ok: true, skipped: true, reason: 'stale_attempt', delegation: current };
  }
  const requestedRunId = String(input?.runId || '').trim();
  const currentRunId = String(current.runId || '').trim();
  if (requestedRunId && currentRunId && requestedRunId !== currentRunId) {
    return { ok: true, skipped: true, reason: 'stale_run', delegation: current };
  }
  if (current.status === 'cancelled') {
    return { ok: true, skipped: true, reason: 'already_cancelled', delegation: current };
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    // The adapter can emit an empty terminal event before the MCP tool result
    // reaches us. A final report for this exact attempt is still authoritative
    // and may fill that terminal row, but it must never replace an existing
    // report or cross an attempt/run fence.
    const report = String(input.report || '').trim();
    if (!report || String(current.report || '').trim()) {
      return { ok: true, skipped: true, reason: 'already_terminal', delegation: current };
    }
    const resolved = resolveDelegationFinishReport({
      assignment: current.assignment,
      report,
      taskOutcome: input.taskOutcome,
      status: 'completed',
    });
    const assessment = assessDelegationReport(resolved.report);
    const reportVerdict = resolveEffectiveCodeReviewReportVerdict(
      { ...current, report: assessment.report },
      assessment.verdict,
    );
    const patched = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
      status: resolved.status,
      report: assessment.report,
      reportVerdict,
      reportDegraded: assessment.degraded,
      reportSummary: assessment.summary,
      ...buildReviewFindingsSummaryPatch(current, assessment.report),
      error: resolved.error,
      taskOutcome: normalizeDelegationTaskOutcome(resolved.taskOutcome),
      finalReportAcceptedAt: new Date().toISOString(),
      finalReportAttemptId: attemptId,
      finalReportRunId: requestedRunId || currentRunId,
    }, { expectedAttemptId: attemptId }));
    return {
      ok: true,
      skipped: false,
      accepted: resolved.status === 'completed',
      incomplete: resolved.incomplete,
      status: resolved.status,
      reportDegraded: resolved.degraded,
      delegation: patched || /** @type {DelegationRow} */ (getDelegationById(current.id)) || current,
    };
  }
  const resolved = resolveDelegationFinishReport({
    assignment: current.assignment,
    report: input.report,
    taskOutcome: input.taskOutcome,
    status: 'completed',
  });
  // Usage recorded so far for this attempt; the adapter finish that follows
  // the accepted report completes it via `applyLateDelegationMetrics`.
  // Only ledger-owned transports: for the others the adapter finish supplies
  // tokens (cache-inclusive for sdk/qwen) and a ledger value would swap source.
  const transport = String(current?.executor?.transport || '').trim().toLowerCase();
  const ledgerMetrics = (transport === 'claude' || transport === 'codex')
    ? /** @type {any} */ (readLedgerAttemptMetrics(current, attemptId))
    : null;
  const finished = finishDelegation(current, /** @type {any} */ ({
    status: resolved.status,
    report: resolved.report,
    error: resolved.error,
    taskOutcome: resolved.taskOutcome,
    enqueueParentReply: false,
    ...(ledgerMetrics && !isMetricsEmpty(ledgerMetrics) ? { metrics: /** @type {any} */ (ledgerMetrics) } : {}),
  }));
  await pendingTodoReviewSyncs.get(String(current.id));
  const rejected = resolved.incomplete || resolved.status !== 'completed';
  let holding = finished || current;
  if (!rejected) {
    // Release the parent slot in the same turn when the child run is already
    // confirmed idle; otherwise hold it with `runStoppingAt` and let the stop
    // watchdog clear it once the run actually ends. Freeing early lets
    // `inspectDelegationSlot(...).occupied` read false without waiting for the
    // 2500 ms grace and lets a queued sibling drain immediately.
    const runIdle = isChatRunConfirmedIdle({
      chatId: current.childChatId,
      runId: String(input.runId || current.runId || '').trim(),
    });
    holding = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
      runStoppingAt: runIdle ? '' : new Date().toISOString(),
      ...(runIdle ? { idleObservedAt: '' } : {}),
      finalReportAcceptedAt: new Date().toISOString(),
      finalReportAttemptId: attemptId,
      finalReportRunId: String(input.runId || current.runId || '').trim(),
    })) || holding;
    if (runIdle) {
      void delegationService.drainQueue({ parentChatId: delegationController(current) }).catch(() => {});
    }
  }
  await Promise.resolve().then(() => runDelegationCrashHook('after-final-report-result', holding));
  return {
    ok: true,
    skipped: false,
    accepted: !rejected,
    incomplete: resolved.incomplete,
    status: resolved.status,
    reportDegraded: resolved.degraded,
    delegation: /** @type {DelegationRow} */ (getDelegationById(current.id)) || holding,
  };
}

/** Guard against corrupted parent/child chat cycles while walking ancestors. */
const MAX_PARENT_CANCEL_WALK = 64;

/**
 * Whether the job that runs the given chat, or any ancestor job up the chain,
 * is being cancelled or already cancelled. Such a chat must not start new
 * children: they would outlive the cancelled tree as orphaned runs.
 *
 * @param {string} chatId
 * @returns {boolean}
 */
function isChatUnderCancelledDelegation(chatId) {
  const seen = new Set();
  let current = String(chatId || '').trim();
  for (let step = 0; current && step < MAX_PARENT_CANCEL_WALK; step += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const row = /** @type {DelegationRow} */ (findDelegationByChildChatId(current));
    if (!row) return false;
    if (
      row.status === 'cancelling'
      || row.status === 'cancelled'
      || String(row.runStoppingAt || '').trim()
    ) {
      return true;
    }
    current = String(row.parentChatId || '').trim();
  }
  return false;
}

/**
 * @param {any} parent
 * @returns {any}
 */
function validateDelegationParent(parent) {
  if (!parent) {
    return { ok: false, status: 404, error: 'Parent chat not found.', code: 'chat_not_found' };
  }
  if (parent.archived === true || isChatArchived(parent)) {
    return {
      ok: false,
      status: 409,
      error: 'Restore the parent chat before starting a delegation.',
      code: 'parent_archived',
    };
  }
  if (isChatUnderCancelledDelegation(parent.id)) {
    return {
      ok: false,
      status: 409,
      error: 'The parent delegation is being cancelled; it cannot start new children.',
      code: 'parent_cancelling',
    };
  }
  return { ok: true };
}

/**
 * Shared start/retry gates. Must run before the record is mutated.
 *
 * @param {{
 *   parent: object | null,
 *   executor?: { transport?: unknown, model?: unknown },
 *   isModelAvailable: (input: { transport: string, model: string }) => boolean,
 *   resolveCwd: (chat: object) => string,
 *   resolveExecutionFolder?: (chat: object) => string,
 * }} input
 */
function validateDelegationExecutorStart(input) {
  /** @type {any} */ const parent = input.parent;
  const parentGate = validateDelegationParent(parent);
  if (!parentGate.ok) return parentGate;
  if (isAskSdkMode(parent.sdkMode)) {
    return {
      ok: false,
      status: 409,
      error: ASK_GUARD_USER_MESSAGE,
      code: 'ask_mode_denied',
    };
  }
  const depthGate = evaluateDelegationDepthGate({
    parent,
    maxDepth: resolveDelegationMaxDepth(resolveDelegationEnv(input.resolveCwd(parent))),
  });
  if (!depthGate.ok) return depthGate;
  const cwd = input.resolveCwd(parent);
  if (!cwd) {
    return { ok: false, status: 400, error: 'Workspace folder is missing.', code: 'no_workspace' };
  }
  // The runner cwd may be a separate execution folder; it falls back to the
  // logical workspace so existing chats keep their previous behaviour.
  const executionFolder = typeof input.resolveExecutionFolder === 'function'
    ? String(input.resolveExecutionFolder(parent) || '').trim() || cwd
    : cwd;
  const transport = normalizeAgentTransport(input.executor?.transport);
  if (!hasChatRunAdapter(transport)) {
    return {
      ok: false,
      status: 400,
      error: `Executor ${transport} cannot run without an open browser in this version.`,
      code: 'executor_unavailable',
    };
  }
  const requestedModel = String(input.executor?.model || '').trim();
  const resolution = resolveDelegationModelDetailed({ transport, model: requestedModel });
  const model = resolution.model;
  if (resolution.code === 'effort_unavailable') {
    return {
      ok: false,
      status: 400,
      error: describeEffortUnavailable(resolution),
      code: 'effort_unavailable',
      requested_effort: resolution.requestedEffort,
      available_efforts: resolution.availableEfforts,
    };
  }
  if (!model || input.isModelAvailable({ transport, model }) === false) {
    return {
      ok: false,
      status: 400,
      error: describeUnavailableDelegationModel(/** @type {any} */ ({ transport, env: resolveDelegationEnv(cwd) })),
      code: 'model_unavailable',
    };
  }
  return {
    ok: true,
    cwd,
    executionFolder,
    transport,
    model,
    depth: depthGate.depth,
    rootChatId: depthGate.rootChatId,
    rootDelegationId: depthGate.rootDelegationId,
    allowChildDelegations: resolveChildDelegationGrant({
      parent,
      requested: /** @type {any} */ (input).allowChildDelegations,
    }),
  };
}

/**
 * @param {unknown} allowed
 * @param {unknown} depth
 * @param {unknown} [workspaceFolder]
 * @returns {{ allowed: boolean, depth: number, remainingDepth: number }}
 */
function buildChildDelegationPromptInput(allowed, depth, workspaceFolder) {
  const maxDepth = resolveDelegationMaxDepth(resolveDelegationEnv(workspaceFolder));
  return {
    allowed: normalizeAllowChildDelegations(allowed),
    depth: Number(depth) || 1,
    remainingDepth: remainingDelegationDepth({ depth: /** @type {any} */ (depth), maxDepth }),
  };
}

/**
 * @param {{ latest: Record<string, any>, started?: { runId?: string }, childChatId: string }} input
 * @returns {Promise<Record<string, any>>}
 */
async function stopAcceptedRunIfObsolete(input) {
  /** @type {any} */ const latest = input.latest;
  const childChatId = String(input.childChatId || latest?.childChatId || '').trim();
  const runId = String(input.started?.runId || latest?.runId || '').trim();
  if (!latest?.id || !childChatId) return latest;
  const shouldStop = isTerminalDelegationStatus(latest.status) || latest.status === 'cancelling';
  if (!shouldStop) return latest;
  try {
    await cancelChatRun({ chatId: childChatId, runId });
  } catch {
    // Best-effort stop of a late accept after cancel/finish.
  }
  /** @type {any} */ const after = /** @type {DelegationRow} */ (getDelegationById(latest.id)) || latest;
  const stillBusy = isChatRunStillActive({ chatId: childChatId, runId });
  if (after.status === 'cancelling' && !stillBusy && delegationHarnessSupportsAbort(after)) {
    return finishCancellingWithStopProof(after, {
      finishDelegation,
      status: 'cancelled',
      proofKind: 'adapter_abort',
      proofSource: 'stop_obsolete_run',
    }) || after;
  }
  return after;
}

/**
 * Revision key of the todo plan a plan-subject review is about: the todo named
 * by the workflow leaf id. Empty when the start is not a plan review, the todo
 * is not found, or it has no plan text (the recheck gate then allows the start).
 *
 * @param {{ assignment?: unknown, reviewSubject?: unknown, workspaceFolder?: unknown, leafId?: unknown }} input
 * @returns {Promise<string>}
 */
async function resolveReviewedTodoPlanRevisionKey(input) {
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return '';
  if (String(input.reviewSubject || '').trim().toLowerCase() !== 'plan') return '';
  const leafId = String(input.leafId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  if (!leafId || !workspaceFolder) return '';
  /** @type {any} */ const todo = await getTodoById(resolveDataPath(), workspaceFolder, leafId);
  if (!String(todo?.plan?.markdown || '').trim()) return '';
  return computeTodoPlanRevisionKey(todo);
}

/**
 * Content-only key of the reviewed todo plan (see `computeTodoPlanContentKey`);
 * the recheck gate compares this so a no-op plan save does not re-admit a rerun.
 *
 * @param {{ assignment?: unknown, reviewSubject?: unknown, workspaceFolder?: unknown, leafId?: unknown }} input
 * @returns {Promise<string>}
 */
async function resolveReviewedTodoPlanContentKey(input) {
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return '';
  if (String(input.reviewSubject || '').trim().toLowerCase() !== 'plan') return '';
  const leafId = String(input.leafId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  if (!leafId || !workspaceFolder) return '';
  /** @type {any} */ const todo = await getTodoById(resolveDataPath(), workspaceFolder, leafId);
  if (!String(todo?.plan?.markdown || '').trim()) return '';
  return computeTodoPlanContentKey(todo);
}

/**
 * Live leaf-scoped material revision of a code review start; empty when the
 * leaf has no captured material base (the gate then falls back to delegation rows).
 *
 * @param {{ assignment?: unknown, reviewSubject?: unknown, workspaceFolder?: unknown, executionFolder?: unknown, leafId?: unknown }} input
 * @returns {Promise<string>}
 */
async function resolveReviewedLeafMaterialRevision(input) {
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return '';
  if (String(input.reviewSubject || '').trim().toLowerCase() !== 'code') return '';
  const leafId = String(input.leafId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  if (!leafId || !workspaceFolder) return '';
  const todo = await getTodoById(resolveDataPath(), workspaceFolder, leafId);
  return readLeafScopedMaterialRevisionForTodo(todo, String(input.executionFolder || workspaceFolder).trim());
}

/**
 * @param {any} deps
 */
export function createDelegationService(deps = {}) {
  const resolveCwd = typeof deps.workspaceDirForAgent === 'function'
    ? (chat) => resolveSdkCwdForChat(chat, deps.workspaceDirForAgent)
    : (chat) => String(chat?.workspaceFolder || '').trim();
  const resolveExecutionFolder = typeof deps.executionFolderForAgent === 'function'
    ? deps.executionFolderForAgent
    : (chat) => resolveExecutionFolderForChat(chat, deps.workspaceDirForAgent);
  const isModelAvailable = typeof deps.isModelAvailable === 'function'
    ? deps.isModelAvailable
    : isDelegationModelAvailable;

  const readChatCacheView = typeof deps.buildChatCacheView === 'function'
    ? deps.buildChatCacheView
    : buildChatCacheView;

  /**
   * Cold-cache guard: only a cold cache that expired by TTL rejects a source;
   * warm, unknown and every other cold reason (epoch change, restart) fail open.
   *
   * @param {string} chatId
   * @returns {boolean}
   */
  function isCacheExpiredByTtl(chatId) {
    try {
      const cache = readChatCacheView(chatId, { dataDir: deps.dataDir })?.freshness?.cache;
      return String(cache?.state || '') === 'cold' && String(cache?.reason || '') === 'ttl_expired';
    } catch {
      return false;
    }
  }

  /**
   * Reason code of the first fail-safe guard hit by a work-resume candidate,
   * or '' when none applies.
   *
   * @param {string} sourceId
   * @param {any[]} delegations
   * @param {string} parentChatId
   * @returns {string}
   */
  function readWorkResumeGuardReason(sourceId, delegations, parentChatId) {
    const source = delegations.find((row) => String(row?.id || '') === sourceId);
    const chatId = String(source?.childChatId || '');
    if (chatId && isCacheExpiredByTtl(chatId)) return SESSION_RESUME_REASON.WORK_CACHE_EXPIRED;
    if (hasEmptyResumedReport({ delegations, sourceId, parentChatId })) {
      return SESSION_RESUME_REASON.WORK_PREVIOUS_EMPTY_REPORT;
    }
    return '';
  }

  /**
   * Try the resume candidates in order (explicit pointer alone; otherwise the
   * same-role source, then cross-role sources) until one resumes. Fail-safe
   * guards run per candidate before the gate: on every candidate of a work role
   * or when the cross-role setting is on, otherwise only on cross-role
   * candidates; an explicit pointer is exempt. When
   * none resumes, the FIRST candidate's refusal is recorded; with no candidate
   * the gate's "not requested" result lets the policy reason stand.
   *
   * @param {{ explicitSource: string, sameRoleSource: string, crossRoleSources: string[], guardEverySource: boolean, parentChatId: string }} plan
   * @param {any} gateInput `inspectDelegationSessionResume` input without `resumeSessionOf`
   * @returns {ReturnType<typeof inspectDelegationSessionResume>}
   */
  function decideSessionResumeCandidates(plan, gateInput) {
    const delegations = gateInput.delegations;
    if (plan.explicitSource) return inspectDelegationSessionResume({ ...gateInput, resumeSessionOf: plan.explicitSource });
    const candidates = [plan.sameRoleSource, ...plan.crossRoleSources]
      .filter((id, index, list) => id && list.indexOf(id) === index);
    let firstRefusal = null;
    for (const candidateId of candidates) {
      const guarded = plan.guardEverySource || candidateId !== plan.sameRoleSource;
      const guardReason = guarded ? readWorkResumeGuardReason(candidateId, delegations, plan.parentChatId) : '';
      const decision = guardReason
        ? buildPolicyReuseDecision(guardReason)
        : inspectDelegationSessionResume({ ...gateInput, resumeSessionOf: candidateId });
      if (decision.resume) return decision;
      firstRefusal = firstRefusal || decision;
    }
    return firstRefusal || inspectDelegationSessionResume({ ...gateInput, resumeSessionOf: '' });
  }

  /**
   * Best-effort: record the executor chat in the parent todo's chat history.
   * Linking never bumps the todo revision.
   *
   * @param {any} child
   * @param {any} parent
   */
  async function linkChildChatToTodo(child, parent) {
    const todoId = String(parent?.todoId || '').trim();
    const dataDir = String(deps.dataDir || '').trim();
    if (!todoId || !child?.id || !dataDir) return;
    const cwd = resolveCwd(child);
    if (!cwd) return;
    try {
      await linkTodoChat(dataDir, cwd, todoId, child.id);
    } catch {
      // Linking is bookkeeping; a failure must not abort the delegation.
    }
  }

  /**
   * @param {any} input
   */
  async function createAndStart(input) {
    const takeoverConflict = takeoverInProgressResult({ chatId: input?.parentChatId, leafId: normalizeDelegationWorkflowLeafId(input) });
    if (takeoverConflict) return takeoverConflict;
    if (!isDelegationRuntimeAcceptingWork()) {
      return {
        ok: false,
        status: 503,
        error: 'Delegation runtime is not ready to accept new jobs.',
        code: 'runtime_not_ready',
        state: getDelegationLifecycleState(),
      };
    }
    if (!canAcceptNewRun()) return updateOperationConflict();
    const parentChatId = String(input?.parentChatId || '').trim();
    const idempotencyKey = String(input?.idempotencyKey || '').trim();
    if (!parentChatId) {
      return { ok: false, status: 400, error: 'Parent chat is required.', code: 'parent_required' };
    }
    if (isDelegationPickReasonTooLong(input?.pickReason)) {
      return {
        ok: false,
        status: 400,
        error: `pickReason must be at most ${MAX_DELEGATION_PICK_REASON_LENGTH} characters.`,
        code: 'pick_reason_too_long',
      };
    }
    const pickReason = normalizeDelegationPickReason(input?.pickReason);
    const pickId = String(input?.pickId || input?.pick_id || '').trim();
    const manualSource = String(input?.manualSource || input?.manual_source || input?.pickOrigin || input?.pick_origin || '').trim();
    const pickFallbackFrom = String(input?.pickFallbackFrom || input?.pick_fallback_from || '').trim();
    if (pickId && !idempotencyKey) {
      // Without a key the slot cannot be reserved, so the pick would back
      // unlimited starts. Refuse instead of recording an unbounded `auto`.
      return {
        ok: false,
        status: 400,
        error: 'idempotency_key is required when starting from a pick_id.',
        code: 'idempotency_key_required',
      };
    }
    return withParentLock(parentChatId, async () => {
      const parent = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === parentChatId);
      const startGate = validateDelegationExecutorStart(/** @type {any} */ ({
        parent,
        executor: input?.executor,
        isModelAvailable,
        resolveCwd,
        resolveExecutionFolder,
        allowChildDelegations: input?.allowChildDelegations ?? input?.allow_child_delegations,
      }));
      if (!startGate.ok) {
        return parent ? startGate : { ok: false, status: 404, error: 'Chat not found.', code: 'chat_not_found' };
      }
      const requestedExecutionMode = input?.executionMode;
      // Keep the caller's role before assignment normalization. The legacy
      // alias `assignment=plan` remains a plan review; explicit plan authoring
      // is `assignment=implement` plus `requested_role=plan`.
      const requestedRoleRaw = String(
        input?.requestedRole || input?.requested_role || input?.assignment || '',
      ).trim().toLowerCase();
      const requestedAssignment = normalizeDelegationAssignment(
        input?.assignment,
        requestedExecutionMode || parent.sdkMode,
      );
      const isPlanAuthoringRequest = requestedRoleRaw === 'plan'
        && String(input?.assignment || '').trim().toLowerCase() === 'implement';
      const executionMode = resolveDelegationChildExecutionMode(
        isPlanAuthoringRequest ? 'plan' : requestedExecutionMode,
        requestedAssignment,
        parent.sdkMode,
      );
      const assignment = requestedAssignment;
      const { validateWorkspaceWatcherParentDelegation } = await import('./workspace-watcher-delegation-guard.js');
      const watcherGate = await validateWorkspaceWatcherParentDelegation({
        parentChatId,
        executor: input?.executor,
        assignment: isPlanAuthoringRequest ? 'plan' : assignment,
        reviewSubject: input?.reviewSubject ?? input?.review_subject,
        dataDir: resolveDataPath(),
      });
      if (!watcherGate.ok) {
        return watcherGate;
      }
      const cwd = startGate.cwd;
      const executionFolder = startGate.executionFolder || cwd;
      const sourceKind = normalizeDelegationSourceKind(input?.sourceKind);
      // The review subject is explicit and persisted (`docs/todo-review-contract.md`
      // §3). A plan-mode review is one requested as plan (`requested_role=plan`
      // or `execution_mode=plan`); an absent value defaults to `plan` there and
      // to `other` otherwise, and a legacy record is never read as `code`.
      const reviewSubject = resolveDelegationReviewSubject({
        requested: input?.reviewSubject ?? input?.review_subject,
        assignment,
        // The child execution mode is forced to agent for reviews, so the
        // requested plan intent must be read before that override.
        executionMode: requestedExecutionMode || parent.sdkMode,
        requestedRole: requestedRoleRaw,
      });
      let planDoc = { revision: 0, contentHash: '', body: '' };
      let sourceHistorySeq = 0;
      let sourceCreatedAt = '';
      let sourceText = '';
      let sourceHash = '';
      if (sourceKind === 'message') {
        /** @type {any} */ const found = await resolveHistoryMessageSource(parentChatId, {
          historySeq: input.historySeq,
          contentHash: input.contentHash,
        });
        if (!found.ok) {
          return { ok: false, status: 409, error: found.error, code: found.code };
        }
        sourceHistorySeq = found.seq;
        const rec = found.rec && typeof found.rec === 'object'
          ? /** @type {Record<string, unknown>} */ (found.rec)
          : null;
        sourceCreatedAt = rec && typeof rec.createdAt === 'string' ? rec.createdAt : '';
        sourceText = found.text;
        sourceHash = found.contentHash;
      } else if (sourceKind === 'text') {
        sourceText = String(input?.taskText || '').trim();
        if (!sourceText) {
          return {
            ok: false,
            status: 400,
            error: 'task_text is required for a text delegation.',
            code: 'source_unavailable',
          };
        }
        sourceHash = hashDelegationContent(sourceText);
        const expected = String(input?.contentHash || '').trim();
        if (expected && expected !== sourceHash) {
          return {
            ok: false,
            status: 409,
            error: 'The task text changed. Refresh and try again.',
            code: 'source_changed',
          };
        }
      } else {
        planDoc = readChatPlanDocument({ cwd, chatId: parentChatId });
        if (!planDoc.body) {
          return { ok: false, status: 400, error: 'No complete plan is saved for this chat.', code: 'plan_missing' };
        }
        const expectedRevision = Number(input.planRevision);
        if (Number.isFinite(expectedRevision) && expectedRevision > 0 && planDoc.revision !== expectedRevision) {
          return {
            ok: false,
            status: 409,
            error: 'The plan changed. Refresh the preview and try again.',
            code: 'plan_revision_conflict',
            plan: planDoc,
          };
        }
        sourceHash = String(planDoc.contentHash || '').trim() || hashDelegationContent(planDoc.body);
        sourceText = '';
      }
      /** @type {any} */ const leafContext = await resolveRequestLeafContext({
        input,
        parentChatId,
        workspaceFolder: cwd,
        dataDir: resolveDataPath(),
        sourceText,
        purpose: 'delegation_start',
        parentTodoId: parent?.todoId,
      });
      if (!leafContext.ok) {
        return {
          ok: false,
          status: leafContext.status || 400,
          error: leafContext.error,
          code: leafContext.code,
        };
      }
      const workflowLeafId = String(leafContext.leafId || '').trim();
      if (workflowLeafId && assignment !== 'review' && !isPlanAuthoringRequest) {
        const todos = (await listTodos(resolveDataPath(), cwd)).items;
        const selected = todos.find((item) => item.id === workflowLeafId);
        if (selected && isFeedbackDerivedTodo(todos, selected)
          && !String(selected.plan?.approvedAt || '').trim()) {
          return { ok: false, status: 409, code: 'feedback_plan_required',
            error: 'Feedback-derived todo needs its own approved plan before implementation.' };
        }
      }
      const transport = startGate.transport;
      const requestedModel = String(input?.executor?.model || '').trim();
      const model = startGate.model;
      // Refuse a code review that cannot be counted as independent (same base
      // model + harness as the implementer or the orchestrator) before any run, and before the
      // bounded host-verify wait below so an invalid review fails immediately.
      const independenceGate = inspectReviewIndependence({
        controllerChatId: parentChatId,
        assignment,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        executor: { transport, model },
        allowSameModel: input?.allowSameModelReview === true,
        controller: {
          harness: parent.agentTransport || parent.harness || parent.transport || '',
          model: parent.model,
        },
      });
      if (!independenceGate.ok) return independenceGate;
      // Host-verify policy for a review child: the effective (prior + observed)
      // `review_can_run_tests` trait decides whether the parent owes a
      // `delegation_verify`. Persisted once so the workflow gate reads one flag.
      const reviewVerifyPlan = resolveDelegationReviewVerifyPlan({
        assignment,
        executionMode,
        transport,
        reviewSubject: reviewSubject.subject,
        hasVerifyTests: resolveDefaultReviewVerifyIds(cwd).length > 0,
        rows: /** @type {DelegationRow[]} */ (loadDelegations()),
      });
      // Trusted server-side envelope: only in-process/route callers can set it,
      // never the request body (routes copy named fields only).
      const trustedStart = input?.trustedStart && typeof input.trustedStart === 'object' ? input.trustedStart : {};
      // Prefetched through the async facade: the context resolver takes synchronous callbacks.
      /** @type {any[]} */ let startContextTodos = [];
      try {
        startContextTodos = (await listTodos(resolveDataPath(), cwd)).items;
      } catch { /* evidence lookup is best-effort, like the sync probe it replaces */ }
      const startContext = resolveDelegationStartContext({
        parent,
        dataDir: resolveDataPath(),
        isWatcherCycleChat: (chatId, folder) => getWorkspaceWatcherActiveCycles(
          getWorkspaceWatcher(folder || cwd, { dataDir: resolveDataPath() }),
        ).some((/** @type {any} */ cycle) => String(cycle?.chatId || '').trim() === chatId),
        isTodoExecutionChat: (row) => Boolean(String(row.todoId || '').trim())
          && startContextTodos.some((item) => (
            String(item?.id || '') === String(row.todoId || '').trim()
            && String(/** @type {any} */ (item)?.chatId || '').trim() === row.id
          )),
      });
      const isAutomaticStart = startContext.context === DELEGATION_START_CONTEXTS.automatic;
      const uiActionId = String(trustedStart.uiActionId || '').trim();
      const workRole = classifyDelegationWorkRole({
        rawAssignment: input?.assignment,
        assignment,
        requestedRole: requestedRoleRaw,
        reviewSubject: reviewSubject.subject,
      });
      const continuationOf = String(input?.continuationOf || input?.continuation_of || '').trim();
      // In an automatic context a free-text marker is never a manual choice;
      // only a single-use UI action proof (verified after the idempotency
      // replay) turns a direct selection into `manual`.
      const classifiedManualSource = uiActionId ? 'ui' : isAutomaticStart ? '' : manualSource;
      /** @type {any} */ const pickLink = resolveDelegationPickLinkFields({
        pickId,
        harness: transport,
        model,
        assignment,
        executionMode,
        role: requestedRoleRaw === 'fix' || requestedRoleRaw === 'plan' ? requestedRoleRaw : '',
        manualSource: classifiedManualSource,
        pickFallbackFrom,
        fallbackFromRecord: pickFallbackFrom ? /** @type {DelegationRow} */ (getDelegationById(pickFallbackFrom)) : null,
        parentChatId,
        workspaceFolder: cwd,
        leafId: workflowLeafId,
      });
      // The hash stores the starter's identity (`parentChatId`). A replay from a
      // moved controller is compared with the hash of the original starter, so
      // the same request is not an idempotency conflict after a takeover.
      const buildRequestHash = (hashParentChatId) => buildDelegationRequestHash({
        parentChatId: hashParentChatId,
        sourceKind,
        sourceHistorySeq,
        planRevision: sourceKind === 'plan' ? planDoc.revision : 0,
        sourceHash,
        harness: transport,
        model: requestedModel,
        executionMode,
        assignment,
        workRole,
        extraInstructions: input.extraInstructions,
        allowChildDelegations: startGate.allowChildDelegations,
      });
      const requestHash = buildRequestHash(parentChatId);
      if (idempotencyKey) {
        const existing = /** @type {DelegationRow} */ (findDelegationByIdempotencyKey(idempotencyKey));
        if (existing) {
          if (delegationController(existing) !== parentChatId) {
            return {
              ok: false,
              status: 409,
              error: 'Idempotency key belongs to another chat.',
              code: 'idempotency_conflict',
            };
          }
          const storedHash = String(existing.requestHash || '').trim();
          const replayHash = existing.parentChatId && existing.parentChatId !== parentChatId
            ? buildRequestHash(String(existing.parentChatId).trim())
            : requestHash;
          if (storedHash && storedHash !== requestHash && storedHash !== replayHash) {
            return {
              ok: false,
              status: 409,
              error: 'Idempotency key was used with different parameters.',
              code: 'idempotency_conflict',
            };
          }
          return resumeExistingDelegation(existing, parent, {
            cwd,
            executionFolder,
            sourceKind,
            sourceText: existing.sourceText || sourceText,
            planMarkdown: existing.planMarkdown || planDoc.body,
            extraInstructions: existing.extraInstructions,
            executionMode: existing.executionMode || executionMode,
            assignment: existing.assignment || assignment,
          });
        }
      }
      if (pickFallbackFrom) {
        const predecessor = /** @type {DelegationRow} */ (getDelegationById(pickFallbackFrom));
        const failure = classifyDelegationFailure(predecessor || {});
        if (predecessor?.status === 'failed' && (failure.failureClass === 'unknown' || predecessor?.pickOriginDetail === 'fallback')) {
          return { ok: false, status: 409, code: 'fallback_not_allowed', error: 'No infrastructure fallback is justified for this attempt.' };
        }
        // A missing verdict justifies one audited replacement only for a code
        // review of the same controller/leaf/material; other classes keep their rules.
        if (predecessor?.status === 'failed' && failure.failureClass === 'no_verdict'
          && !evaluateNoVerdictReviewFallback({
            predecessor,
            parentChatId,
            leafId: workflowLeafId,
            assignment,
            reviewSubject: reviewSubject.subject,
            delegations: /** @type {DelegationRow[]} */ (loadDelegations()),
          }).ok) {
          return { ok: false, status: 409, code: 'fallback_not_allowed', error: 'No infrastructure fallback is justified for this attempt.' };
        }
        if (predecessor?.status === 'failed' && (!pickId || pickId === predecessor.pickId)) {
          return { ok: false, status: 409, code: 'fallback_requires_new_pick', error: 'A fallback requires a fresh model_pick decision.' };
        }
        // Serialized by the controller lock, across all pick ids and queue states.
        // The claim is per predecessor attempt; a legacy claim without an attempt id
        // covers every attempt of that predecessor.
        const predecessorAttemptId = String(predecessor?.attemptId || '').trim();
        if (/** @type {DelegationRow[]} */ (loadDelegationsReadonly()).some((row) => row.pickFallbackFrom === pickFallbackFrom
          && (!row.pickFallbackFromAttemptId || row.pickFallbackFromAttemptId === predecessorAttemptId))) {
          return { ok: false, status: 409, code: 'fallback_already_used', error: 'This role attempt already used its fallback.' };
        }
      }
      // Start-side gates shared with `model_pick`: a named executor must not
      // bypass the flash-review rule, the adapter guarantee, the premium review
      // justification, or an active lockout/quota on the requested pair. Run
      // after the idempotency replay so a repeated request returns its existing
      // job even if the confirmation flag is omitted on the retry. `fix` is kept
      // explicit because assignment normalization folds it into implement.
      const gateRole = requestedRoleRaw === 'fix' || requestedRoleRaw === 'plan'
        ? requestedRoleRaw
        : resolveDelegationGateRole({
        assignment,
        executionMode,
      });
      const startRole = resolveDelegationPickRole(
        assignment,
        executionMode,
        requestedRoleRaw === 'fix' || requestedRoleRaw === 'plan' ? requestedRoleRaw : '',
      );
      let continuation = null;
      // `continuation_of` is evidence of a MODEL choice (pick affinity), not a
      // chat resume; the chat-continuation switches are applied further down,
      // after the executor is settled.
      if (continuationOf) {
        const checkedContinuation = validateDelegationContinuation({
          continuationOf,
          previous: /** @type {DelegationRow} */ (getDelegationById(continuationOf)),
          parentChatId,
          leafId: workflowLeafId,
          role: startRole,
          harness: transport,
          model,
        });
        if (!checkedContinuation.ok) {
          return { ok: false, status: 409, error: checkedContinuation.error, code: checkedContinuation.code };
        }
        continuation = { continuationOf };
      }
      const uiActionBinding = {
        id: uiActionId,
        actor: trustedStart.actor,
        parentChatId,
        workspaceFolder: cwd,
        role: startRole,
        harness: transport,
        model,
        taskHash: hashDelegationUiActionTask(sourceKind === 'plan' ? planDoc.body : sourceText),
        dataDir: resolveDataPath(),
      };
      let uiActionProof = false;
      if (isAutomaticStart || uiActionId) {
        if (uiActionId) {
          if (String(trustedStart.actor || '').trim().toLowerCase() !== 'human') {
            return {
              ok: false,
              status: 403,
              error: 'UI actions can only be used from the human UI channel.',
              code: 'ui_action_forbidden',
            };
          }
          const checkedAction = inspectDelegationUiAction(uiActionBinding);
          if (!checkedAction.ok) {
            return { ok: false, status: 403, error: checkedAction.error, code: checkedAction.code };
          }
          uiActionProof = true;
        } else if (!continuation) {
          if (!pickId) {
            return {
              ok: false,
              status: 409,
              error: manualSource
                ? 'A manual_source marker does not exempt an automatic orchestrator start; call model_pick and pass its pick_id, or continue a completed assignment with continuation_of.'
                : 'An automatic orchestrator start needs a current pick_id (from model_pick) or continuation_of.',
              code: 'automatic_start_requires_pick',
              startContext: startContext.context,
            };
          }
          if (pickLink.pickLinkStatus !== 'linked' || pickLink.pickOrigin !== 'auto') {
            return {
              ok: false,
              status: 409,
              error: `The pick_id cannot back this start (${pickLink.pickRejectReason || 'rejected link'}); call model_pick again.`,
              code: 'automatic_pick_rejected',
              reason: pickLink.pickRejectReason || 'rejected-link',
              startContext: startContext.context,
            };
          }
        }
      }
      if (continuation && !pickId && !uiActionProof) {
        // Auditable continuation: never fabricated as auto or manual.
        pickLink.pickOrigin = 'unknown';
        pickLink.pickOriginDetail = 'continuation';
        pickLink.pickLinkStatus = 'continuation';
        pickLink.pickRole = startRole;
      }
      const activeUsageLimits = safeListHarnessUsageLimits(cwd);
      // A continuation is not a human choice: current lockouts still apply.
      const explicitNamedStart = !pickId && !(continuation && !uiActionProof);
      const startupLockoutWarning = explicitNamedStart
        ? readActiveStartupFailureLockoutWarning(transport, model, activeUsageLimits)
        : null;
      const modelGate = evaluateDelegationStartHardGates({
        ...(await buildNamedDelegationStartHardGateInputAsync(/** @type {any} */ ({
          role: gateRole,
          harness: transport,
          model,
          sourceKind,
          pickReason,
          leafId: workflowLeafId,
          sourceText,
          parentTodoId: parent?.todoId,
          // Workspace-aware existence check so a leaf body naming only
          // non-existent paths is treated as having no file list (= large).
          exists: cwd
            ? (relativePath) => {
              try {
                return existsSync(resolvePath(cwd, String(relativePath || '').trim()));
              } catch {
                return false;
              }
            }
            : undefined,
          allowFlashReview: input?.allowFlashReview === true || input?.allow_flash_review === true,
          allowPremium: input?.allowPremium === true || input?.allow_premium === true,
          lockouts: activeUsageLimits,
          usageLimits: activeUsageLimits,
          permitStartupFailureLockoutOverride: explicitNamedStart,
          // Re-read the audited overrides at start so a TTL that lapsed after
          // the pick still removes the pair here.
          workspaceFolder: cwd,
        }))),
      });
      if (!modelGate.ok) return modelGate;
      if (workRole === 'plan') {
        const plannerGate = assertPlannerAdapterAllowed(transport, {
          env: resolveDelegationEnv(cwd),
        });
        if (!plannerGate.ok) return plannerGate;
      }
      const workflowGate = inspectDelegationWorkflowStart(/** @type {any} */ ({
        parentChatId,
        leafId: workflowLeafId,
        assignment,
        resumeRounds: input.resumeRounds ?? input.resume_rounds,
        maxRounds: input.maxRounds ?? input.max_rounds,
      }));
      if (!workflowGate.ok) return workflowGate;
      // Reserve admission before the async prompt extras read. Without this
      // reservation two parents can both pass the workspace/global checks,
      // and a fast first run can even finish before the second one rechecks.
      const admissionId = randomUUID();
      const admissionRow = {
        id: admissionId,
        parentChatId,
        workspaceFolder: cwd,
        executionFolder,
        assignment,
        executionMode,
        status: 'starting',
      };
      const pendingAdmissions = [...pendingStartAdmissions.values()];
      /** @type {any} */ const admissionWorkspace = resolveDelegationWorkspaceWriteConflict({
        active: pendingAdmissions,
        workspaceFolder: cwd,
        executionFolder,
        parentChatId,
        incomingAssignment: delegationRuntimeAssignment({ assignment, workRole }),
      });
      if (!admissionWorkspace.ok) {
        return slotConflict(admissionWorkspace.blocker, admissionWorkspace.code, admissionWorkspace.error);
      }
      /** @type {any} */ const admissionGlobal = resolveDelegationGlobalLimit({
        active: [...listOccupiedDelegations(), ...pendingAdmissions],
      });
      if (!admissionGlobal.ok) {
        return slotConflict(admissionGlobal.blocker, admissionGlobal.code, admissionGlobal.error);
      }
      pendingStartAdmissions.set(admissionId, admissionRow);
      try {
      const reviewExtras = await readExecutorPromptExtras({
        parentChatId,
        leafId: workflowLeafId,
        cwd,
        assignment,
        executionMode,
        workRole,
        reviewSubject: reviewSubject.subject,
      });
      const codeReviewGate = inspectDelegationCodeReviewStart({
        assignment,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        workflow: reviewExtras.workflowRow,
        workspaceFolder: cwd,
        resumeRounds: input.resumeRounds ?? input.resume_rounds,
      });
      if (!codeReviewGate.ok) return codeReviewGate;
      const planReviewerSessionId = String(
        input?.planReviewerSessionId ?? input?.plan_reviewer_session_id ?? '',
      ).trim();
      const planReviewerPhase = String(
        input?.planReviewerPhase ?? input?.plan_reviewer_phase ?? 'independent',
      ).trim() || 'independent';
      const planReviewerGate = await inspectPlanReviewerDelegationStart({
        planReviewerSessionId,
        planReviewerPhase,
        reviewSubject: reviewSubject.subject,
      });
      if (!planReviewerGate.ok) return planReviewerGate;
      /** @type {any} */ const promptBuilt = buildDelegationExecutorPrompt(/** @type {any} */ ({
        sourceKind,
        planMarkdown: planDoc.body,
        taskText: sourceText,
        parentChatId,
        sourceHistorySeq,
        workspaceFolder: executionFolder,
        extraInstructions: [
          mergePlanReviewerDelegationExtraInstructions(input.extraInstructions, {
            planReviewerSessionId,
            planReviewerPhase,
          }),
          await buildImplementVerifyEvidenceBlock({
            assignment,
            reviewSubject: reviewSubject.subject,
            parentChatId,
            leafId: workflowLeafId,
          }),
        ].filter(Boolean).join('\n\n'),
        executionMode,
        reviewCanRunTests: reviewVerifyPlan.canRunTests,
        assignment,
        workRole,
        childDelegation: buildChildDelegationPromptInput(startGate.allowChildDelegations, startGate.depth, cwd),
        workflowRow: reviewExtras.workflowRow,
        leafAcceptanceText: reviewExtras.leafAcceptanceText,
        leafMaterialText: reviewExtras.leafMaterialText,
        watcherFindingsText: reviewExtras.watcherFindingsText,
        openLedgerFindings: reviewExtras.openLedgerFindings,
        reviewMode: codeReviewGate.mode,
      }));
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      // The adapter guarantee already ran inside `evaluateDelegationStartHardGates`
      // (review and plan roles); reuse its `reviewUncertified` flag so the
      // caller still learns when the run only started because of the opt-in.
      const reviewGate = assignment === 'review'
        ? { ok: true, reviewUncertified: modelGate.reviewUncertified === true }
        : { ok: true };
      if (!reviewGate.ok) return reviewGate;
      // Waits (bounded) for a running host verify instead of failing with 409.
      const implementVerifyGate = await waitForImplementVerifyBeforeReview({
        parentChatId,
        assignment,
        executionMode,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        allowVerifyFailedReview: input?.allowVerifyFailedReview === true
          || input?.allow_verify_failed_review === true,
      });
      if (!implementVerifyGate.ok) return implementVerifyGate;
      // Material key of a plan review: the plan of the todo named by the leaf
      // id, independent of the delegation source kind (real plan reviews start
      // from task_text). Empty when the todo or its plan is missing.
      const todoPlanRevisionKey = await resolveReviewedTodoPlanRevisionKey({
        assignment,
        reviewSubject: reviewSubject.subject,
        workspaceFolder: cwd,
        leafId: workflowLeafId,
      });
      const todoPlanContentKey = await resolveReviewedTodoPlanContentKey({
        assignment,
        reviewSubject: reviewSubject.subject,
        workspaceFolder: cwd,
        leafId: workflowLeafId,
      });
      const reviewedMaterialRevision = await resolveReviewedLeafMaterialRevision({
        assignment,
        reviewSubject: reviewSubject.subject,
        workspaceFolder: cwd,
        executionFolder,
        leafId: workflowLeafId,
      });
      const recheckGate = inspectReviewRecheckWithoutChange({
        parentChatId,
        assignment,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        executor: { transport, model },
        todoPlanRevisionKey,
        todoPlanContentKey,
        materialRevision: reviewedMaterialRevision,
        planReviewerPhase: input?.planReviewerPhase ?? input?.plan_reviewer_phase,
        exchangeOfDelegationId: resolvePlanReviewerExchangeOriginDelegationId(input),
        allowRecheck: input?.allowRecheck === true || input?.allow_recheck === true,
      });
      if (!recheckGate.ok) return recheckGate;
      // A parent-width conflict on THIS parent no longer hard-rejects the
      // start: the job is queued and drains FIFO once the slot frees. Foreign
      // `workspace_busy` / `global_limit` conflicts and every validation/source/
      // workflow gate stay hard. `queueConflict` carries the conflict the record
      // is parked behind; it is null when the slot was free for an immediate start.
      let queueConflict = null;
      const widthBlock = await parentWidthConflict({
        parentChatId,
        incomingAssignment: delegationRuntimeAssignment({ assignment, workRole }),
        gate: 'start',
        workspaceFolder: cwd,
        executionFolder,
        incomingLeafId: workflowLeafId,
        dataDir: deps.dataDir,
      });
      if (widthBlock) {
        if (!isQueueableDelegationConflict(widthBlock.code)) return widthBlock;
        const queueMax = readDelegationQueueMax();
        if (queuedDepthForController(parentChatId) >= queueMax) return queueFullConflict(widthBlock, queueMax);
        queueConflict = { code: widthBlock.code, error: widthBlock.error };
      }
      // Reassigned only by an explicit, fully gated session resume (below).
      /** @type {string} */ let childChatId = randomUUID();
      const attemptId = randomUUID();
      const title = String(input.title || '').trim()
        || `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : sourceKind === 'plan' ? 'build' : 'task'})`;
      const delegationId = randomUUID();
      if (codeReviewGate.mode) {
        const workflowForClosure = resolveDelegationWorkflowRow({ parentChatId, leafId: workflowLeafId });
        const closureStartPatch = buildCodeReviewWorkflowPatchOnStart(workflowForClosure, {
          delegationId,
          mode: codeReviewGate.mode,
          workspaceFolder: cwd,
          todoReviewerPair: await readLeafTodoReviewerPair(deps.dataDir, cwd, workflowLeafId),
          // A learned fixed pair lives in the controller's delegations; the
          // server must see them or the two-reviewer round never opens.
          parentChatId,
          delegations: /** @type {DelegationRow[]} */ (loadDelegations()),
          // Stored on the round so distinct reviewers (not delegation rows) are
          // what resolves the two-reviewer approval.
          reviewer: { transport, model },
        });
        if (closureStartPatch) {
          applyDelegationWorkflowPatch({
            ...closureStartPatch,
            parentChatId,
            leafId: workflowLeafId,
            idempotencyKey: `code-review-closure-open-${attemptId}`,
            countReview: false,
          });
        }
      }
      if (uiActionProof) {
        // Consumed after every gate passed and before any row exists: a refused
        // start keeps the action, a successful one burns it exactly once.
        const consumed = consumeDelegationUiAction(uiActionBinding);
        if (!consumed.ok) return { ok: false, status: 403, error: consumed.error, code: consumed.code };
      }
      // Reserve the pick slot BEFORE the row exists: a refused reservation
      // (slot taken / expired) must leave no queued record behind that would
      // inflate `executedAuto`/`runs` or be picked up by reconcile.
      const slotReservation = await finalizeDelegationPickSlotReservation({
        pickId: pickLink.pickId,
        selectionSlot: pickLink.selectionSlot,
        delegationId,
        idempotencyKey,
        pickOrigin: pickLink.pickOrigin,
      });
      if (!slotReservation.ok) {
        return {
          ok: false,
          status: slotReservation.code === 'idempotency_key_required' || slotReservation.code === 'validation' ? 400 : 409,
          error: slotReservation.error || 'pick_id slot reservation failed',
          code: slotReservation.code || 'pick_slot_conflict',
        };
      }
      /** @type {any} */ const pickRecord = pickLink.pickId ? getModelPickRecord(pickLink.pickId) : null;
      const exploreMarker = pickRecord?.explore || null;
      // Shadow-only complexity level: the linked pick's level first, else an
      // explicit level on the start input. Stored on the row so token history
      // can bucket per (model, role, level) later; unknown stays absent.
      const startLevel = input?.complexityLevel
        ?? (typeof input?.complexity === 'string' ? input.complexity : input?.complexity?.level);
      const rowComplexity = normalizeComplexity(pickRecord?.complexity)
        || normalizeComplexity({ level: startLevel });
      if (exploreMarker?.mode === 'real') {
        /** @type {any} */ const exploreReserve = await reserveModelPickExploreBudget({
          marker: exploreMarker,
          delegationId,
          idempotencyKey,
          pickId: pickLink.pickId,
          workspaceKey: cwd,
          config: loadModelPickExploreConfig(),
          delegations: /** @type {DelegationRow[]} */ (loadDelegations()),
        });
        if (!exploreReserve.ok) {
          if (pickLink.pickOrigin === 'auto') {
            try {
              releaseModelPickSlotsForDelegation({ pickId: pickLink.pickId, delegationId });
            } catch {
              // Never mask the explore refusal.
            }
          }
          return {
            ok: false,
            status: 409,
            error: exploreReserve.error || 'Explore budget reservation refused.',
            code: exploreReserve.code || 'explore_blocked',
            blocked: exploreReserve.blocked,
          };
        }
      }
      // The reservation above awaits, so another concurrent start can run
      // between the width check and the record create. Re-run the
      // parent archive and width/workspace/global gates before the synchronous create
      // (no await in between): two starts in one workspace must still
      // serialize on `workspace_busy`, and a blocked start must not burn the
      // pick slot it just reserved.
      const parentRecheck = validateDelegationParent(/** @type {ChatRowAny[]} */ (loadChats()).find(row => row.id === parentChatId));
      const widthRecheck = parentRecheck.ok ? await parentWidthConflict({
        parentChatId,
        incomingAssignment: delegationRuntimeAssignment({ assignment, workRole }),
        gate: 'start',
        workspaceFolder: cwd,
        executionFolder,
        incomingLeafId: workflowLeafId,
        dataDir: deps.dataDir,
      }) : parentRecheck;
      if (widthRecheck) {
        const recheckQueueable = parentRecheck.ok === true && isQueueableDelegationConflict(widthRecheck.code);
        if (!recheckQueueable) {
          if (pickLink.pickOrigin === 'auto') {
            try {
              releaseModelPickSlotsForDelegation({ pickId: pickLink.pickId, delegationId });
            } catch {
              // The slot expires with the pick; never mask the conflict.
            }
          }
          if (exploreMarker?.mode === 'real') {
            releaseModelPickExploreAttemptForDelegation({ delegationId });
          }
          return widthRecheck;
        }
        const queueMax = readDelegationQueueMax();
        if (queuedDepthForController(parentChatId) >= queueMax) {
          if (pickLink.pickOrigin === 'auto') {
            try {
              releaseModelPickSlotsForDelegation({ pickId: pickLink.pickId, delegationId });
            } catch {
              // The slot expires with the pick; never mask a full queue.
            }
          }
          if (exploreMarker?.mode === 'real') {
            releaseModelPickExploreAttemptForDelegation({ delegationId });
          }
          return queueFullConflict(widthRecheck, queueMax);
        }
        // Queueable: keep the pick reservation (the queued job still starts
        // from the queue) and park the record behind this conflict.
        queueConflict = { code: widthRecheck.code, error: widthRecheck.error };
      }
      // The awaits above open a window for an update/install to claim the
      // shared slot. Re-check synchronously right before the record create so
      // no new delegation is admitted (and no pick slot is burned) while files
      // are being replaced.
      if (!canAcceptNewRun()) {
        if (pickLink.pickOrigin === 'auto') {
          try {
            releaseModelPickSlotsForDelegation({ pickId: pickLink.pickId, delegationId });
          } catch {
            // The slot expires with the pick; never mask the update refusal.
          }
        }
        if (exploreMarker?.mode === 'real') {
          releaseModelPickExploreAttemptForDelegation({ delegationId });
        }
        return updateOperationConflict();
      }
      // Explicit session resume. Decided here, synchronously right before the
      // record exists, so two concurrent starts naming the same session cannot
      // both pass the claim check (the second sees the first's queued row).
      // Reviewer policy (per subject): the server decides here, on every review
      // start and for every caller, whether the previous reviewer session is
      // re-entered. A decision is recorded for each review, also when no
      // source exists, so `sessionResume: null` never hides a skipped lookup.
      let pairResumeSource = '';
      let reviewerPolicy = null;
      let policyDecision = null;
      let reviewerMembership = '';
      let pairDuplicateWarning = null;
      let pairUnsatisfiableWarning = null;
      // Learning writes the pair member before the record exists; a failed
      // record creation must roll it back so no orphan member survives.
      let learnedPairMember = null;
      if (assignment === 'review') {
        const policyDelegations = /** @type {DelegationRow[]} */ (loadDelegations());
        const todoReviewerPair = await readLeafTodoReviewerPair(deps.dataDir, cwd, workflowLeafId);
        try {
          reviewerPolicy = resolveTodoReviewerPolicy(cwd, {
            subject: reviewSubject.subject,
            parentChatId,
            delegations: policyDelegations,
            todoReviewerPair,
          });
        } catch {
          reviewerPolicy = null;
        }
        if (reviewerPolicy && reviewerPolicy.selection === 'fixed_pair') {
          // Learning: the first two distinct reviewers of this controller and
          // subject become its pair; an errored member is evicted on read.
          if (reviewerPolicy.learning) {
            try {
              const added = addReviewerPairMember(
                parentChatId,
                { harness: String(transport), model: String(model) },
                reviewerPolicy.subject,
              );
              if (added) {
                learnedPairMember = {
                  subject: reviewerPolicy.subject,
                  member: { harness: String(transport), model: String(model) },
                };
              }
              // The member just learned has no delegation record yet, so the
              // in-flight guard cannot protect it from the configuration
              // eviction; exempt it in this re-read.
              reviewerPolicy = resolveTodoReviewerPolicy(cwd, {
                subject: reviewSubject.subject,
                parentChatId,
                delegations: policyDelegations,
                todoReviewerPair,
                keepMember: { harness: String(transport), model: String(model) },
              });
            } catch {
              // Learning is best effort and never blocks a start.
            }
          }
          const member = reviewerPolicy.known.some((m) => isSameReviewer(m, { harness: transport, model }));
          reviewerMembership = reviewerPolicy.known.length < 2 && !member
            ? 'learning'
            : member ? 'member' : 'outside_pool';
          if (member && reviewerPolicy.known.length >= 2) {
            pairDuplicateWarning = readPairDuplicateReviewerWarning({
              delegations: policyDelegations,
              leafId: workflowLeafId,
              subject: reviewSubject.subject,
              harness: transport,
              model,
              members: reviewerPolicy.known,
            });
          }
          if (codeReviewGate.mode && reviewSubject.subject === 'code' && reviewerPolicy.known.length >= 2 && workflowLeafId) {
            const gate = evaluatePairGateAtStart({
              cwd, dataDir: deps.dataDir, controllerChatId: parentChatId, workflow: resolveDelegationWorkflowRow({ parentChatId, leafId: workflowLeafId }), leafId: workflowLeafId, delegations: policyDelegations,
              members: reviewerPolicy.known, reviewer: { transport, model },
            });
            if (gate && !gate.satisfiable) {
              if (gate.refuse) {
                return {
                  ok: false,
                  status: 409,
                  code: REVIEWER_PAIR_UNSATISFIABLE_CODE,
                  error: `The fixed reviewer pair cannot get a second distinct reviewer: ${gate.missing} ${gate.reason}. `
                    + 'This reviewer already started in the open round; a second start of the same identity would not satisfy the pair.',
                  missing_reviewer: gate.missing,
                };
              }
              pairUnsatisfiableWarning = {
                code: REVIEWER_PAIR_UNSATISFIABLE_CODE,
                missing_reviewer: gate.missing,
                message: `The fixed reviewer pair cannot get two distinct reviewers: ${gate.missing} ${gate.reason}. This review starts, but a second start of the same identity will be refused.`,
              };
            }
          }
        }
        if (!reviewerPolicy || !reviewerPolicy.reuse) {
          policyDecision = buildPolicyReuseDecision(SESSION_RESUME_REASON.FRESH_BY_POLICY);
        } else if (!readResumeSessionOfInput(input)) {
          if (reviewerMembership === 'outside_pool') {
            policyDecision = buildPolicyReuseDecision(SESSION_RESUME_REASON.NOT_POOL_MEMBER);
          } else {
            pairResumeSource = findPairResumeSource({
              delegations: policyDelegations,
              parentChatId,
              reviewSubject: reviewSubject.subject,
              leafId: workflowLeafId,
              reviewMode: codeReviewGate.mode,
              scope: reviewerPolicy.session,
              executor: { transport, model, options: input?.executor?.options },
            });
            if (!pairResumeSource) {
              // "Reviewed before" is per controller AND per subject: a prior
              // review under another subject is this reviewer's first session
              // for the current one, not an ineligible source.
              const reviewedBefore = policyDelegations.some((row) => String(row?.assignment || '').toLowerCase() === 'review'
                && (String(row?.controllerChatId || '') || String(row?.parentChatId || '')) === parentChatId
                && String(row?.reviewSubject || '').toLowerCase() === String(reviewSubject.subject || '').toLowerCase()
                && isSameReviewer({ harness: row?.executor?.transport, model: row?.executor?.model }, { harness: transport, model }));
              policyDecision = buildPolicyReuseDecision(reviewedBefore
                ? SESSION_RESUME_REASON.NO_ELIGIBLE_SOURCE
                : reviewerPolicy.learning ? SESSION_RESUME_REASON.LEARNING : SESSION_RESUME_REASON.FIRST_SESSION);
            }
          }
        }
      }
      // Plan / implement / fix continuation: one resolver (Settings switch per
      // role), applied only now that the executor is fixed. A disabled switch
      // ignores even an explicit `resume_session_of` (fresh by policy).
      const continuationSnapshot = resolveDelegationContinuationPolicy({
        workspaceFolder: cwd,
        dataDir: deps.dataDir,
        workRole,
      });
      let workResumeSource = '';
      // Opt-in widening (code review <-> implement/fix of one leaf). Each start
      // still needs its own per-role switch; off keeps the single source.
      const crossRoleOn = resolveCrossRoleContinuation({ workspaceFolder: cwd, dataDir: deps.dataDir });
      let crossRoleSources = [];
      if (isWorkContinuationRole(workRole) && continuationSnapshot.enabled
        && continuationSnapshot.scope === 'leaf' && !workflowLeafId
        && (parent?.todoId || leafContext.warning?.candidates?.length)) {
        return {
          ok: false,
          status: 409,
          code: 'leaf_id_required_for_session_reuse',
          error: 'Per-TODO session continuation needs leaf_id. Mark one TODO leaf as doing or pass its ID explicitly; no child chat was created.',
          warning: leafContext.warning,
        };
      }
      if (isWorkContinuationRole(workRole)) {
        if (!continuationSnapshot.enabled) {
          policyDecision = buildPolicyReuseDecision(SESSION_RESUME_REASON.WORK_FRESH_BY_POLICY);
        } else if (!readResumeSessionOfInput(input)) {
          const workDelegations = /** @type {DelegationRow[]} */ (loadDelegations());
          workResumeSource = findWorkResumeSource({
            delegations: workDelegations,
            parentChatId,
            leafId: workflowLeafId,
            workRole,
            sessionScope: continuationSnapshot.scope,
            executor: { transport, model, options: input?.executor?.options },
          });
          if (crossRoleOn) {
            crossRoleSources = findCrossRoleResumeSources({
              delegations: workDelegations,
              parentChatId,
              leafId: workflowLeafId,
              workRole,
              executor: { transport, model, options: input?.executor?.options },
            });
          }
          if (!workResumeSource && crossRoleSources.length === 0) policyDecision = buildPolicyReuseDecision(
            !workflowLeafId && continuationSnapshot.scope === 'leaf'
              ? SESSION_RESUME_REASON.NO_LEAF : SESSION_RESUME_REASON.WORK_NO_SOURCE,
          );
        }
      }
      if (crossRoleOn && assignment === 'review' && workRole === 'review_code'
        && reviewerPolicy?.reuse && reviewerMembership !== 'outside_pool' && !readResumeSessionOfInput(input)) {
        crossRoleSources = findCrossRoleResumeSources({
          delegations: /** @type {DelegationRow[]} */ (loadDelegations()),
          parentChatId,
          leafId: workflowLeafId,
          workRole,
          executor: { transport, model, options: input?.executor?.options },
        });
      }
      const workResumeBlocked = isWorkContinuationRole(workRole) && !continuationSnapshot.enabled;
      const reviewResumeBlocked = assignment === 'review'
        && (!reviewerPolicy?.reuse || reviewerMembership === 'outside_pool');
      const explicitResumeSource = workResumeBlocked || reviewResumeBlocked ? '' : readResumeSessionOfInput(input);
      const resumeDecision = decideSessionResumeCandidates({
        explicitSource: explicitResumeSource,
        sameRoleSource: workResumeBlocked || reviewResumeBlocked ? '' : pairResumeSource || workResumeSource,
        crossRoleSources: workResumeBlocked || reviewResumeBlocked ? [] : crossRoleSources,
        guardEverySource: isWorkContinuationRole(workRole) || crossRoleOn,
        parentChatId,
      }, {
        crossRoleSessions: crossRoleOn,
        resumeContextCapRounds: resolveResumeContextCapRounds({ workspaceFolder: cwd, dataDir: deps.dataDir }),
        workRole,
        sessionScope: isWorkContinuationRole(workRole)
          ? continuationSnapshot.scope : reviewerPolicy?.reuse ? reviewerPolicy.session : 'leaf',
        parentChatId,
        assignment,
        reviewSubject: reviewSubject.subject,
        reviewMode: codeReviewGate.mode,
        leafId: workflowLeafId,
        executor: { transport, model, options: input?.executor?.options },
        executionMode,
        executionFolder,
        allowChildDelegations: startGate.allowChildDelegations,
        depth: startGate.depth,
        rootChatId: startGate.rootChatId,
        planReviewerPhase,
        exchangeOfDelegationId: resolvePlanReviewerExchangeOriginDelegationId(input),
        delegations: /** @type {DelegationRow[]} */ (loadDelegations()),
        findChat: (chatId) => /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === chatId) || null,
        capabilities: getChatRunAdapterCapabilities(transport),
        lockoutActive: findActiveLockoutRow(activeUsageLimits, transport, model, Date.now()) != null,
        isRunActive: (chatId) => isChatRunStillActive({ chatId }),
        currentContinuity: readCurrentSessionContinuity,
      });
      let sessionContinuity = createSessionContinuity();
      if (resumeDecision.resume) {
        childChatId = resumeDecision.childChatId;
        sessionContinuity = normalizeSessionContinuity(resumeDecision.sessionContinuity)
          || readCurrentSessionContinuity(childChatId)
          || sessionContinuity;
      }
      // Gate outcome wins; a policy-level reason is recorded when the gate was
      // never asked (no source) so the decision is never silently absent.
      const effectiveDecision = resumeDecision.requested ? resumeDecision : (policyDecision || resumeDecision);
      const sessionResume = buildSessionResumeRecord(effectiveDecision, /** @type {any} */ ({
        generation: sessionContinuity.generation,
        workRole: isWorkContinuationRole(workRole) ? workRole : '',
      }));
      let record;
      try {
        record = /** @type {DelegationRow} */ (createDelegationRecord({
        id: delegationId,
        parentChatId,
        childChatId,
        depth: startGate.depth,
        rootChatId: startGate.rootChatId,
        rootDelegationId: startGate.rootDelegationId || delegationId,
        allowChildDelegations: startGate.allowChildDelegations,
        workspaceFolder: cwd,
        executionFolder,
        planRevision: planDoc.revision,
        planHash: planDoc.contentHash,
        planMarkdown: planDoc.body,
        todoPlanRevisionKey,
        todoPlanContentKey,
        reviewedMaterialRevision,
        executor: {
          transport,
          model,
          options: input?.executor?.options && typeof input.executor.options === 'object'
            ? input.executor.options
            : {},
        },
        status: 'queued',
        attemptId,
        idempotencyKey,
        extraInstructions: input.extraInstructions,
        selectedSkillIds: normalizeSkillIds(input.selectedSkillIds),
        // Not part of requestHash on purpose: adding it must not invalidate
        // in-flight/replayed starts created before the field existed.
        pickReason,
        // Audited override flag: records that the caller REQUESTED the review
        // recheck override, not that the gate used it (it is stored for
        // non-review starts too). Also excluded from requestHash.
        allowRecheck: input?.allowRecheck === true || input?.allow_recheck === true,
        // Same audit pattern: lets a queued start survive drain/resume with the
        // verify-failed override. Excluded from requestHash.
        allowVerifyFailedReview: input?.allowVerifyFailedReview === true
          || input?.allow_verify_failed_review === true,
        // Shadow-only level; also excluded from requestHash for the same reason.
        complexity: rowComplexity,
        planHeadroomSnapshot: planHeadroomSnapshotFor(transport, model, cwd, deps.dataDir),
        // Prefer the pick-time snapshot (same `now`/planLimits and the same +1
        // zeroing as the decision) so the card cannot contradict the pick. The
        // start-time snapshot stays the fallback for pick-less/legacy starts and
        // for `rotation: off` picks, which never compute a pace signal.
        planPaceSnapshot: pickRecord?.planPace || planPaceSnapshotFor(transport, model, cwd, deps.dataDir),
        pickId: pickLink.pickId,
        pickOrigin: pickLink.pickOrigin,
        pickOriginDetail: pickLink.pickOriginDetail,
        pickLinkStatus: pickLink.pickLinkStatus,
        pickRole: pickLink.pickRole,
        startContext: startContext.context,
        startContextSource: startContext.source,
        continuationOf: continuation ? continuation.continuationOf : '',
        uiActionProof,
        pickFallbackFrom,
        pickFallbackFromAttemptId: pickFallbackFrom
          ? String(/** @type {any} */ (getDelegationById(pickFallbackFrom))?.attemptId || '').trim()
          : '',
        fallbackFailureClass: pickFallbackFrom
          ? classifyDelegationFailure(getDelegationById(pickFallbackFrom) || {}).failureClass
          : '',
        sourceKind,
        sourceChatId: parentChatId,
        sourceHistorySeq,
        sourceCreatedAt,
        sourceText,
        sourceHash,
        requestHash,
        executionMode,
        assignment,
        reviewSubject: reviewSubject.subject,
        reviewSubjectSource: reviewSubject.source,
        reviewMode: codeReviewGate.mode,
        leafId: workflowLeafId,
        // Stored once at the first start; replays and resumes never rewrite it.
        reviewUncertified: assignment === 'review' ? reviewGate.reviewUncertified === true : null,
        verifyRequired: reviewVerifyPlan.required === true,
        reviewCanRunTests: reviewVerifyPlan.canRunTests === true,
        reviewCanRunTestsSource: reviewVerifyPlan.source,
        runDeadlineAt: normalizeDelegationRunDeadlineAt(input?.deadlineAt ?? input?.deadline_at),
        planReviewerSessionId,
        planReviewerPhase,
        exchangeOfDelegationId: resolvePlanReviewerExchangeOriginDelegationId(input),
        sessionResume,
        sessionContinuity,
        workRole,
        continuationPolicy: {
          field: continuationSnapshot.field,
          enabled: continuationSnapshot.enabled,
          source: continuationSnapshot.source,
          scope: continuationSnapshot.scope,
          reason: continuationSnapshot.reason,
        },
        reviewerPolicy: reviewerPolicy
          ? buildReviewerPolicySnapshot(reviewerPolicy, {
            membership: reviewerMembership,
            // No resume record = the policy kept sessions fresh; say so explicitly.
            decision: sessionResume || {
              ...buildSessionResumeRecord(buildPolicyReuseDecision(SESSION_RESUME_REASON.FRESH_BY_POLICY)),
            },
          })
          : null,
      }));
      } catch (err) {
        if (learnedPairMember) {
          try {
            removeReviewerPairMember(parentChatId, learnedPairMember.member, learnedPairMember.subject);
          } catch {
            // Rollback is best effort; never mask the create error.
          }
        }
        if (pickLink.pickOrigin === 'auto') {
          try {
            releaseModelPickSlotsForDelegation({ pickId: pickLink.pickId, delegationId });
          } catch {
            // The slot expires with the pick; never mask the create error.
          }
        }
        if (exploreMarker?.mode === 'real') {
          releaseModelPickExploreAttemptForDelegation({ delegationId });
        }
        throw err;
      }
      if (planReviewerSessionId && planReviewerGate.session) {
        registerPlanReviewerDelegation(
          planReviewerGate.session,
          record.id,
          Number(input?.planReviewerSlot ?? input?.plan_reviewer_slot ?? 0),
          {
            phase: planReviewerPhase,
            originDelegationId: resolvePlanReviewerExchangeOriginDelegationId(input),
          },
        );
      }
      runDelegationCrashHook('after-record-create', record);
      cancelParentDelegationUsageLimitPauses({ parentChatId, leafId: workflowLeafId });
      logDelegationEvent('queued', record);
      // Queue-time invalidation (decision U5): a queued review is `pending`, and
      // a queued implement/fix makes any prior `passed`/`manual` snapshot
      // `stale` before the job ever starts.
      await safeSyncTodoReview(record, { dataDir: deps.dataDir });
      if (queueConflict) {
        // Parked behind a parent-width conflict: keep the durable `queued`
        // record, skip the child-run start, and let drainQueue resume it FIFO
        // once the slot frees. The response is a success (202), not a 409.
        const queuedRow = /** @type {DelegationRow} */ (getDelegationById(record.id)) || record;
        return attachLeafResolutionFields(attachDelegationStartWarning(tagReviewUncertified({
          ok: true,
          status: 202,
          delegation: queuedRow,
          chat: null,
          replayed: false,
          queued: true,
          queueConflict,
        }, reviewGate.reviewUncertified), mergeStartWarnings(startupLockoutWarning, pairDuplicateWarning, pairUnsatisfiableWarning)), leafContext);
      }
      // Read the child run's prompt extras here (same inputs as the start
      // routine) so its prefix up to `starting` stays synchronous.
      const childRunExtras = await readExecutorPromptExtras({
        parentChatId: parent.id,
        leafId: readDelegationWorkflowLeafIdFromRow(record),
        cwd,
        assignment,
        executionMode,
        workRole: readRowWorkRole(record),
      });
      const startPromise = startDelegationChildRun(record, parent, {
        reviewExtras: childRunExtras,
        childChatId,
        title,
        transport,
        model,
        cwd,
        executionFolder,
        sourceKind,
        sourceText,
        planMarkdown: planDoc.body,
        extraInstructions: input.extraInstructions,
        executionMode,
        assignment,
        createdStatus: 201,
        replayed: false,
      });
      const pendingStart = /** @type {DelegationRow} */ (getDelegationById(record.id)) || record;
      if (input?.returnWhenStarting === true && pendingStart.status === 'starting') {
        // MCP callers have a short HTTP request deadline. The start routine
        // synchronously persists the child and transitions the delegation to
        // `starting` before awaiting adapter acceptance, so it is safe to
        // acknowledge here and let the existing status/wait APIs track it.
        void startPromise.catch((err) => {
          try {
            const latest = /** @type {DelegationRow} */ (getDelegationById(record.id)) || record;
            if (!isTerminalDelegationStatus(latest.status)) {
              finishDelegation(latest, {
                status: 'failed',
                error: err?.message || String(err),
              });
            }
          } catch {
            // The runtime worker will reconcile a persisted starting record.
          }
        });
        const starting = /** @type {DelegationRow} */ (getDelegationById(record.id)) || pendingStart;
        const child = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === childChatId) || null;
        return attachLeafResolutionFields(attachDelegationStartWarning(tagReviewUncertified({
          ok: true,
          status: 202,
          delegation: starting,
          chat: child,
          replayed: false,
        }, reviewGate.reviewUncertified), mergeStartWarnings(startupLockoutWarning, pairDuplicateWarning, pairUnsatisfiableWarning)), leafContext);
      }
      const started = await startPromise;
      return attachLeafResolutionFields(
        attachDelegationStartWarning(tagReviewUncertified(started, reviewGate.reviewUncertified), mergeStartWarnings(startupLockoutWarning, pairDuplicateWarning, pairUnsatisfiableWarning)),
        leafContext,
      );
      } finally {
        pendingStartAdmissions.delete(admissionId);
      }
    });
  }

  /**
   * @param {any} existing
   * @param {any} parent
   * @param {any} ctx
   */
  async function resumeExistingDelegation(existing, parent, ctx, options = {}) {
    const fromDrain = options.fromDrain === true;
    const parentGate = validateDelegationParent(/** @type {ChatRowAny[]} */ (loadChats()).find(row => row.id === parent.id));
    if (!parentGate.ok) return parentGate;
    const assignment = normalizeDelegationAssignment(
      existing.assignment || ctx.assignment,
      existing.executionMode || ctx.executionMode,
    );
    const executionMode = resolveDelegationChildExecutionMode(
      existing.executionMode || ctx.executionMode,
      assignment,
      parent.sdkMode,
    );
    if (existing.assignment !== assignment || existing.executionMode !== executionMode) {
      existing = /** @type {DelegationRow} */ (updateDelegationRecord(existing.id, { assignment, executionMode })) || existing;
    }
    // A resume/retry reuses the frozen execution folder recorded at start.
    const executionFolder = String(
      existing.executionFolder || ctx.executionFolder || existing.workspaceFolder || '',
    ).trim();
    const runtimeAssignment = delegationRuntimeAssignment(existing);
    const reviewUncertified = assignment === 'review'
      && assertReviewAdapterAllowed(existing.executor?.transport, { env: resolveDelegationEnv(existing.workspaceFolder) }).reviewUncertified === true;
    const childChatId = String(existing.childChatId || '').trim() || randomUUID();

    function buildReplay(extra = {}) {
      const latest = /** @type {DelegationRow} */ (getDelegationById(existing.id)) || existing;
      let child = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === childChatId) || null;
      if (extra.chat !== undefined) child = extra.chat;
      return tagReviewUncertified({
        ok: true,
        status: extra.queued ? 202 : 200,
        delegation: latest,
        chat: child,
        replayed: true,
        ...extra,
      }, reviewUncertified);
    }

    async function ensureResumeChildChat() {
      if (!String(existing.childChatId || '').trim()) {
        /** @type {DelegationRow} */ (updateDelegationRecord(existing.id, { childChatId }));
      }
      let child = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === childChatId) || null;
      if (!child) {
        const executor = existing.executor && typeof existing.executor === 'object' ? existing.executor : {};
        child = /** @type {ChatRowAny} */ (addChat(randomUUID(), `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : 'task'})`, parent.workspaceFile, parent.workspaceFolder, executor.model, /** @type {any} */ ({
          id: childChatId,
          agentTransport: executor.transport,
          sdkMode: executionMode,
          sdkUiMode: parent.sdkUiMode,
          todoId: parent.todoId,
          forkParentChatId: parent.id,
          forkKind: 'delegation',
          delegationParentChatId: parent.id,
          delegationDepth: existing.depth,
          delegationRootChatId: existing.rootChatId,
          delegationRootDelegationId: existing.rootDelegationId,
          delegationGrant: existing.allowChildDelegations === true,
          delegationId: existing.id,
          delegationAssignment: runtimeAssignment,
          delegationSessionIdentity: existing.sessionContinuity?.identity,
          delegationSessionGeneration: existing.sessionContinuity?.generation,
          executionFolder,
          widgetInstallationId: parent.widgetInstallationId,
        })));
      } else {
        const chatPatch = {};
        if (executionFolder && String(child.executionFolder || '').trim() !== executionFolder) {
          chatPatch.executionFolder = executionFolder;
        }
        if (String(child.delegationAssignment || '').trim() !== runtimeAssignment) {
          chatPatch.delegationAssignment = runtimeAssignment;
        }
        if (!String(child.delegationSessionIdentity || '').trim()
          && String(existing.sessionContinuity?.identity || '').trim()) {
          chatPatch.delegationSessionIdentity = existing.sessionContinuity.identity;
          chatPatch.delegationSessionGeneration = existing.sessionContinuity.generation;
        }
        if (Object.keys(chatPatch).length > 0) child = /** @type {ChatRowAny} */ (updateChat(child.id, chatPatch)) || child;
      }
      await appendRelatedChatHistoryLinks({
        parentChat: parent,
        childChat: child,
        reason: 'delegation',
      });
      await linkChildChatToTodo(child, parent);
      if (!await hasDelegationHistoryEvent(parent.id, { id: existing.id, event: 'started', attemptId: existing.attemptId })) {
        await publishDelegationStatus(existing, 'started');
      }
      return child;
    }

    if (hasInFlightDelegationStart(existing.id)) {
      await ensureResumeChildChat();
      return buildReplay();
    }
    const knownChildId = String(existing.childChatId || '').trim();
    if (knownChildId) {
      const live = probeChatRunLiveness({ chatId: knownChildId, runId: existing.runId });
      if (live.busy) {
        await ensureResumeChildChat();
        return buildReplay();
      }
    }
    if (existing.status !== 'queued' && existing.status !== 'starting') {
      const child = await ensureResumeChildChat();
      return buildReplay({ chat: child });
    }
    const resumeGate = await inspectQueuedDelegationResume(existing, parent, ctx, assignment, {
      ignoreQueuedWidth: fromDrain,
    });
    if (resumeGate.ok === false) return resumeGate;
    if (resumeGate.stayQueued) {
      return buildReplay({
        queued: true,
        queueConflict: resumeGate.queueConflict,
      });
    }
    const child = await ensureResumeChildChat();
    const resumed = await startDelegationChildRun(/** @type {DelegationRow} */ (getDelegationById(existing.id)) || existing, parent, {
      childChatId,
      title: child.title,
      transport: existing.executor?.transport,
      model: existing.executor?.model,
      cwd: ctx.cwd,
      executionFolder,
      sourceKind: ctx.sourceKind,
      sourceText: ctx.sourceText,
      planMarkdown: ctx.planMarkdown,
      extraInstructions: ctx.extraInstructions,
      executionMode,
      assignment,
      createdStatus: 200,
      replayed: true,
    });
    return tagReviewUncertified(resumed, resumeGate.reviewUncertified);
  }

  /**
   * Replaying a queued/starting job must pass the same gates as a new start.
   *
   * @param {any} existing
   * @param {any} parent
   * @param {any} ctx
   * @param {string} assignment
   */
  async function inspectQueuedDelegationResume(existing, parent, ctx, assignment, options = {}) {
    /** @type {any} */ const reviewGate = isPlanAuthoringDelegationRow(existing)
      ? assertPlannerAdapterAllowed(existing.executor?.transport, { env: resolveDelegationEnv(existing.workspaceFolder) })
      : assignment === 'review'
        ? assertReviewAdapterAllowed(existing.executor?.transport, { env: resolveDelegationEnv(existing.workspaceFolder) })
        : { ok: true };
    if (!reviewGate.ok) return reviewGate;
    const workflowLeafId = readDelegationWorkflowLeafIdFromRow(existing);
    const implementVerifyGate = inspectImplementVerifyBeforeReview({
      parentChatId: parent.id,
      assignment,
      executionMode: existing.executionMode,
      reviewSubject: existing.reviewSubject,
      leafId: workflowLeafId,
      allowVerifyFailedReview: existing.allowVerifyFailedReview === true,
    });
    if (!implementVerifyGate.ok) return implementVerifyGate;
    const workflowGate = inspectDelegationWorkflowStart(/** @type {any} */ ({
      parentChatId: parent.id,
      assignment,
      leafId: workflowLeafId,
      resumeRounds: existing.resumeRounds ?? existing.resume_rounds,
      maxRounds: existing.maxRounds ?? existing.max_rounds,
    }));
    if (!workflowGate.ok) return workflowGate;
    const workflowRow = resolveDelegationWorkflowRow({ parentChatId: parent.id, leafId: workflowLeafId });
    const codeReviewGate = inspectDelegationCodeReviewStart({
      assignment,
      reviewSubject: existing.reviewSubject,
      leafId: workflowLeafId,
      workflow: workflowRow,
      workspaceFolder: existing.workspaceFolder,
      resumeRounds: existing.resumeRounds ?? existing.resume_rounds,
    });
    if (!codeReviewGate.ok) return codeReviewGate;
    const ignoreQueuedWidth = options.ignoreQueuedWidth === true;
    if (!ignoreQueuedWidth && !isQueuedHeadForController(existing)) {
      return {
        ok: true,
        stayQueued: true,
        reviewUncertified: reviewGate.reviewUncertified === true,
        queueConflict: {
          code: 'active_delegation_exists',
          error: 'An older queued job for this parent must start first.',
        },
      };
    }
    const widthBlock = await parentWidthConflict({
      parentChatId: parent.id,
      incomingAssignment: delegationRuntimeAssignment(existing),
      resumeDelegationId: existing.id,
      gate: 'start',
      workspaceFolder: ctx.cwd || existing.workspaceFolder,
      executionFolder: existing.executionFolder || ctx.executionFolder || ctx.cwd || existing.workspaceFolder,
      ignoreQueued: ignoreQueuedWidth,
      incomingLeafId: workflowLeafId,
      dataDir: deps.dataDir,
    });
    if (widthBlock) {
      if (isQueueableDelegationConflict(widthBlock.code) || String(existing.status || '') === 'queued') {
        return {
          ok: true,
          stayQueued: true,
          reviewUncertified: reviewGate.reviewUncertified === true,
          queueConflict: { code: widthBlock.code, error: widthBlock.error },
        };
      }
      return { ok: false, ...widthBlock };
    }
    return { ok: true, reviewUncertified: reviewGate.reviewUncertified === true };
  }

  /**
   * Synchronous startup-retry scheduler, installed as the module-level hook that
   * `finishDelegation` calls before it writes a terminal failure. Keeps the job
   * non-terminal (so the slot stays held, `delegation_wait` keeps waiting and no
   * parent card is published) and schedules the next attempt after a bounded
   * delay. Returns the `starting` record when a retry was scheduled, else null.
   *
   * @param {DelegationRow} record
   * @param {{ error?: string, attemptId?: string }} outcome
   * @returns {any}
   */
  function scheduleStartupRetry(record, outcome) {
    /** @type {any} */ const latest = /** @type {DelegationRow} */ (getDelegationById(record.id)) || record;
    if (!latest || latest.status === 'cancelling' || isTerminalDelegationStatus(latest.status)) return null;
    const used = Math.max(0, Number(latest.startupRetry?.used) || 0);
    if (used >= resolveStartupRetryCount()) return null;
    const deadline = resolveEffectiveRunDeadlineEpoch(latest);
    if (Number.isFinite(deadline) && Date.now() >= deadline) return null;
    const attemptId = randomUUID();
    const acceptRequestId = randomUUID();
    const lastError = String(outcome?.error || latest.error || '').trim();
    // Archive the failed attempt once; the retried attempt gets a fresh id so
    // late events from the previous run are dropped by `isDelegationEventCurrent`.
    const archived = snapshotDelegationAttempt({
      ...latest,
      status: 'failed',
      error: lastError,
      finishedAt: new Date().toISOString(),
    });
    const starting = transition(latest, 'starting', {
      attemptId,
      acceptRequestId,
      acceptState: 'pending',
      runId: '',
      runningAt: '',
      finishedAt: '',
      // A `starting -> starting` regress does not bump the transition clock in
      // the store, so refresh it here to keep the worker sweep from timing the
      // retry out during the bounded delay.
      lastTransitionAt: new Date().toISOString(),
      error: '',
      report: '',
      reportVerdict: '',
      reportDegraded: false,
      reportSummary: '',
      verifyResult: null,
      taskOutcome: 'unspecified',
      interruptCode: '',
      runStoppingAt: '',
      startupRetry: {
        // `used` is preserved across the running transition of a retried
        // attempt: adapter acceptance precedes the authoritative first event,
        // so an accepted-but-silent run can still time out on the async bridge
        // and must keep counting toward the same bounded budget.
        used: used + 1,
        lastError,
        scheduledAt: new Date().toISOString(),
      },
      attempts: [...(Array.isArray(latest.attempts) ? latest.attempts : []), archived],
    }, { expectedAttemptId: latest.attemptId, allowStartupRetry: true });
    if (!starting || String(starting.attemptId || '') !== attemptId) return null;
    logDelegationEvent('startup-retry', starting);
    const delayMs = resolveStartupRetryDelayMs();
    const timer = setTimeout(() => {
      void runScheduledStartupRetry(latest.id, attemptId).catch(() => {});
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return starting;
  }

  /**
   * Delayed half of the startup retry: confirm the failed attempt is stopped and
   * idle (no duplicate concurrent run), then start the next attempt. Unknown or
   * still-busy liveness falls through to the terminal path, which records the
   * single final lockout.
   *
   * @param {string} id
   * @param {string} expectedAttemptId
   * @returns {Promise<Record<string, any> | null>}
   */
  async function runScheduledStartupRetry(id, expectedAttemptId) {
    /** @type {any} */ const latest = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!latest) return null;
    if (String(latest.attemptId || '') !== String(expectedAttemptId || '')) return latest;
    if (isTerminalDelegationStatus(latest.status) || latest.status === 'cancelling') return latest;
    try {
      await cancelChatRun({ chatId: latest.childChatId, runId: latest.runId });
    } catch {
      // Best-effort stop, same as the callers' failure path today.
    }
    const afterCancel = /** @type {DelegationRow} */ (getDelegationById(id)) || latest;
    if (String(afterCancel.attemptId || '') !== String(expectedAttemptId || '')) return afterCancel;
    if (isTerminalDelegationStatus(afterCancel.status) || afterCancel.status === 'cancelling') return afterCancel;
    const live = probeChatRunLiveness({ chatId: afterCancel.childChatId, runId: afterCancel.runId });
    // A never-accepted run has no adapter state; any other unknown probe (or a
    // still-busy run) is not proof of idle and must not be retried concurrently.
    const idle = live.busy !== true && (live.known === true || live.reason === 'state_missing');
    if (!idle) {
      return finishDelegation(afterCancel, {
        status: 'failed',
        error: afterCancel.startupRetry?.lastError || 'Executor did not stop; startup retry aborted.',
      });
    }
    return withParentLock(delegationController(afterCancel), () => startStartupRetryAttempt(id, expectedAttemptId));
  }

  /**
   * Start one bounded startup-retry attempt on the same child chat. Mirrors the
   * retry start path but skips the pick/lockout gates. Plan-window usage stays
   * once per delegation (reserved only when no earlier attempt reached
   * `running`). A further transient failure goes back through `finishDelegation`,
   * which either schedules the next attempt or writes the final lockout when the
   * budget is exhausted.
   *
   * @param {string} id
   * @param {string} expectedAttemptId
   * @returns {Promise<Record<string, any> | null>}
   */
  async function startStartupRetryAttempt(id, expectedAttemptId) {
    /** @type {any} */ const latest = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!latest) return null;
    if (String(latest.attemptId || '') !== String(expectedAttemptId || '')) return latest;
    if (isTerminalDelegationStatus(latest.status) || latest.status === 'cancelling') return latest;
    if (!canAcceptNewRun()) return updateOperationConflict();
    const parent = findControllerChat(latest);
    if (!parent) {
      return finishDelegation(latest, { status: 'failed', error: 'Parent chat is unavailable; startup retry aborted.' });
    }
    const startGate = validateDelegationExecutorStart({
      parent,
      executor: latest.executor,
      isModelAvailable,
      resolveCwd,
      resolveExecutionFolder,
    });
    if (!startGate.ok) {
      return finishDelegation(latest, { status: 'failed', error: startGate.error || 'Executor cannot start.' });
    }
    const assignment = normalizeDelegationAssignment(latest.assignment, latest.executionMode);
    const executionMode = resolveDelegationChildExecutionMode(latest.executionMode, assignment, parent.sdkMode);
    const cwd = latest.workspaceFolder || startGate.cwd;
    const executionFolder = latest.executionFolder || startGate.executionFolder || cwd;
    const reviewExtras = await readExecutorPromptExtras({
      parentChatId: delegationController(latest),
      leafId: readDelegationWorkflowLeafIdFromRow(latest),
      cwd,
      assignment,
      executionMode,
      workRole: readRowWorkRole(latest),
    });
    /** @type {any} */ const promptBuilt = buildDelegationExecutorPrompt({
      sourceKind: latest.sourceKind,
      planMarkdown: latest.planMarkdown,
      taskText: latest.sourceText,
      parentChatId: delegationController(latest),
      delegationId: latest.id,
      sourceHistorySeq: latest.sourceHistorySeq,
      workspaceFolder: executionFolder,
      extraInstructions: latest.extraInstructions,
      previousAttemptSummary: String(latest.startupRetry?.lastError || '').trim() || latest.error || '',
      executionMode,
      assignment,
      workRole: readRowWorkRole(latest),
      childDelegation: buildChildDelegationPromptInput(latest.allowChildDelegations, latest.depth, latest.workspaceFolder),
      workflowRow: reviewExtras.workflowRow,
      leafAcceptanceText: reviewExtras.leafAcceptanceText,
      leafMaterialText: reviewExtras.leafMaterialText,
      watcherFindingsText: reviewExtras.watcherFindingsText,
      reviewMode: latest.reviewMode,
      reviewCanRunTests: latest.reviewCanRunTests,
    });
    if (!promptBuilt.ok) {
      return finishDelegation(latest, { status: 'failed', error: promptBuilt.error });
    }
    /** @type {any} */ const reviewGate = isPlanAuthoringDelegationRow(latest)
      ? assertPlannerAdapterAllowed(startGate.transport, { env: resolveDelegationEnv(latest.workspaceFolder) })
      : assignment === 'review'
        ? assertReviewAdapterAllowed(startGate.transport, { env: resolveDelegationEnv(latest.workspaceFolder) })
        : { ok: true };
    if (!reviewGate.ok) {
      return finishDelegation(latest, { status: 'failed', error: reviewGate.error || 'Review adapter is not allowed.' });
    }
    const child = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === latest.childChatId) || null;
    if (!child) {
      return finishDelegation(latest, { status: 'failed', error: 'Executor chat is missing; startup retry aborted.' });
    }
    rememberInFlightStart(latest.id, { attemptId: latest.attemptId, childChatId: latest.childChatId });
    try {
      const started = await startChatRun({
        chatId: latest.childChatId,
        prompt: promptBuilt.prompt,
        mode: executionMode,
        requestId: latest.acceptRequestId || latest.attemptId,
        displayText: promptBuilt.displayText,
        selectedSkillIds: skillIdsOfRow(latest),
        deps: {
          workspaceDirForAgent: deps.workspaceDirForAgent,
          todoSyncDataDir: deps.dataDir || '',
          ...(deps.chatRunDeps || {}),
          delegationId: latest.id,
          attemptId: latest.attemptId,
          assignment: delegationRuntimeAssignment(latest),
        },
      });
      runDelegationCrashHook('after-prompt-accept', /** @type {DelegationRow} */ (getDelegationById(latest.id)) || latest);
      /** @type {any} */ const afterStart = await stopAcceptedRunIfObsolete({
        latest: /** @type {DelegationRow} */ (getDelegationById(latest.id)) || latest,
        started,
        childChatId: latest.childChatId,
      });
      if (isTerminalDelegationStatus(afterStart.status)) return afterStart;
      if (String(afterStart.attemptId || '') !== String(latest.attemptId || '')) return afterStart;
      const running = transition(afterStart, 'running', {
        runId: started.runId,
        startedAt: afterStart.startedAt || new Date().toISOString(),
        runningAt: new Date().toISOString(),
        acceptState: 'accepted',
        runDefaultLimitActive: true,
        // NOTE: the retry budget is deliberately NOT cleared here. Adapter
        // acceptance precedes the authoritative first event, so an accepted but
        // silent run can still time out on the async bridge. The budget is
        // cleared only by the fenced terminal finish in `finishDelegation`
        // (the single point that also decides whether another retry is due).
      }, { expectedRevision: afterStart.revision, expectedAttemptId: latest.attemptId });
      /** @type {any} */ const runningRow = running || afterStart;
      scheduleDelegationHistoryPublish(runningRow, 'running');
      // Plan-window usage is reserved once per delegation. If no earlier attempt
      // ever reached `running` (the synchronous accept path failed before the
      // transition) this is the first real start, so reserve it now; when an
      // earlier attempt already reserved, skip the duplicate.
      if (afterStart.runDefaultLimitActive !== true) reservePlanWindowUsage(runningRow, deps);
      logDelegationEvent('running', runningRow);
      return runningRow;
    } catch (err) {
      /** @type {any} */ const afterErr = await stopAcceptedRunIfObsolete({
        latest: /** @type {DelegationRow} */ (getDelegationById(latest.id)) || latest,
        childChatId: latest.childChatId,
      });
      if (isTerminalDelegationStatus(afterErr.status)) return afterErr;
      return finishDelegation(afterErr, { status: 'failed', error: err?.message || String(err) });
    } finally {
      forgetInFlightStart(latest.id);
    }
  }

  // `finishDelegation` is a standalone export, so the service that owns the
  // runtime dependencies installs this hook at creation time. The newest service
  // wins, matching the single runtime that drives starts.
  startupRetryScheduler = scheduleStartupRetry;

  /**
   * @param {any} record
   * @param {any} parent
   * @param {any} ctx
   */
  async function startDelegationChildRun(record, parent, ctx) {
    // Last gate before an adapter run is accepted. Covers replay/resume paths
    // that reach the start routine without passing the admission checks.
    if (!canAcceptNewRun()) return updateOperationConflict();
    const parentGate = validateDelegationParent(/** @type {ChatRowAny[]} */ (loadChats()).find(row => row.id === parent.id));
    if (!parentGate.ok) {
      const failed = finishDelegation(record, { status: 'failed', error: parentGate.error });
      return { ...parentGate, delegation: failed };
    }
    const runtimeAssignment = delegationRuntimeAssignment(record);
    // A caller that acknowledges at `starting` passes the extras in: any await
    // before the `starting` transition below would delay that acknowledgement
    // until adapter acceptance.
    const reviewExtras = ctx.reviewExtras || await readExecutorPromptExtras({
      parentChatId: parent.id,
      leafId: readDelegationWorkflowLeafIdFromRow(record),
      cwd: ctx.cwd,
      assignment: ctx.assignment,
      executionMode: ctx.executionMode,
      workRole: readRowWorkRole(record),
    });
    const runLessons = resolveRunReviewLessons(record, {
      cwd: ctx.cwd,
      assignment: ctx.assignment,
      model: ctx.model,
      sourceText: ctx.sourceText,
      planMarkdown: ctx.planMarkdown,
      extraInstructions: ctx.extraInstructions,
      leafMaterialText: reviewExtras.leafMaterialText,
    });
    /** @type {any} */ const promptBuilt = buildDelegationExecutorPrompt(/** @type {any} */ ({
      sourceKind: ctx.sourceKind,
      planMarkdown: ctx.planMarkdown,
      taskText: ctx.sourceText,
      parentChatId: parent.id,
      delegationId: record.id,
      sourceHistorySeq: record.sourceHistorySeq,
      workspaceFolder: ctx.executionFolder || ctx.cwd,
      extraInstructions: mergePlanReviewerDelegationExtraInstructions(ctx.extraInstructions, record),
      executionMode: ctx.executionMode,
      assignment: ctx.assignment,
      workRole: readRowWorkRole(record),
      childDelegation: buildChildDelegationPromptInput(record.allowChildDelegations, record.depth, record.workspaceFolder),
      workflowRow: reviewExtras.workflowRow,
      leafAcceptanceText: reviewExtras.leafAcceptanceText,
      leafMaterialText: reviewExtras.leafMaterialText,
      watcherFindingsText: reviewExtras.watcherFindingsText,
      openLedgerFindings: reviewExtras.openLedgerFindings,
      reviewMode: record.reviewMode,
      reviewCanRunTests: record.reviewCanRunTests,
      reviewSubject: record.reviewSubject,
      reviewLessons: runLessons.reviewLessons,
      reviewLessonsEnabled: runLessons.enabled,
      sessionResume: record.sessionResume?.status === 'resumed' ? record.sessionResume : null,
    }));
    // Persist the exposure on every run (empty included); replays keep the first set.
    if (!record.lessonsInjectedAt) {
      record = /** @type {DelegationRow} */ (updateDelegationRecord(record.id, {
        injectedLessonIds: runLessons.injectedLessonIds,
        lessonsInjectedAt: new Date().toISOString(),
      })) || record;
    }
    if (promptBuilt.ok && promptBuilt.prefixFingerprint && record.promptPrefixFingerprint !== promptBuilt.prefixFingerprint) {
      record = /** @type {DelegationRow} */ (updateDelegationRecord(record.id, {
        promptPrefixFingerprint: promptBuilt.prefixFingerprint,
        promptCacheGeneration: Math.max(0, Number(getCacheStateForChat(ctx.childChatId)?.generation) || 0),
      })) || record;
    }
    if (!promptBuilt.ok) {
      const failed = finishDelegation(record, {
        status: 'failed',
        error: promptBuilt.error,
      });
      return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code, delegation: failed };
    }
    let child = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === ctx.childChatId) || null;
    if (!child) {
      try {
        child = /** @type {ChatRowAny} */ (addChat(randomUUID(), ctx.title, parent.workspaceFile, parent.workspaceFolder, ctx.model, /** @type {any} */ ({
          id: ctx.childChatId,
          agentTransport: ctx.transport,
          sdkMode: ctx.executionMode,
          sdkUiMode: parent.sdkUiMode,
          todoId: parent.todoId,
          forkParentChatId: parent.id,
          forkKind: 'delegation',
          delegationParentChatId: parent.id,
          delegationDepth: record.depth,
          delegationRootChatId: record.rootChatId,
          delegationRootDelegationId: record.rootDelegationId,
          delegationGrant: record.allowChildDelegations === true,
          delegationId: record.id,
          delegationAssignment: runtimeAssignment,
          delegationSessionIdentity: record.sessionContinuity?.identity,
          delegationSessionGeneration: record.sessionContinuity?.generation,
          executionFolder: ctx.executionFolder || record.executionFolder,
          widgetInstallationId: parent.widgetInstallationId,
        })));
      } catch (err) {
        const failed = finishDelegation(record, {
          status: 'failed',
          error: err?.message || String(err),
        });
        return { ok: false, status: 500, error: 'Could not create the executor chat.', code: 'child_create_failed', delegation: failed };
      }
    }
    if (record.sessionResume?.status === 'resumed' && String(child.delegationId || '') !== record.id) {
      // A resumed session re-enters under the NEW delegation: its mode, folder
      // and read-only assignment are re-applied, never inherited from the old job.
      child = /** @type {ChatRowAny} */ (updateChat(child.id, /** @type {any} */ ({
        delegationId: record.id,
        delegationAssignment: runtimeAssignment,
        sdkMode: ctx.executionMode,
        executionFolder: ctx.executionFolder || record.executionFolder,
        // Grant and tree position are re-bound too, never inherited.
        delegationGrant: record.allowChildDelegations === true,
        delegationDepth: record.depth,
        delegationRootChatId: record.rootChatId,
        delegationRootDelegationId: record.rootDelegationId,
      }))) || child;
    }
    // The `starting` transition stays in the synchronous prefix of this routine (an MCP caller with
    // `returnWhenStarting` relies on it); the awaited history cards follow the persisted state.
    record = transition(record, 'starting', {
      childChatId: child.id,
      acceptRequestId: record.acceptRequestId || randomUUID(),
      acceptState: 'pending',
    }) || record;
    // Linked after the sync transition so the async todo store never delays it.
    await linkChildChatToTodo(child, parent);
    record = (await applyInheritedVerifyEvidence(record)) || record;
    await appendRelatedChatHistoryLinks({
      parentChat: parent,
      childChat: child,
      reason: 'delegation',
    });
    await publishDelegationStatus(record, 'started');
    // Work-start hook: the attempt is now starting, so a review settles `pending`
    // and an implement/fix keeps the prior review `stale`.
    await safeSyncTodoReview(record, { dataDir: deps.dataDir });
    rememberInFlightStart(record.id, { attemptId: record.attemptId, childChatId: child.id });
    try {
      const started = await startChatRun({
        chatId: child.id,
        prompt: promptBuilt.prompt,
        mode: ctx.executionMode,
        requestId: record.acceptRequestId || record.attemptId,
        displayText: promptBuilt.displayText,
        selectedSkillIds: skillIdsOfRow(record),
        deps: {
          workspaceDirForAgent: deps.workspaceDirForAgent,
          todoSyncDataDir: deps.dataDir || '',
          ...(deps.chatRunDeps || {}),
          delegationId: record.id,
          attemptId: record.attemptId,
          assignment: runtimeAssignment,
        },
      });
      runDelegationCrashHook('after-prompt-accept', record);
      /** @type {any} */ const latest = await stopAcceptedRunIfObsolete({
        latest: /** @type {DelegationRow} */ (getDelegationById(record.id)) || record,
        started,
        childChatId: child.id,
      });
      if (isTerminalDelegationStatus(latest.status)) {
        const failed = latest.status === 'failed';
        // The prompt WAS accepted for this attempt; the run just finished
        // before the running transition. Its usage still counts.
        if (String(latest.attemptId || '') === String(record.attemptId || '')) {
          reservePlanWindowUsage(latest, deps);
        }
        logDelegationEvent('start-already-terminal', latest);
        return {
          ok: !failed,
          status: failed ? 500 : (ctx.createdStatus || 201),
          error: failed ? (latest.error || 'Could not start the executor.') : undefined,
          code: failed ? 'start_failed' : undefined,
          delegation: latest,
          chat: child,
          replayed: ctx.replayed === true,
        };
      }
      if (String(latest.attemptId || '') !== String(record.attemptId || '')) {
        return {
          ok: true,
          status: ctx.createdStatus || 201,
          delegation: latest,
          chat: child,
          replayed: ctx.replayed === true,
        };
      }
      const running = transition(latest, 'running', {
        runId: started.runId,
        startedAt: latest.startedAt || new Date().toISOString(),
        runningAt: new Date().toISOString(),
        acceptState: 'accepted',
        runDefaultLimitActive: true,
      }, {
        expectedRevision: latest.revision,
        expectedAttemptId: latest.attemptId,
      });
      logDelegationEvent('running', running || latest);
      /** @type {any} */ const runningRow = running || latest;
      reservePlanWindowUsage(runningRow, deps);
      if (String(runningRow.pickOriginDetail || '').trim() === MODEL_PICK_EXPLORE_ORIGIN_DETAIL) {
        /** @type {any} */ const explorePick = runningRow.pickId ? getModelPickRecord(String(runningRow.pickId)) : null;
        startModelPickExploreAttemptForDelegation({
          delegationId: runningRow.id,
          marker: explorePick?.explore || null,
          mode: explorePick?.explore?.mode,
        });
      }
      return {
        ok: true,
        status: ctx.createdStatus || 201,
        delegation: runningRow,
        chat: child,
        replayed: ctx.replayed === true,
      };
    } catch (err) {
      /** @type {any} */ const latest = await stopAcceptedRunIfObsolete({
        latest: /** @type {DelegationRow} */ (getDelegationById(record.id)) || record,
        childChatId: child.id,
      });
      if (isTerminalDelegationStatus(latest.status)) {
        return {
          ok: false,
          status: 500,
          error: latest.error || err?.message || 'Could not start the executor.',
          code: err?.code || 'start_failed',
          delegation: latest,
        };
      }
      const failed = finishDelegation(latest, {
        status: 'failed',
        error: err?.message || String(err),
      });
      if (failed && failed.startupRetry && !isTerminalDelegationStatus(failed.status)) {
        // A bounded startup retry was scheduled: keep the slot and the explore
        // attempt, and do NOT cancel — the delayed attempt owns the next start.
        return {
          ok: true,
          status: 202,
          delegation: failed,
          chat: child,
          replayed: ctx.replayed === true,
          startupRetry: failed.startupRetry,
        };
      }
      if (String(latest.pickOriginDetail || '').trim() === MODEL_PICK_EXPLORE_ORIGIN_DETAIL) {
        releaseModelPickExploreAttemptForDelegation({ delegationId: latest.id });
      }
      try {
        await cancelChatRun({ chatId: child.id });
      } catch {
        // Best-effort stop after a failed accept path.
      }
      return {
        ok: false,
        status: 500,
        error: failed?.error || 'Could not start the executor.',
        code: err?.code || 'start_failed',
        delegation: failed,
      };
    } finally {
      forgetInFlightStart(record.id);
    }
  }

  /**
   * @param {string} id
   */
  async function cancel(id) {
    const takeoverConflict = takeoverInProgressResult({ delegationId: id });
    if (takeoverConflict) return takeoverConflict;
    const current = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    if (isCancelUnconfirmedDelegationSlot(current)) {
      return { ok: true, status: 200, delegation: current };
    }
    const fence = readDelegationCancelFence(current);
    if (isTerminalDelegationStatus(current.status)) {
      const stopping = Boolean(String(current.runStoppingAt || '').trim())
        || isChatRunStillActive({ chatId: fence.childChatId, runId: fence.runId });
      if (!stopping) return { ok: true, status: 200, delegation: current };
      try {
        await cancelChatRun({ chatId: fence.childChatId, runId: fence.runId });
      } catch {
        // Keep the terminal result; stop is best-effort.
      }
      const latest = /** @type {DelegationRow} */ (getDelegationById(id)) || current;
      const stale = staleDelegationCancelResult(latest, fence);
      if (stale) return stale;
      const live = probeChatRunLiveness({ chatId: fence.childChatId, runId: fence.runId });
      if (live.known !== true || live.busy === true) {
        return { ok: true, status: 202, pending: true, delegation: latest };
      }
      const released = releaseDelegationRunSlot(latest);
      return { ok: true, status: 200, delegation: released };
    }
    const cancelling = current.status === 'cancelling'
      ? current
      : transition(current, 'cancelling', {}, { expectedAttemptId: fence.attemptId });
    if (!cancelling) {
      return { ok: false, status: 409, error: 'This delegation cannot be stopped.', code: 'cancel_blocked' };
    }
    const staleBeforeAdapter = staleDelegationCancelResult(cancelling, fence);
    if (staleBeforeAdapter) return staleBeforeAdapter;
    scheduleDelegationHistoryPublish(cancelling, 'cancelling');
    let cancelFailed = false;
    try {
      await cancelChatRun({ chatId: fence.childChatId, runId: fence.runId });
    } catch {
      cancelFailed = true;
    }
    const latest = /** @type {DelegationRow} */ (getDelegationById(id)) || cancelling;
    const staleAfterAdapter = staleDelegationCancelResult(latest, fence);
    if (staleAfterAdapter) return staleAfterAdapter;
    if (isCancelUnconfirmedDelegationSlot(latest) || latest.status !== 'cancelling') {
      return { ok: true, status: 200, delegation: latest };
    }
    const live = probeChatRunLiveness({ chatId: fence.childChatId, runId: fence.runId });
    const stillBusy = cancelFailed || live.busy === true || live.known !== true;
    const startInFlight = hasInFlightDelegationStart(id);
    if (stillBusy || startInFlight || !delegationHarnessSupportsAbort(latest)) {
      return {
        ok: true,
        status: 202,
        pending: true,
        delegation: latest,
      };
    }
    const cancelled = finishCancellingWithStopProof(latest, {
      finishDelegation,
      status: 'cancelled',
      attemptId: fence.attemptId,
      runId: fence.runId,
      proofKind: 'adapter_abort',
      proofSource: 'delegation_cancel',
    });
    return { ok: true, status: 200, delegation: cancelled };
  }

  /**
   * @param {string} id
   * @param {any} input
   */
  async function confirmManualSlotRelease(id, input = {}) {
    /** @type {any} */ const row = /** @type {DelegationRow} */ (getDelegationById(id));
    return confirmDelegationManualSlotRelease(row, input);
  }

  /**
   * Cancel one node and every descendant it started (transitively): leaves
   * first, then ancestors, up to the node itself. Each node goes through the
   * single-job `cancel`, so run fences, `runStoppingAt`, outbox/mailbox closing
   * and slot release behave exactly as for a lone job. A node already in
   * `cancelling` is finished through `cancel` only when its run is confirmed
   * stopped, otherwise it is left alone and reported as `cancelling` (no second
   * adapter cancel); within one call no node is driven twice,
   * and a partial failure never aborts the remaining nodes. Idempotent: a
   * repeat only re-drives nodes whose stop is still unconfirmed and returns
   * the same summary shape.
   *
   * @param {string} id Delegation id; its subtree (the whole tree for a root).
   * @returns {Promise<Record<string, any>>}
   */
  async function cancelTree(id) {
    const takeoverConflict = takeoverInProgressResult({ delegationId: id });
    if (takeoverConflict) return takeoverConflict;
    const start = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!start) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const nodes = new Map();
    const outcomeRank = { failed: 4, pending: 3, cancelling: 2, cancelled: 1, already_terminal: 0 };
    const record = (nodeId, outcome, extra = {}) => {
      const prev = nodes.get(nodeId);
      if (prev && outcomeRank[prev.outcome] >= outcomeRank[outcome]) return;
      nodes.set(nodeId, { id: nodeId, outcome, ...extra });
    };
    const driven = new Set();
    // A parent that is still running may start a new child while its subtree is
    // being stopped, so collect again until no live node is left (bounded).
    for (let pass = 0; pass < 3; pass += 1) {
      const subtree = collectDelegationSubtreePostOrder({
        start: /** @type {DelegationRow} */ (getDelegationById(id)),
        rows: /** @type {DelegationRow[]} */ (listDelegationsForTreeRoot(resolveRecordTreeFields(start).rootDelegationId)),
      });
      let touched = false;
      for (const row of subtree) {
        /** @type {any} */ const before = /** @type {DelegationRow} */ (getDelegationById(/** @type {any} */ (row).id)) || row;
        const stopping = Boolean(String(before.runStoppingAt || '').trim());
        if (isTerminalDelegationStatus(before.status) && before.status !== 'cancelling' && !stopping) {
          record(before.id, 'already_terminal', { status: before.status });
          continue;
        }
        // A node this call already drove is not driven again; one that was
        // already `cancelling` before the call is finished like a lone cancel.
        if (driven.has(before.id)) {
          record(before.id, before.status === 'cancelling' ? 'cancelling' : 'already_terminal', {
            status: before.status,
          });
          continue;
        }
        if (before.status === 'cancelling') {
          // Only a `cancelling` node whose run is confirmed stopped is finished;
          // one still stopping is left alone (no second adapter cancel).
          const fence = readDelegationCancelFence(before);
          const live = probeChatRunLiveness({ chatId: fence.childChatId, runId: fence.runId });
          if (live.known !== true || live.busy === true || hasInFlightDelegationStart(before.id)) {
            record(before.id, 'cancelling', { status: before.status });
            continue;
          }
        }
        driven.add(before.id);
        touched = true;
        try {
          /** @type {any} */ const result = await cancel(before.id);
          const after = result?.delegation || /** @type {DelegationRow} */ (getDelegationById(before.id)) || before;
          if (!result?.ok) {
            record(before.id, 'failed', {
              status: String(after.status || ''),
              error: String(result?.error || 'Cancel failed.'),
              code: String(result?.code || 'cancel_failed'),
            });
          } else if (result.pending === true || result.status === 202) {
            record(before.id, 'pending', { status: String(after.status || '') });
          } else if (after.status === 'cancelled') {
            record(before.id, 'cancelled', { status: 'cancelled' });
          } else {
            record(before.id, 'already_terminal', { status: String(after.status || '') });
          }
        } catch (err) {
          record(before.id, 'failed', {
            status: String(before.status || ''),
            error: err?.message || String(err),
            code: 'cancel_failed',
          });
        }
      }
      if (!touched) break;
    }
    const list = [...nodes.values()];
    const count = (outcome) => list.filter((node) => node.outcome === outcome).length;
    const failed = list
      .filter((node) => node.outcome === 'failed')
      .map((node) => ({ id: node.id, error: node.error || '', code: node.code || '' }));
    return {
      ok: failed.length === 0,
      status: failed.length === 0 ? 200 : 207,
      root_delegation_id: id,
      total: list.length,
      cancelled: count('cancelled'),
      already_terminal: count('already_terminal'),
      cancelling: count('cancelling'),
      pending: count('pending'),
      failed,
      nodes: list.map((node) => ({ id: node.id, outcome: node.outcome, status: node.status || '' })),
      status_of_root: String((/** @type {DelegationRow} */ (getDelegationById(id)) || start).status || ''),
    };
  }

  /**
   * @param {string} id
   * @param {{
   *   reason?: string,
   *   actor?: string,
   *   expectedAttemptId?: string,
   *   expectedMaterialRevision?: string,
   *   expectedTodoRevision?: string,
   * }} [input]
   */
  async function acknowledge(id, input = {}) {
    const takeoverConflict = takeoverInProgressResult({ delegationId: id });
    if (takeoverConflict) return takeoverConflict;
    const current = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const reason = String(input.reason || 'reviewed').trim() || 'reviewed';
    // The actor is a channel signal derived server-side, never a body field a
    // client can choose (`docs/todo-review-contract.md` §7.2). A caller that
    // supplies nothing is an internal/unknown channel — never `human`.
    const actor = normalizeDelegationAckActor(input.actor) || 'unknown';
    // Acceptance carries the attempt and material (and optionally todo) revision
    // the card displayed; a stale screen is rejected instead of accepted (§7.3).
    const expectedAttemptId = String(input.expectedAttemptId || /** @type {any} */ (input).expected_attempt_id || '').trim();
    if (expectedAttemptId && expectedAttemptId !== String(current.attemptId || '').trim()) {
      return {
        ok: false,
        status: 409,
        error: 'The delegation attempt changed since this screen was loaded. Refresh and accept again.',
        code: 'ack_attempt_mismatch',
        delegation: current,
      };
    }
    // Three distinct client states (§6.3): OMITTED (`undefined`: the screen
    // never captured anything), CAPTURED EMPTY (`''`: the screen saw "detection
    // unavailable"/"unattributed") and CAPTURED VALUE. An omitted expectation
    // must not bypass a comparison the server can make, and a captured empty one
    // must not hide a now-known current value.
    const expectedMaterialRaw = readOptionalExpectation(
      input.expectedMaterialRevision,
      /** @type {any} */ (input).expected_material_revision,
    );
    const isHumanAcceptance = actor === 'human' && reason === 'accepted';
    let actualMaterialRevision = '';
    try {
      actualMaterialRevision = readDelegationMaterialRevisionForRecord(current);
    } catch {
      actualMaterialRevision = '';
    }
    if (isHumanAcceptance && actualMaterialRevision && expectedMaterialRaw === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'Accepting this card requires the material revision it displayed.',
        code: 'accept_expectation_required',
      };
    }
    // An unavailable current fingerprint means "detection unavailable" (§6.3),
    // never a mismatch; only a known current revision that differs rejects.
    const materialIsExpected = isHumanAcceptance
      ? expectedMaterialRaw !== undefined
      : !!expectedMaterialRaw;
    if (materialIsExpected && actualMaterialRevision && actualMaterialRevision !== expectedMaterialRaw) {
      return {
        ok: false,
        status: 409,
        error: 'The workspace material changed since this screen was loaded. Refresh and accept again.',
        code: 'ack_material_mismatch',
        delegation: current,
      };
    }
    const expectedTodoRaw = readOptionalExpectation(
      input.expectedTodoRevision,
      /** @type {any} */ (input).expected_todo_revision,
    );
    const expectedTodoRevision = expectedTodoRaw || '';
    const todoTarget = await resolveDelegationAcceptTodo(current, {
      dataDir: deps.dataDir || resolveDataPath(),
    });
    const knownTodoRevision = todoTarget.resolution === 'exact' || todoTarget.resolution === 'prefix'
      ? todoTarget.revision
      : '';
    if (isHumanAcceptance && knownTodoRevision && expectedTodoRaw === undefined) {
      return {
        ok: false,
        status: 400,
        error: 'Accepting this card requires the todo revision it displayed.',
        code: 'accept_expectation_required',
      };
    }
    // An attributed job whose target cannot be resolved (missing, ambiguous,
    // unreadable) is not "intentionally unattributed": a captured-empty
    // expectation must not accept it.
    if (isHumanAcceptance && todoTarget.leafId && !knownTodoRevision) {
      return {
        ok: false,
        status: 409,
        error: todoTarget.resolution === 'unavailable'
          ? 'The todo could not be read. Refresh and accept again.'
          : 'The todo this job is attributed to is missing or ambiguous. Refresh and accept again.',
        code: todoTarget.resolution === 'unavailable'
          ? 'ack_todo_unavailable'
          : 'ack_todo_revision_mismatch',
        delegation: current,
      };
    }
    const todoIsExpected = isHumanAcceptance ? expectedTodoRaw !== undefined : !!expectedTodoRaw;
    if (todoIsExpected && knownTodoRevision !== (expectedTodoRaw || '')) {
      // Also covers a todo that was deleted or became ambiguous after the card
      // displayed a revision: the screen can no longer be verified, so it is
      // stale rather than accepted.
      return {
        ok: false,
        status: 409,
        error: 'The todo changed since this screen was loaded. Refresh and accept again.',
        code: 'ack_todo_revision_mismatch',
        delegation: current,
      };
    }
    const status = current.status;
    const isWaiting = status === 'waiting_for_input';
    const isTerminalAttention = status === 'completed' || status === 'failed' || status === 'interrupted';
    if (reason === 'open_child') {
      if (!isWaiting) return { ok: true, status: 200, delegation: current, skipped: true };
      const next = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
        acknowledgedAt: new Date().toISOString(),
        acknowledgedReason: reason,
        acknowledgedActor: actor,
      }));
      // A human acceptance can set `manual`; an agent/system ack is
      // decision-identical and produces no write.
      await safeSyncTodoReview(next || current, { dataDir: deps.dataDir });
      return { ok: true, status: 200, delegation: next };
    }
    if (!isWaiting && !isTerminalAttention) {
      return { ok: true, status: 200, delegation: current, skipped: true };
    }
    const next = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, {
      acknowledgedAt: new Date().toISOString(),
      acknowledgedAttemptId: current.attemptId || '',
      acknowledgedReason: reason,
      acknowledgedActor: actor,
      // Audit trail of the CAS: the revision the accepting screen displayed
      // (`docs/todo-review-contract.md` §5.4 `acceptance.expectedTodoRevision`).
      acknowledgedExpectedTodoRevision: expectedTodoRevision,
      unverified: isTerminalAttention ? false : current.unverified,
    }));
    if (isTerminalAttention && next) await publishDelegationStatus(next, 'acknowledged');
    // Recompute after the acceptance write so `review.*.state` can reflect it.
    await safeSyncTodoReview(next || current, { dataDir: deps.dataDir });
    return { ok: true, status: 200, delegation: next || current };
  }

  /**
   * Base model id used for the anti-bias check. `''` for missing/Auto values
   * so an unknown parent model skips the check instead of blocking a rating.
   *
   * @param {unknown} value
   * @returns {string}
   */
  function baseModelIdOf(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const decoded = decodeModelValue(raw);
    const id = String(decoded.modelId || '').trim().toLowerCase();
    return !id || id === 'auto' ? '' : id;
  }

  /**
   * Anti-bias: a parent must not rate a job whose executor runs the parent's
   * own base model (the rating would be self-confirming). Comparison is on the
   * base id only, so the same model on another harness is still denied. The
   * check applies to `parent` ratings; the app-wide `user` rater has no model.
   *
   * @param {DelegationRow} row
   * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
   */
  function inspectParentRatingBias(row) {
    const parent = findControllerChat(row);
    const parentBase = baseModelIdOf(parent?.model);
    const executorBase = baseModelIdOf(row.executor?.model);
    if (!parentBase || !executorBase || parentBase !== executorBase) return { ok: true };
    return {
      ok: false,
      status: 409,
      code: 'self_model_rating_denied',
      error: 'A parent cannot rate a job on its own base model. Rate a job run by another model.',
    };
  }

  /**
   * Store one rating. The rater comes from the transport (MCP = parent, card
   * HTTP = user) and is validated here; callers must not forward an
   * input-supplied rater. Ratings are immutable per (job, rater): an identical
   * payload replays as success, a changed one conflicts.
   *
   * @param {string} id
   * @param {{ rater?: unknown, score?: unknown, tags?: unknown, note?: unknown }} input
   * @returns {Promise<{ ok: boolean, status: number, code?: string, error?: string,
   *   replayed?: boolean, rating?: object | null, delegation?: object }>}
   */
  async function rate(id, input = {}) {
    const takeoverConflict = takeoverInProgressResult({ delegationId: id });
    if (takeoverConflict) return takeoverConflict;
    const current = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    if (!isTerminalDelegationStatus(current.status)) {
      return {
        ok: false,
        status: 409,
        error: 'Only a finished job can be rated.',
        code: 'not_terminal',
      };
    }
    const rater = normalizeDelegationRatingRater(input.rater);
    if (!rater) {
      return {
        ok: false,
        status: 400,
        error: `rater must be one of: ${DELEGATION_RATING_RATERS.join(', ')}.`,
        code: 'invalid_rater',
      };
    }
    /** @type {any} */ const payload = normalizeDelegationRatingPayload(input);
    if (!payload.ok) return { ok: false, status: payload.status, error: payload.error, code: payload.code };
    const fingerprint = fingerprintDelegationRating(payload.value);
    /** @type {any} */ const existing = findDelegationRating(current.id, rater);
    if (existing) {
      if (String(existing.fingerprint || '') === fingerprint) {
        return { ok: true, status: 200, replayed: true, rating: existing, delegation: current };
      }
      return {
        ok: false,
        status: 409,
        error: 'This job already has a rating from this rater. Ratings are immutable.',
        code: 'idempotency_conflict',
      };
    }
    if (rater === 'parent') {
      const bias = inspectParentRatingBias(current);
      if (!bias.ok) return /** @type {any} */ ({ ...bias, delegation: current });
    }
    const executor = current.executor && typeof current.executor === 'object' ? current.executor : {};
    const model = String(executor.model || '').trim();
    const record = {
      delegationId: current.id,
      parentChatId: String(current.parentChatId || '').trim(),
      harness: String(executor.transport || '').trim().toLowerCase(),
      model: model ? baseModelIdOf(model) : '',
      role: delegationPersistedRole(current),
      rater,
      score: payload.value.score,
      tags: payload.value.tags,
      note: payload.value.note,
      ts: new Date().toISOString(),
      fingerprint,
    };
    if (!appendDelegationRating(record)) {
      return {
        ok: false,
        status: 500,
        error: 'Could not persist the rating.',
        code: 'rating_write_failed',
      };
    }
    let latest = /** @type {DelegationRow} */ (getDelegationById(current.id)) || current;
    if (rater === 'user') {
      // The card reads its rating from the history payload, so the user rating
      // publishes a (metadata-only) card event; a parent rating does not.
      const published = await publishDelegationStatus(latest, 'rated');
      latest = /** @type {DelegationRow} */ (published) || latest;
    }
    return {
      ok: true,
      status: 200,
      replayed: false,
      rating: record,
      delegation: /** @type {DelegationRow} */ (getDelegationById(current.id)) || latest,
    };
  }

  /**
   * @param {string} chatId
   */
  async function cancelForDeletedChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return { ok: true };
    const takeoverConflict = takeoverInProgressResult({ chatId: id });
    if (takeoverConflict) return takeoverConflict;
    const rows = /** @type {DelegationRow[]} */ (loadDelegations()).filter((row) => {
      // Deleting the historical starter must not cancel a job another chat controls.
      if (row.childChatId !== id && delegationController(row) !== id) return false;
      return isActiveDelegationStatus(row.status);
    });
    for (const row of rows) {
      /** @type {any} */ const result = await cancel(row.id);
      if (!result.ok) {
        return {
          ok: false,
          status: 409,
          error: result.error || 'Could not stop the executor run.',
          code: result.code || 'cancel_failed',
        };
      }
      if (!result.pending) continue;
      let latest = /** @type {DelegationRow} */ (getDelegationById(row.id));
      if (!latest || latest.status !== 'cancelling') continue;
      const now = Date.now();
      let live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
      const busy = live.busy === true || live.known !== true || hasInFlightDelegationStart(latest.id);
      const outcome = resolveCancellingDeadline(latest, now, {
        busy,
        known: live.known === true,
      }, { finishDelegation, hasInFlightDelegationStart });
      if (outcome === 'released' || outcome === 'escalated') continue;
      latest = /** @type {DelegationRow} */ (getDelegationById(row.id)) || latest;
      if (latest.status !== 'cancelling') continue;
      live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
      const stillBusy = live.busy === true || live.known !== true || hasInFlightDelegationStart(latest.id);
      if (!stillBusy && delegationHarnessSupportsAbort(latest)) {
        finishCancellingWithStopProof(latest, {
          finishDelegation,
          status: 'cancelled',
          proofKind: 'adapter_abort',
          proofSource: 'chat_delete_cancel',
        });
        continue;
      }
      return {
        ok: false,
        status: 409,
        error: 'Could not stop the executor run.',
        code: 'cancel_pending',
      };
    }
    return { ok: true };
  }

  /**
   * @param {string} id
   */
  async function retry(id) {
    const takeoverConflict = takeoverInProgressResult({ delegationId: id });
    if (takeoverConflict) return takeoverConflict;
    const wantedId = String(id || '').trim();
    if (!wantedId) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const existingRetry = retryJobInFlight.get(wantedId);
    if (existingRetry) return existingRetry;
    let settle;
    const pending = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    retryJobInFlight.set(wantedId, pending);
    retryUnlocked(wantedId).then(settle.resolve, settle.reject).finally(() => {
      if (retryJobInFlight.get(wantedId) === pending) retryJobInFlight.delete(wantedId);
    });
    return pending;
  }

  /**
   * @param {string} id
   */
  async function retryUnlocked(id) {
    if (!isDelegationRuntimeAcceptingWork()) {
      return {
        ok: false,
        status: 503,
        error: 'Delegation runtime is not ready to accept new jobs.',
        code: 'runtime_not_ready',
        state: getDelegationLifecycleState(),
      };
    }
    if (!canAcceptNewRun()) return updateOperationConflict();
    const current = /** @type {DelegationRow} */ (getDelegationById(id));
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    return withParentLock(delegationController(current), async () => {
      const latest = /** @type {DelegationRow} */ (getDelegationById(id));
      if (!latest) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
      if (isActiveDelegationStatus(latest.status) || isDelegationSlotOccupied(latest)) {
        const blocker = inspectDelegationSlot(latest);
        return slotConflict(blocker, 'still_active', 'This delegation is still active.');
      }
      const interruptedGate = inspectInterruptedRetryGate(latest);
      if (!interruptedGate.ok) return interruptedGate;
      // Retention cleared the task text of an archived job; a retry would start
      // the executor with an empty assignment.
      if (String(latest.archivedAt || '').trim()
        && !String(latest.sourceText || '').trim()
        && !String(latest.planMarkdown || '').trim()) {
        return {
          ok: false,
          status: 409,
          error: 'This delegation was archived and its task text was trimmed. Start a new delegation instead of retrying it.',
          code: 'delegation_archived',
        };
      }
      const parent = findControllerChat(latest);
      const startGate = validateDelegationExecutorStart({
        parent,
        executor: latest.executor,
        isModelAvailable,
        resolveCwd,
        resolveExecutionFolder,
      });
      if (!startGate.ok) return startGate;
      const previousAttemptSummary = [latest.report, latest.error].filter(Boolean).join('\n');
      const assignment = normalizeDelegationAssignment(latest.assignment, latest.executionMode);
      const executionMode = resolveDelegationChildExecutionMode(
        latest.executionMode,
        assignment,
        parent.sdkMode,
      );
      // Retry reuses the frozen logical workspace and execution folder; only a
      // legacy row without a recorded execution folder falls back to the parent.
      const retryWorkspaceFolder = latest.workspaceFolder || startGate.cwd;
      const retryExecutionFolder = latest.executionFolder
        || startGate.executionFolder
        || retryWorkspaceFolder;
      const workflowLeafIdRetry = readDelegationWorkflowLeafIdFromRow(latest);
      const reviewExtras = await readExecutorPromptExtras({
        parentChatId: delegationController(latest),
        leafId: workflowLeafIdRetry,
        cwd: retryWorkspaceFolder,
        assignment,
        executionMode,
        workRole: readRowWorkRole(latest),
      });
      const retryLessons = resolveRunReviewLessons(latest, {
        cwd: retryWorkspaceFolder,
        assignment,
        model: latest.executor?.model,
        sourceText: latest.sourceText,
        planMarkdown: latest.planMarkdown,
        extraInstructions: latest.extraInstructions,
        leafMaterialText: reviewExtras.leafMaterialText,
      });
      const codeReviewGateRetry = inspectDelegationCodeReviewStart({
        assignment,
        reviewSubject: latest.reviewSubject,
        leafId: workflowLeafIdRetry,
        workflow: reviewExtras.workflowRow,
        workspaceFolder: latest.workspaceFolder,
      });
      if (!codeReviewGateRetry.ok) return codeReviewGateRetry;
      /** @type {any} */ const promptBuilt = buildDelegationExecutorPrompt(/** @type {any} */ ({
        sourceKind: latest.sourceKind,
        planMarkdown: latest.planMarkdown,
        taskText: latest.sourceText,
        parentChatId: delegationController(latest),
        delegationId: latest.id,
        sourceHistorySeq: latest.sourceHistorySeq,
        workspaceFolder: retryExecutionFolder,
        extraInstructions: latest.extraInstructions,
        previousAttemptSummary,
        executionMode,
        assignment,
        workRole: readRowWorkRole(latest),
        childDelegation: buildChildDelegationPromptInput(latest.allowChildDelegations, latest.depth, latest.workspaceFolder),
        workflowRow: reviewExtras.workflowRow,
        leafAcceptanceText: reviewExtras.leafAcceptanceText,
        leafMaterialText: reviewExtras.leafMaterialText,
        watcherFindingsText: reviewExtras.watcherFindingsText,
        openLedgerFindings: reviewExtras.openLedgerFindings,
        reviewMode: latest.reviewMode || codeReviewGateRetry.mode,
        reviewCanRunTests: latest.reviewCanRunTests,
        reviewSubject: latest.reviewSubject,
        reviewLessons: retryLessons.reviewLessons,
        reviewLessonsEnabled: retryLessons.enabled,
      }));
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      // Backfill the runner cwd on a child chat created before the split.
      if (retryExecutionFolder && latest.childChatId) {
        const existingChild = /** @type {ChatRowAny[]} */ (loadChats()).find((row) => row.id === latest.childChatId);
        if (existingChild && String(existingChild.executionFolder || '').trim() !== retryExecutionFolder) {
          /** @type {ChatRowAny} */ (updateChat(existingChild.id, { executionFolder: retryExecutionFolder }));
        }
      }
      /** @type {any} */ const reviewGate = isPlanAuthoringDelegationRow(latest)
        ? assertPlannerAdapterAllowed(startGate.transport, { env: resolveDelegationEnv(latest.workspaceFolder) })
        : assignment === 'review'
          ? assertReviewAdapterAllowed(startGate.transport, { env: resolveDelegationEnv(latest.workspaceFolder) })
          : { ok: true };
      if (!reviewGate.ok) return reviewGate;
      const workflowLeafId = readDelegationWorkflowLeafIdFromRow(latest);
      const workflowGate = inspectDelegationWorkflowStart({
        parentChatId: delegationController(latest),
        assignment,
        leafId: workflowLeafId,
      });
      if (!workflowGate.ok) return workflowGate;
      const widthBlock = await parentWidthConflict({
        parentChatId: delegationController(latest),
        incomingAssignment: delegationRuntimeAssignment(latest),
        resumeDelegationId: latest.id,
        gate: 'retry',
        workspaceFolder: retryWorkspaceFolder,
        executionFolder: retryExecutionFolder,
        incomingLeafId: workflowLeafId,
        dataDir: deps.dataDir,
      });
      if (widthBlock) return widthBlock;
      const parentRecheck = validateDelegationParent(/** @type {ChatRowAny[]} */ (loadChats()).find(row => row.id === parent.id));
      if (!parentRecheck.ok) return parentRecheck;
      // Same synchronous re-check as a new start: an update claimed during the
      // awaits above must not let this retry start a child run.
      if (!canAcceptNewRun()) return updateOperationConflict();
      const attemptId = randomUUID();
      const acceptRequestId = randomUUID();
      // Legacy records never pinned an exposure; a pinned one stays untouched.
      const lessonsPatch = latest.lessonsInjectedAt
        ? {}
        : { injectedLessonIds: retryLessons.injectedLessonIds, lessonsInjectedAt: new Date().toISOString() };
      const archived = snapshotDelegationAttempt(latest);
      const usedServerRestartContinuation = normalizeDelegationInterruptCode(latest.interruptCode) === DELEGATION_INTERRUPT_SERVER_RESTART;
      const starting = transition(latest, 'starting', {
        ...lessonsPatch,
        executionMode,
        assignment,
        attemptId,
        acceptRequestId,
        acceptState: 'pending',
        runId: '',
        finishedAt: '',
        error: '',
        report: '',
        // A retry is a fresh attempt: the previous attempt's verdict, verify and
        // acceptance evidence are archived in `attempts[]` and must not leak onto
        // the new one (`docs/todo-review-contract.md` §5.2). `reviewSubject` is
        // job-level, not attempt-level, so the retried job keeps its subject.
        reportVerdict: '',
        reportDegraded: false,
        reportSummary: '',
        verifyResult: null,
        queuedAt: new Date().toISOString(),
        historyDeliveredAt: '',
        reportDeliveredAt: '',
        reportDeliveryId: '',
        taskOutcome: 'unspecified',
        interruptCode: '',
        // Attempt-scoped deadline evidence: a PASS on the retried attempt must
        // not read as a reviewer timeout.
        cancelCause: '',
        runDeadlineCancelKey: '',
        interruptContinuedAt: usedServerRestartContinuation
          ? new Date().toISOString()
          : String(latest.interruptContinuedAt || '').trim(),
        runStoppingAt: '',
        finalReportAcceptedAt: '',
        finalReportAttemptId: '',
        finalReportRunId: '',
        // Metrics belong to the attempt that produced them; the archived
        // snapshot keeps the old ones, the fresh attempt starts unmeasured.
        metrics: resetMetricsPatch(),
        unverified: true,
        acknowledgedAt: '',
        acknowledgedAttemptId: '',
        acknowledgedReason: '',
        acknowledgedActor: '',
        acknowledgedExpectedTodoRevision: '',
        attempts: [...(Array.isArray(latest.attempts) ? latest.attempts : []), archived],
      });
      await applyInheritedVerifyEvidence(starting || latest);
      logDelegationEvent('retry', starting || latest, { attemptId });
      // The fresh attempt supersedes any armed pause, whatever the start
      // outcome; refusals above leave the row untouched and never reach here.
      // Only `armed` rows are cancelled, so a scheduler `resuming` row stays.
      cancelSubjectUsageLimitPauses({ subjectType: 'delegation', subjectId: latest.id, reason: 'manual_retry' });
      // Retry opens a new attempt: recompute so a superseded PASS cannot stay
      // current while the fresh attempt runs (`§4.6`, `§5.2`).
      await safeSyncTodoReview(starting || latest, { dataDir: deps.dataDir });
      rememberInFlightStart(latest.id, { attemptId, childChatId: latest.childChatId });
      try {
        const started = await startChatRun({
          chatId: latest.childChatId,
          prompt: promptBuilt.prompt,
          mode: executionMode,
          requestId: acceptRequestId,
          displayText: promptBuilt.displayText,
          selectedSkillIds: skillIdsOfRow(latest),
          deps: {
            workspaceDirForAgent: deps.workspaceDirForAgent,
            todoSyncDataDir: deps.dataDir || '',
            ...(deps.chatRunDeps || {}),
            delegationId: latest.id,
            attemptId,
            assignment: delegationRuntimeAssignment(starting || latest),
          },
        });
        runDelegationCrashHook('after-prompt-accept', starting || latest);
        /** @type {any} */ const afterStart = await stopAcceptedRunIfObsolete({
          latest: /** @type {DelegationRow} */ (getDelegationById(latest.id)) || starting || latest,
          started,
          childChatId: latest.childChatId,
        });
        if (isTerminalDelegationStatus(afterStart.status)) {
          const failed = afterStart.status === 'failed';
          if (String(afterStart.attemptId || '') === attemptId) reservePlanWindowUsage(afterStart, deps);
          return tagReviewUncertified({
            ok: !failed,
            status: failed ? 500 : 200,
            error: failed ? (afterStart.error || 'Retry failed.') : undefined,
            code: failed ? 'start_failed' : undefined,
            delegation: afterStart,
          }, reviewGate.reviewUncertified);
        }
        if (String(afterStart.attemptId || '') !== attemptId) {
          return tagReviewUncertified({ ok: true, status: 200, delegation: afterStart }, reviewGate.reviewUncertified);
        }
        const running = transition(afterStart, 'running', {
          runId: started.runId,
          startedAt: new Date().toISOString(),
          runningAt: new Date().toISOString(),
          acceptState: 'accepted',
        }, {
          expectedRevision: afterStart.revision,
          expectedAttemptId: attemptId,
        });
        scheduleDelegationHistoryPublish(running || afterStart, 'retry');
        reservePlanWindowUsage(running || afterStart, deps);
        return tagReviewUncertified({ ok: true, status: 200, delegation: running || afterStart }, reviewGate.reviewUncertified);
      } catch (err) {
        /** @type {any} */ const afterErr = await stopAcceptedRunIfObsolete({
          latest: /** @type {DelegationRow} */ (getDelegationById(latest.id)) || latest,
          childChatId: latest.childChatId,
        });
        if (isTerminalDelegationStatus(afterErr.status)) {
          return tagReviewUncertified({
            ok: false,
            status: 500,
            error: afterErr.error || err?.message || 'Retry failed.',
            code: err?.code || 'start_failed',
            delegation: afterErr,
          }, reviewGate.reviewUncertified);
        }
        const failed = finishDelegation(afterErr, {
          status: 'failed',
          error: err?.message || String(err),
        });
        if (failed && failed.startupRetry && !isTerminalDelegationStatus(failed.status)) {
          // Bounded startup retry scheduled: keep the slot, do not cancel.
          return tagReviewUncertified({
            ok: true,
            status: 202,
            delegation: failed,
            startupRetry: failed.startupRetry,
          }, reviewGate.reviewUncertified);
        }
        try {
          await cancelChatRun({ chatId: latest.childChatId });
        } catch {
          // Best-effort stop after a failed retry accept path.
        }
        return tagReviewUncertified({
          ok: false,
          status: 500,
          error: failed?.error || 'Retry failed.',
          code: err?.code || 'start_failed',
          delegation: failed,
        }, reviewGate.reviewUncertified);
      } finally {
        forgetInFlightStart(latest.id);
      }
    });
  }

  /**
   * Resume a parent's queued jobs oldest-first once its slot frees. Under the
   * parent lock so it serializes with a concurrent create/retry. Never throws:
   * a start error finishes that record and the pass moves to the next one; a
   * still-held slot stops the pass (the runtime tick retries).
   *
   * @param {string} parentChatId
   * @returns {Promise<string[]>} started delegation ids
   */
  async function drainQueueForController(parentChatId) {
    // Keep every parked job queued while an update/install owns the files.
    // The runtime tick retries this pass after the operation ends.
    if (!canAcceptNewRun()) return [];
    const queued = listQueuedForControllerSorted(parentChatId);
    /** @type {string[]} */
    const started = [];
    for (const row of queued) {
      const gate = await parentWidthConflict({
        parentChatId,
        incomingAssignment: delegationRuntimeAssignment(row),
        resumeDelegationId: row.id,
        gate: 'start',
        workspaceFolder: row.workspaceFolder,
        executionFolder: row.executionFolder || row.workspaceFolder,
        ignoreQueued: true,
        incomingLeafId: readDelegationWorkflowLeafIdFromRow(row),
        dataDir: deps.dataDir,
      });
      if (gate) {
        // Transient slot / workspace / global hold: keep FIFO head parked.
        break;
      }
      const parent = /** @type {ChatRowAny[]} */ (loadChats()).find((chat) => chat.id === parentChatId);
      if (!parent) {
        try {
          finishDelegation(row, { status: 'failed', error: 'Parent chat is missing; queued job cannot start.' });
        } catch {
          // Best effort — a corrupt finish is retried by the runtime worker.
        }
        continue;
      }
      const parentGate = validateDelegationParent(parent);
      if (!parentGate.ok) {
        try {
          finishDelegation(row, {
            status: parentGate.code === 'parent_archived' || parentGate.code === 'parent_cancelling'
              ? 'cancelled'
              : 'failed',
            error: parentGate.error,
          });
        } catch {
          // Best effort — archived parents must not wedge the queue forever.
        }
        continue;
      }
      const startGate = validateDelegationExecutorStart({
        parent,
        executor: row.executor,
        isModelAvailable,
        resolveCwd,
        resolveExecutionFolder,
      });
      if (!startGate.ok) {
        try {
          finishDelegation(row, { status: 'failed', error: startGate.error || 'Executor cannot start.' });
        } catch {
          // Best effort — validation failures are permanent for this row.
        }
        continue;
      }
      const { validateWorkspaceWatcherParentDelegation } = await import('./workspace-watcher-delegation-guard.js');
      /** @type {any} */ const watcherGate = await validateWorkspaceWatcherParentDelegation({
        parentChatId,
        executor: row.executor,
        assignment: isPlanAuthoringDelegationRow(row)
          ? 'plan'
          : normalizeDelegationAssignment(row.assignment, row.executionMode),
        reviewSubject: row.reviewSubject,
        dataDir: resolveDataPath(),
      });
      if (!watcherGate.ok) {
        try {
          finishDelegation(row, { status: 'failed', error: watcherGate.error || 'Workspace watcher blocked start.' });
        } catch {
          // Best effort — watcher refusal is permanent for this parked row.
        }
        continue;
      }
      const ctx = {
        cwd: row.workspaceFolder,
        executionFolder: row.executionFolder || row.workspaceFolder,
        sourceKind: row.sourceKind,
        sourceText: row.sourceText,
        planMarkdown: row.planMarkdown,
        extraInstructions: row.extraInstructions,
        executionMode: row.executionMode,
        assignment: row.assignment,
      };
      try {
        const resumed = await resumeExistingDelegation(row, parent, ctx, { fromDrain: true });
        const after = /** @type {DelegationRow} */ (getDelegationById(row.id));
        if (after && isTerminalDelegationStatus(after.status)) {
          continue;
        }
        if (resumed?.queued === true) {
          break;
        }
        if (resumed && resumed.ok === false) {
          if (resumed.code === 'parent_archived' || resumed.code === 'chat_not_found') {
            try {
              finishDelegation(row, { status: 'failed', error: resumed.error || 'Parent unavailable.' });
            } catch {
              // Best effort.
            }
            continue;
          }
          break;
        }
        if (resumed && resumed.ok === true && after && String(after.status || '') !== 'queued') {
          started.push(row.id);
          continue;
        }
        break;
      } catch (err) {
        try {
          finishDelegation(row, { status: 'failed', error: err?.message || 'Queued job failed to start.' });
        } catch {
          // Best effort — the runtime worker reconciles a persisted starting record.
        }
      }
    }
    return started;
  }

  /**
   * Drain queued delegations for one parent, or every parent when no id is
   * given. Returns the started ids; never throws (a failed parent pass is
   * retried by the runtime tick).
   *
   * @param {{ parentChatId?: string }} [input]
   * @returns {Promise<{ ok: true, started: string[] }>}
   */
  async function drainQueue(input = {}) {
    const only = String(input?.parentChatId || '').trim();
    const rows = only ? /** @type {DelegationRow[]} */ (listDelegationsForController(only)) : /** @type {DelegationRow[]} */ (loadDelegations());
    const parentIds = [...new Set(rows
      .filter((row) => String(row.status || '') === 'queued')
      .map((row) => delegationController(row))
      .filter(Boolean))];
    /** @type {string[]} */
    const started = [];
    for (const parentChatId of parentIds) {
      try {
        const ids = await withParentLock(parentChatId, () => drainQueueForController(parentChatId));
        for (const id of ids) started.push(id);
      } catch {
        // drainQueue is best effort; a failed parent is retried on the next tick.
      }
    }
    return { ok: true, started };
  }

  async function orchestrationTakeover(input) {
    try {
      const result = await enqueueDelegationStoreWork(async () => {
        const prepared = await prepareOrchestrationTakeover(input);
        const timeout = Number(process.env.CRETLI_TAKEOVER_LOCK_TIMEOUT_MS) > 0
          ? Number(process.env.CRETLI_TAKEOVER_LOCK_TIMEOUT_MS) : 30000;
        const deadline = Date.now() + timeout;
        const remaining = () => Math.max(1, deadline - Date.now());
        const ids = [...new Set([prepared.from, prepared.to])].sort();
        const lockChats = (index) => index === ids.length
          ? prepareOrchestrationTakeover(input).then((fresh) => executeOrchestrationTakeoverUnlocked(fresh, deps.takeoverAfterPhase))
          : withChatLock(ids[index], () => lockChats(index + 1), remaining());
        const lockParents = (index) => index === ids.length
          ? lockChats(0) : withParentLock(ids[index], () => lockParents(index + 1), remaining());
        return lockParents(0);
      });
      await drainQueue({ parentChatId: result.to });
      return result;
    } catch (error) {
      if (error?.status) return { ok: false, status: error.status, code: error.code, error: error.message, ...(error.todoIds ? { todoIds: error.todoIds } : {}) };
      throw error;
    }
  }

  return {
    orchestrationTakeover,
    createAndStart,
    cancel,
    cancelTree,
    retry,
    acknowledge,
    rate,
    cancelForDeletedChat,
    confirmManualSlotRelease,
    drainQueue,
    getById: getDelegationById,
    listForController: listDelegationsForController,
  };
}

/**
 * After a process restart, do not silently resume work.
 * Unconfirmed active jobs become interrupted. Missing history cards are retried.
 *
 * Liveness comes from `probeChatRunLiveness`: an unknown state (missing
 * adapter, null/undefined getState, adapter exception) is never proof that the
 * run ended, so the slot stays occupied for running/waiting/cancelling jobs.
 * Confirmed idle running/waiting jobs get the same 60s orphan grace as the
 * worker.
 *
 * Explicit boot exception: a `starting` row is terminalised as `interrupted`
 * (server_restart) even when liveness is unknown, because the previous process
 * is dead and the new one has no run state for it. Only a start genuinely in
 * flight in this process (`hasInFlightDelegationStart`) or a busy run keeps it.
 */
export async function reconcileDelegationsOnBoot(options = {}) {
  return enqueueDelegationStoreWork(async () => {
    const now = Date.now();
    for (const row of /** @type {DelegationRow[]} */ (loadDelegations())) {
      let current = row;
      // The in-flight auto verify died with the previous process: drop the
      // marker so reviews fall back to the legacy parent verify.
      if (current.verifyPending) {
        current = /** @type {DelegationRow} */ (updateDelegationRecord(current.id, { verifyPending: null })) || current;
      }
      if (isTerminalDelegationStatus(current.status) && String(current.runStoppingAt || '').trim()) {
        current = releaseDelegationRunSlot(current) || current;
      }
      await flushDelegationOutboxUnlocked(current);
      const live = probeChatRunLiveness({ chatId: current.childChatId, runId: current.runId });
      const known = live.known === true;
      const busy = live.busy === true;
      const age = now - Date.parse(String(row.lastTransitionAt || row.startedAt || row.createdAt || ''));
      const timedOut = Number.isFinite(age) && age >= DELEGATION_STARTING_TIMEOUT_MS;

      if (row.status === 'starting') {
        if (hasDurableAttemptEndProof(row)) {
          const repaired = finishDelegation(row, {
            status: 'completed',
            report: row.report,
            enqueueParentReply: false,
          });
          if (repaired) {
            if (busy) /** @type {DelegationRow} */ (updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() }));
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
        // A retry waiting out its in-memory delay has no run id (the failed
        // attempt was confirmed stopped before scheduling) and its timer died
        // with the process: interrupt it, never resume the retry.
        if (row.startupRetry && !String(row.runId || '').trim() && !hasInFlightDelegationStart(row.id)) {
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
            error: SERVER_RESTART_ERROR,
            enqueueParentReply: true,
          });
          // Pending accept would keep the slot occupied; the retry request was
          // never sent, so mark it unconfirmed (same as the shutdown path).
          if (finished && String(finished.acceptState || '') === 'pending') {
            /** @type {DelegationRow} */ (updateDelegationRecord(finished.id, { acceptState: 'uncertain' }));
          }
          await flushDelegationOutboxUnlocked(/** @type {DelegationRow} */ (getDelegationById(row.id)) || finished || row);
          continue;
        }
        // The starting timeout needs a confirmed idle adapter in boot too.
        if (known && timedOut) {
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_STARTING_TIMEOUT,
            error: STARTING_TIMEOUT_ERROR,
            enqueueParentReply: true,
          });
          await flushDelegationOutboxUnlocked(finished || row);
          continue;
        }
        // Boot exception: the previous process is dead, so no run can be live
        // in this one. Unknown liveness (state_missing, adapter_missing, ...)
        // is not proof of a live run; the restart leaves the start unconfirmed
        // and the row is terminalised so the write slot frees. Retain the
        // uncertainty marker when acceptance cannot be determined. A start
        // genuinely in flight in this process keeps the row `starting`.
        if (hasInFlightDelegationStart(row.id)) continue;
        const finished = finishDelegation(row, {
          status: 'interrupted',
          interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
          error: SERVER_RESTART_ERROR,
          enqueueParentReply: true,
        });
        if (finished && !known && String(finished.acceptState || '') === 'pending') {
          /** @type {DelegationRow} */ (updateDelegationRecord(finished.id, { acceptState: 'uncertain' }));
        }
        await flushDelegationOutboxUnlocked(/** @type {DelegationRow} */ (getDelegationById(row.id)) || finished || row);
        continue;
      }

      if (row.status === 'cancelling') {
        const lastError = Array.isArray(row.errors) ? row.errors[row.errors.length - 1] : null;
        resolveCancellingDeadline(row, now, {
          busy,
          known,
          restartEvidence: isChildConfirmedGone(live) && hasWorkspaceWatcherLeafRestartEvidence(String(row.childChatId || '')),
          appendCancelTimeoutError: true,
          lastCancelTimeoutErrorAt: /** @type {any} */ (lastError?.code === 'cancel_timeout' ? lastError.at : ''),
        }, { finishDelegation, hasInFlightDelegationStart, drainQueue: drainQueueAfterRestartInterrupt });
        await flushDelegationOutboxUnlocked(/** @type {DelegationRow} */ (getDelegationById(row.id)) || row);
        continue;
      }

      if (isActiveDelegationStatus(row.status)) {
        if (hasDurableAttemptEndProof(row)) {
          const repaired = finishDelegation(row, {
            status: 'completed',
            report: row.report,
            enqueueParentReply: false,
          });
          if (repaired) {
            if (busy) /** @type {DelegationRow} */ (updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() }));
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
        // A run recorded by a previous process instance is gone with it: that
        // is proof, so close it now instead of keeping the slot on unknown
        // liveness.
        if ((row.status === 'running' || row.status === 'waiting_for_input')
          && isChildConfirmedGone(live)
          && !hasInFlightDelegationStart(row.id)
          && hasWorkspaceWatcherLeafRestartEvidence(String(row.childChatId || ''))) {
          const closed = finishDelegationInterruptedRestart(row, { finishDelegation, drainQueue: drainQueueAfterRestartInterrupt });
          await flushDelegationOutboxUnlocked(closed || row);
          continue;
        }
        // Unknown liveness is not proof of a lost run: keep the occupied slot.
        if (!known) continue;
        if (row.status === 'running' || row.status === 'waiting_for_input') {
          const observed = String(row.idleObservedAt || '').trim();
          if (!observed) {
            /** @type {DelegationRow} */ (updateDelegationRecord(row.id, { idleObservedAt: new Date(now).toISOString() }));
            continue;
          }
          if (now - Date.parse(observed) < DELEGATION_RUNNING_ORPHAN_GRACE_MS) continue;
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_RUNNING_ORPHAN,
            error: RUNNING_ORPHAN_ERROR,
            enqueueParentReply: true,
          });
          releaseDelegationRunSlot(finished || row);
          await flushDelegationOutboxUnlocked(finished || row);
          continue;
        }
        // queued and other pre-run active states: the restart makes the start
        // unconfirmed.
        const finished = finishDelegation(row, {
          status: 'interrupted',
          interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
          error: SERVER_RESTART_ERROR,
          enqueueParentReply: true,
        });
        await flushDelegationOutboxUnlocked(finished || row);
        continue;
      }

      if (isTerminalDelegationStatus(row.status) && !String(row.historyDeliveredAt || '').trim()) {
        await publishDelegationStatus(row, 'finished');
      }
    }
    reconcileMailboxOnBoot();
    // R10: with `deferOutbox` the family owner redelivers the queued outbox
    // after boot reconciliation (once, under a family claim) instead of here.
    if (options.deferOutbox === true) return;
    for (const chat of /** @type {ChatRowAny[]} */ (loadChats())) {
      await drainChatMailbox(chat.id);
    }
  });
}

/** @param {any} row */
function drainQueueAfterRestartInterrupt(row) {
  void delegationService.drainQueue({ parentChatId: delegationController(row) }).catch(() => {});
}

/**
 * Watcher-tick sweep: running/cancelling jobs whose child died with a previous
 * process instance become `interrupted_restart` and free the slot.
 *
 * @returns {Promise<string[]>} ids closed
 */
export async function interruptRestartedDelegations() {
  return enqueueDelegationStoreWork(async () => interruptDelegationsWithRestartEvidence({
    // Only tick-relevant rows (running/waiting/cancelling): the sweep runs on
    // every Watcher nudge, and mapping all ~4.5k rows each time kept the
    // event loop busy.
    rows: /** @type {DelegationRow[]} */ (listActiveDelegations()),
    finishDelegation,
    drainQueue: drainQueueAfterRestartInterrupt,
    hasInFlightDelegationStart,
    probe: probeChatRunLiveness,
  }));
}

export const delegationService = createDelegationService();

/** Resume every durable intent before normal delegation/mailbox boot repair. */
export async function reconcileTakeoversOnBoot() {
  return enqueueDelegationStoreWork(async () => {
    for (const record of loadDelegationTakeovers()) {
      if (record.phase !== 'done') await executeOrchestrationTakeoverUnlocked(record);
    }
  });
}
