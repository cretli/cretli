/**
 * Create, start, cancel, and retry plan-execution delegations.
 */

import { randomUUID } from 'crypto';
import { canChatControlDelegation, delegationController, delegationScopeChatIds } from './delegation-control.js';
import { addChat, loadChats, updateChat } from './persist/chats-persist.js';
import { isChatArchived } from './chat-tree.js';
import { linkTodoChat } from './persist/todos-persist.js';
import { appendChatHistoryEvents, loadChatHistory } from './persist/chat-history-persist.js';
import { markChatHasPendingDelegation } from './persist/chat-history-revisions.js';
import { broadcastChatHistoryUpdate } from './sdk/sdk-history-updates.js';
import {
  createDelegationRecord,
  findDelegationByChildChatId,
  findDelegationByIdempotencyKey,
  getDelegationById,
  listActiveDelegationsForController,
  listDelegationsForController,
  listDelegationsForTreeRoot,
  loadDelegations,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { collectDelegationSubtreePostOrder } from './delegation-tree-cancel.js';
import {
  finishCancellingWithStopProof,
  resolveCancellingDeadline,
} from './delegation-cancelling-deadline.js';
import { normalizeDelegationRunDeadlineAt } from './delegation-run-deadline.js';
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
import { assertReviewAdapterAllowed } from './delegation-adapter-capabilities.js';
import {
  buildNamedDelegationStartHardGateInput,
  evaluateDelegationStartHardGates,
  resolveDelegationGateRole,
} from './delegation-model-gates.js';
import {
  clearHarnessStartupFailureLockout,
  listHarnessUsageLimits,
  listHarnessUsageLimitsForWorkspace,
  noteHarnessStartupFailureLockout,
  noteHarnessUsageLimit,
} from './harness-usage-limits.js';
import { isDelegationStartupFailure } from './delegation-startup-failure.js';
import { findActiveLockoutRow } from './model-pick-gate-primitives.js';
import { resolveDelegationTechnicalSuccess } from './delegation-cycle-classify.js';
import { inspectImplementVerifyBeforeReview } from './delegation-implement-verify-gate.js';
import { inspectReviewRecheckWithoutChange } from './delegation-review-recheck-gate.js';
import {
  buildSessionResumeRecord,
  inspectDelegationSessionResume,
  readResumeSessionOfInput,
} from './delegation-session-resume.js';
import { getCacheStateForChat } from './usage/cache-state.js';
import {
  applyDelegationWorkflowPatch,
  inspectDelegationWorkflowStart,
  resolveDelegationWorkflowRow,
} from './delegation-workflow.js';
import {
  buildCodeReviewWorkflowPatchOnFinish,
  buildCodeReviewWorkflowPatchOnClosureStart,
  inspectDelegationCodeReviewStart,
  resolveCodeReviewPhaseWorkflowIdempotencyKey,
  resolveEffectiveCodeReviewReportVerdict,
} from './delegation-code-review-phase.js';
import {
  normalizeDelegationWorkflowLeafId,
  readDelegationWorkflowLeafIdFromRow,
} from './delegation-workflow-leaf.js';
import { extractLeafAcceptanceCriteria } from './delegation-review-gate.js';
import { getTodoById, loadTodosData } from './persist/todos-persist.js';
import { collectTodoLeafScopePaths } from './todo-parallel-scope.js';
import {
  listOccupiedDelegations,
  resolveDelegationGlobalLimit,
  resolveDelegationWorkspaceWriteConflict,
} from './delegation-workspace-guard.js';
import { readChatPlanDocument } from './chat-plan-persist.js';
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
import { drainChatMailbox, ensureDelegationParentMailboxReply, reconcileMailboxOnBoot } from './delegation-mailbox.js';
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
import { computeTodoPlanRevisionKey } from './plan-reviewer-cooperation.js';
import { readDelegationMaterialRevisionForRecord } from './delegation-material-revision.js';
import {
  buildLeafMaterialPromptBlock,
  ensureLeafMaterialBase,
  readLeafScopedMaterialRevisionForTodo,
  updateLeafMaterialPartialPaths,
} from './todo-leaf-material.js';
import { logDelegationEvent } from './delegation-log.js';
import { resolveDataPath } from './runtime-paths.js';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  attachLeafResolutionFields,
  resolveRequestLeafContext,
} from './orchestrator-leaf-resolution.js';
import { getWorkspaceWatcher } from './persist/workspace-watchers-persist.js';
import { readWorkspaceWatcherTodoFindings } from './workspace-watcher-guardrails.js';

/**
 * @param {{
 *   parentChatId?: string,
 *   leafId?: string,
 *   cwd?: string,
 *   assignment?: string,
 *   executionMode?: string,
 * }} input
 * @returns {{ workflowRow: object | null, leafAcceptanceText: string, leafMaterialText: string, watcherFindingsText: string, leafTodo: object | null }}
 */
function readExecutorPromptExtras(input) {
  const parentChatId = String(input.parentChatId || '').trim();
  const leafId = normalizeDelegationWorkflowLeafId({ leafId: input.leafId });
  if (!parentChatId) {
    return { workflowRow: null, leafAcceptanceText: '', leafMaterialText: '', watcherFindingsText: '', leafTodo: null };
  }
  const workflowRow = resolveDelegationWorkflowRow({ parentChatId, leafId });
  let leafAcceptanceText = '';
  let leafMaterialText = '';
  let leafTodo = null;
  const cwd = String(input.cwd || '').trim();
  const dataDir = resolveDataPath();
  if (leafId && cwd) {
    const assignment = String(input.assignment || '').trim();
    if (assignment === 'implement' || assignment === 'fix' || assignment === 'review') {
      const watcherPolicy = getWorkspaceWatcher(cwd, { dataDir })?.policy ?? null;
      leafTodo = ensureLeafMaterialBase({ dataDir, workspaceFolder: cwd, leafId, policy: watcherPolicy })
        || getTodoById(dataDir, cwd, leafId);
    } else {
      leafTodo = getTodoById(dataDir, cwd, leafId);
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
    const watcher = getWorkspaceWatcher(cwd, { dataDir: resolveDataPath() });
    const entry = readWorkspaceWatcherTodoFindings(watcher?.findings, leafId);
    watcherFindingsText = String(entry.summary || '').trim();
  }
  return { workflowRow, leafAcceptanceText, leafMaterialText, watcherFindingsText, leafTodo };
}

/**
 * @param {object | null | undefined} delegation
 */
function syncCodeReviewWorkflowAfterFinish(delegation) {
  if (!delegation || typeof delegation !== 'object') return;
  const leafId = readDelegationWorkflowLeafIdFromRow(delegation);
  const parentChatId = delegationController(delegation);
  if (!parentChatId) return;
  const workflow = resolveDelegationWorkflowRow({ parentChatId, leafId });
  const patch = buildCodeReviewWorkflowPatchOnFinish(delegation, workflow);
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
 * @param {object | null | undefined} row
 * @param {{ dataDir?: string }} [options]
 * @returns {{
 *   leafId: string, todoId: string, revision: string,
 *   resolution: 'unattributed'|'exact'|'prefix'|'ambiguous'|'missing'|'unavailable',
 * }}
 */
export function resolveDelegationAcceptTodo(row, options = {}) {
  const leafId = readDelegationWorkflowLeafIdFromRow(row);
  const cwd = String(row?.workspaceFolder || '').trim();
  if (!leafId || !cwd) {
    return { leafId, todoId: '', revision: '', resolution: 'unattributed' };
  }
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  /** @type {object[]} */
  let items = [];
  try {
    items = loadTodosData(dataDir, cwd).items;
  } catch {
    // A failed read is not "the todo is gone": acceptance must not pass on it.
    return { leafId, todoId: '', revision: '', resolution: 'unavailable' };
  }
  const exact = items.find((item) => String(item?.id || '').trim().toLowerCase() === leafId);
  if (exact) {
    return {
      leafId,
      todoId: String(exact.id || '').trim(),
      revision: String(exact.updatedAt || '').trim(),
      resolution: 'exact',
    };
  }
  const prefixed = items.filter((item) => String(item?.id || '').trim().toLowerCase().startsWith(leafId));
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
 * @param {object | null | undefined} row
 * @param {string} chatId
 * @param {{ dataDir?: string }} [options]
 * @returns {boolean}
 */
export function canChatSteerDelegation(row, chatId, options = {}) {
  const caller = String(chatId || '').trim();
  if (!row || !caller) return false;
  if (canChatControlDelegation(row, caller)) return true;
  const leafId = readDelegationWorkflowLeafIdFromRow(row);
  const cwd = String(row.workspaceFolder || '').trim();
  if (!leafId || !cwd) return false;
  const dataDir = String(options.dataDir || '').trim() || resolveDataPath();
  /** @type {object[]} */
  let items = [];
  try {
    items = loadTodosData(dataDir, cwd).items;
  } catch {
    return false;
  }
  const exact = items.find((item) => String(item?.id || '').trim().toLowerCase() === leafId);
  const prefixed = exact ? [] : items.filter((item) => String(item?.id || '').trim().toLowerCase().startsWith(leafId));
  const leaf = exact || (prefixed.length === 1 ? prefixed[0] : null);
  if (!leaf) return false;
  const byId = new Map(items.map((item) => [String(item?.id || ''), item]));
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
 * @param {object | null | undefined} row
 * @param {{ dataDir?: string }} [options]
 * @returns {{ todoId: string, todoRevision: string, resolution: string }}
 */
export function readDelegationAcceptContext(row, options = {}) {
  const target = resolveDelegationAcceptTodo(row, options);
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
 * @returns {object[]}
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
  resolveDelegationModel,
} from './delegation-executor.js';
import { appendRelatedChatHistoryLinks } from './chat-relation-history.js';
import { normalizeAgentTransport } from './agent-transport.js';
import { resolveSdkCwdForChat } from './workspace.js';
import { resolveExecutionFolderForChat } from './execution-folder.js';
import { isAskSdkMode } from './sdk/sdk-mode.js';
// The leaf module, not `sdk-plan-guard.js`: that one imports the MCP policy,
// which imports the builtin tool catalog, which imports the delegation tools
// and would close an import cycle back into this file.
import { ASK_GUARD_USER_MESSAGE } from './sdk/sdk-guard-messages.js';
import { decodeModelValue } from './model-catalog.js';
import { delegationPersistedRole } from './model-pick-history.js';
import { resolveDelegationReviewVerifyPlan } from './delegation-review-verify-plan.js';
import {
  finalizeDelegationPickSlotReservation,
  getModelPickRecord,
  releaseModelPickSlotsForDelegation,
  resolveDelegationPickLinkFields,
} from './model-pick-decisions.js';
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

/** @type {Map<string, Promise<unknown>>} */
const parentLocks = new Map();

/** @type {Map<string, { attemptId: string, childChatId: string }>} */
const inFlightStarts = new Map();

/** @type {Map<string, Promise<object>>} */
const retryJobInFlight = new Map();

/** @type {null | ((phase: string, record: object) => void)} */
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
  return loadDelegations().filter((row) => isActiveDelegationStatus(row.status)).length;
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
 * @param {null | ((phase: string, record: object) => (void | Promise<void>))} fn
 */
export function setDelegationCrashHook(fn) {
  crashHook = typeof fn === 'function' ? fn : null;
}

/**
 * @param {string} phase
 * @param {object} [record]
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
 * @param {object} result
 * @param {unknown} reviewUncertified
 * @returns {object}
 */
function tagReviewUncertified(result, reviewUncertified) {
  if (reviewUncertified !== true || !result || typeof result !== 'object') return result;
  return { ...result, reviewUncertified: true };
}

/**
 * @param {object | null | undefined} warning
 * @param {object} result
 * @returns {object}
 */
function attachDelegationStartWarning(result, warning) {
  if (!warning || !result || typeof result !== 'object') return result;
  return { ...result, warning };
}

/**
 * @param {string} harness
 * @param {string} model
 * @param {object[]} lockouts
 * @returns {object | null}
 */
function readActiveStartupFailureLockoutWarning(harness, model, lockouts) {
  const row = findActiveLockoutRow(lockouts, String(harness || '').trim().toLowerCase(), model, Date.now());
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
 * @param {object} row
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string, delegation: object }}
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
 * @param {object | null | undefined} row
 * @returns {object | undefined}
 */
function findControllerChat(row) {
  const chats = loadChats();
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
async function withParentLock(parentChatId, task) {
  const key = String(parentChatId || '').trim();
  const previous = parentLocks.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate, () => gate);
  parentLocks.set(key, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (parentLocks.get(key) === chain) parentLocks.delete(key);
  }
}

/**
 * @param {object} delegation
 * @param {string} status
 * @param {Record<string, unknown>} [patch]
 * @param {{ expectedRevision?: number, expectedAttemptId?: string }} [options]
 */
function transition(delegation, status, patch = {}, options = {}) {
  const current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id) return null;
  const expectedAttempt = String(options.expectedAttemptId || '').trim();
  if (expectedAttempt && String(current.attemptId || '') !== expectedAttempt) {
    return current;
  }
  if (!canTransitionDelegationStatus(current.status, status) && current.status !== status) {
    return current;
  }
  const next = updateDelegationRecord(current.id, { status, ...patch }, {
    expectedRevision: options.expectedRevision,
    expectedAttemptId: options.expectedAttemptId,
  });
  return next || getDelegationById(current.id) || current;
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
 * @returns {boolean}
 */
function hasDelegationHistoryEvent(parentChatId, query) {
  const store = loadChatHistory(parentChatId);
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
 * @param {object} delegation
 * @param {string} event
 * @param {Record<string, unknown> | null} [snapshot]
 * @returns {object | null}
 */
export function publishDelegationStatus(delegation, event, snapshot = null) {
  const current = getDelegationById(delegation?.id) || delegation;
  const controllerChatId = delegationController(current);
  if (!current?.id || !controllerChatId) return current || null;
  const eventName = String(event || '').trim();
  if (!eventName) return current;
  const view = snapshot && typeof snapshot === 'object'
    ? { ...current, ...snapshot }
    : current;
  const attemptId = String(view.attemptId || '');
  const eventId = String(view.eventId || current.eventId || '');
  const already = hasDelegationHistoryEvent(controllerChatId, {
    id: current.id,
    event: eventName,
    attemptId,
    eventId,
  });
  const snapshotIsCurrentAttempt = !attemptId || attemptId === String(current.attemptId || '');
  if (already) {
    if (eventName === 'finished' && snapshotIsCurrentAttempt && !String(current.historyDeliveredAt || '').trim()) {
      return updateDelegationRecord(current.id, { historyDeliveredAt: new Date().toISOString() });
    }
    return current;
  }
  const executor = view.executor && typeof view.executor === 'object' ? view.executor : {};
  // Position of the first card for this job; later status cards reuse it so a
  // tail-windowed view keeps the card where the job started.
  let anchorSeq = 0;
  for (const row of loadChatHistory(controllerChatId)?.events || []) {
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
    // Persisted user rating for the card (metadata only, never the report).
    // Read fresh on every publish so a later event keeps the rated state.
    userRating: delegationRatingCardSnapshot(findDelegationRating(current.id, 'user')),
    attemptId,
    attemptNumber: countDelegationAttempts(view.attempts ? view : current),
    event: eventName,
    eventId,
    sourceKind: view.sourceKind || current.sourceKind || '',
    assignment: view.assignment || current.assignment || '',
    pickReason: String(view.pickReason || current.pickReason || '').trim(),
    allowChildDelegations: (view.allowChildDelegations ?? current.allowChildDelegations) === true,
    interruptCode: normalizeDelegationInterruptCode(view.interruptCode || current.interruptCode),
    model: executor.model || '',
    startedAt: view.startedAt || '',
    finishedAt: view.finishedAt || '',
    historyDeliveredAt: view.historyDeliveredAt || '',
    reportDeliveredAt: view.reportDeliveredAt || '',
    attempts: Array.isArray(view.attempts) ? view.attempts : (Array.isArray(current.attempts) ? current.attempts : []),
  });
  const result = appendChatHistoryEvents(controllerChatId, '', [
    { rec: { kind: 'meta', variant: 'delegation', payload } },
  ]);
  if (!result?.ok) return current;
  markChatHasPendingDelegation(controllerChatId);
  broadcastChatHistoryUpdate(controllerChatId, result.appended);
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
  return updateDelegationRecord(current.id, patch) || current;
}

/**
 * @param {object} record
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
 * @returns {object[]}
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
 * @param {object} row
 * @param {{ status?: string, interruptCode?: string }} outcome
 */
function finishExploreAttemptIfNeeded(row, outcome) {
  if (!row?.id) return;
  if (String(row.pickOriginDetail || '').trim() !== MODEL_PICK_EXPLORE_ORIGIN_DETAIL) return;
  const exploreOutcome = classifyExploreAttemptOutcome(outcome);
  if (!exploreOutcome) return;
  const pick = row.pickId ? getModelPickRecord(String(row.pickId)) : null;
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
 * @param {object} delegation
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

/**
 * Best-effort hook that recomputes the durable `todo.review` snapshot for the
 * leaf a delegation row affects (`docs/todo-review-contract.md` §10.4). A broken
 * sync must never break the delegation transition, so the call is wrapped twice:
 * the hook itself catches, and this wrapper guards even an import-level throw.
 *
 * @param {object} row
 * @param {{ dataDir?: string, parentTodoId?: string }} [options]
 * @returns {object | null}
 */
function safeSyncTodoReview(row, options = {}) {
  try {
    if (!row || typeof row !== 'object') return null;
    return syncTodoReviewForDelegation(row, options);
  } catch {
    return null;
  }
}

/**
 * @param {object} delegation
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
 * }} outcome
 */
export function finishDelegation(delegation, outcome) {
  const current = getDelegationById(delegation.id);
  if (!current) return null;
  if (!isDelegationEventCurrent(current, outcome?.runId, outcome?.attemptId)) {
    return current;
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    if (outcome?.error) {
      // A second terminal event for the same attempt (leftover run / double
      // `sdkRunFinished`) is spurious. Count it for diagnostics; never append
      // it to `errors[]` as if it were a job failure.
      return updateDelegationRecord(current.id, {
        afterTerminalCount: Number(current.afterTerminalCount || 0) + 1,
        lastAfterTerminalAt: new Date().toISOString(),
        lastAfterTerminalCode: 'adapter_after_terminal',
      }) || current;
    }
    if (!String(current.historyDeliveredAt || '').trim()) {
      return publishDelegationStatus(current, 'finished');
    }
    return current;
  }
  const finishedAt = new Date().toISOString();
  const reportAssessment = assessDelegationReport(outcome.report || current.report || '');
  const reportVerdict = resolveEffectiveCodeReviewReportVerdict(
    { ...current, report: reportAssessment.report },
    reportAssessment.verdict,
  );
  const transitionPatch = {
    report: reportAssessment.report,
    reportVerdict,
    reportDegraded: reportAssessment.degraded,
    reportSummary: reportAssessment.summary,
    error: outcome.error || current.error || '',
    finishedAt,
    taskOutcome: normalizeDelegationTaskOutcome(outcome.taskOutcome || current.taskOutcome),
    interruptCode: String(outcome.status || '') === 'interrupted'
      ? normalizeDelegationInterruptCode(outcome.interruptCode)
      : '',
    ...(outcome.metrics && typeof outcome.metrics === 'object' ? { metrics: outcome.metrics } : {}),
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
    if (isDelegationStartupFailure({ error: outcome.error, errors: next?.errors, status: outcome.status })) {
      noteHarnessStartupFailureLockout({ harness: transport, model: modelId, ...lockoutScope });
    } else {
      noteDelegationExecutorLimit(next, outcome.error);
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
  const snapshot = buildFinishOutboxSnapshot(next);
  const withOutbox = updateDelegationRecord(next.id, {
    outboxAppend: buildFinishOutboxItems(snapshot, outcome.enqueueParentReply === true),
  }) || next;
  logDelegationEvent('finished', withOutbox);
  runDelegationCrashHook('after-result-write', withOutbox);
  finishExploreAttemptIfNeeded(withOutbox, outcome);
  const published = publishDelegationStatus(withOutbox, 'finished', snapshot);
  const historyItem = (published?.outbox || withOutbox.outbox || [])
    .find((row) => row.type === 'history' && row.event === 'finished' && row.attemptId === snapshot.attemptId && !row.deliveredAt);
  if (historyItem && isHistoryOutboxSuccess(published || withOutbox, historyItem)) {
    markOutboxItemDelivered(published || withOutbox, historyItem.id);
  }
  const final = getDelegationById(next.id) || published;
  // Terminal transition (completion, cancel, timeout) — one shared hook for the
  // worker and the bridge. The stored attempt now carries its verdict/verify
  // evidence, so the snapshot can settle `passed`/`failed`/`unknown`.
  safeSyncTodoReview(final);
  try {
    syncPlanReviewerSessionAfterDelegationFinish(final);
  } catch {
    // Cooperation sync must not break delegation finalization.
  }
  syncCodeReviewWorkflowAfterFinish(final);
  const leafId = readDelegationWorkflowLeafIdFromRow(final);
  if (leafId) {
    updateLeafMaterialPartialPaths({
      dataDir: resolveDataPath(),
      workspaceFolder: String(final.workspaceFolder || '').trim(),
      leafId,
      executionFolder: String(final.executionFolder || final.workspaceFolder || '').trim(),
      delegation: final,
    });
  }
  return final;
}

/**
 * @param {object | null | undefined} existing
 * @param {object} next
 * @returns {boolean}
 */
function isEquivalentDelegationVerifyResult(existing, next) {
  if (!existing || typeof existing !== 'object') return false;
  const fields = ['status', 'exitCode', 'verdict', 'source', 'dataDir', 'attemptId', 'materialRevision'];
  return fields.every((key) => String(existing[key] ?? '') === String(next[key] ?? ''));
}

/** Persist the host-owned review runner result for the current delegation attempt. */
export function recordDelegationVerifyResult(input = {}) {
  const id = String(input.delegationId || '').trim();
  const attemptId = String(input.attemptId || '').trim();
  const current = id ? getDelegationById(id) : null;
  if (!current || !attemptId || attemptId !== String(current.attemptId || '').trim()) return null;
  const result = input.result && typeof input.result === 'object' ? input.result : {};
  const verdict = String(input.verdict || '').trim() || resolveDelegationRecordVerdict(current);
  const leafTodo = getTodoById(resolveDataPath(), String(current.workspaceFolder || '').trim(), readDelegationWorkflowLeafIdFromRow(current));
  const scopedRevision = leafTodo
    ? readLeafScopedMaterialRevisionForTodo(leafTodo, String(current.executionFolder || current.workspaceFolder || '').trim())
    : '';
  const materialRevision = scopedRevision || readDelegationMaterialRevisionForRecord(current);
  const verifyResult = {
    status: result.ok === true ? 'passed' : 'failed',
    exitCode: result.ok === true ? 0 : 1,
    verdict: DELEGATION_VERDICTS.includes(verdict) ? verdict : '',
    source: String(input.source || '').trim(),
    dataDir: String(result.dataDir || ''),
    recordedAt: new Date().toISOString(),
    attemptId,
    materialRevision,
  };
  if (isEquivalentDelegationVerifyResult(current.verifyResult, verifyResult)) {
    return current;
  }
  const updated = updateDelegationRecord(id, { verifyResult });
  // A host verify answers the attempt's verify obligation: recompute so a
  // required-missing `unknown` becomes `passed`/`failed` (`§10.4`).
  safeSyncTodoReview(updated || current);
  return updated;
}

/**
 * Patch one outbox intent on the latest record. Never rewrite the whole
 * snapshot from a stale in-memory array — concurrent appends must survive.
 *
 * @param {object} record
 * @param {string} itemId
 * @param {Record<string, unknown>} patch
 */
function patchOutboxItem(record, itemId, patch) {
  const id = String(record?.id || '').trim();
  const targetId = String(itemId || '').trim();
  if (!id || !targetId) return record;
  const latest = getDelegationById(id);
  if (!latest) return record;
  const item = (latest.outbox || []).find((row) => String(row.id || '') === targetId);
  if (!item) return latest;
  return updateDelegationRecord(id, {
    outboxItemPatch: {
      id: targetId,
      expectedAttemptId: String(item.attemptId || '').trim(),
      patch,
    },
  }) || latest;
}

/**
 * @param {object} record
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
 * @param {object} record
 * @param {object} item
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
  return updateDelegationRecord(patched.id, {
    errorAppend: [{
      at: new Date(now).toISOString(),
      code: 'outbox_retry',
      message: String(error || 'delivery_failed'),
      attemptId: item.attemptId,
      outboxId: item.id,
    }],
  }) || patched;
}

/**
 * @param {object} record
 * @param {object} item
 * @returns {boolean}
 */
function isHistoryOutboxSuccess(record, item) {
  const snapshotAttempt = String(item?.snapshot?.attemptId || item?.attemptId || '');
  const currentAttempt = String(record?.attemptId || '');
  if (snapshotAttempt && currentAttempt && snapshotAttempt === currentAttempt) {
    return Boolean(String(record?.historyDeliveredAt || '').trim());
  }
  return hasDelegationHistoryEvent(delegationController(record), {
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
  if (!result || result.ok === false) return false;
  return Boolean(result.message);
}

/**
 * Flush without taking the store lock. Callers that already hold
 * `enqueueDelegationStoreWork` must use this to avoid deadlock.
 *
 * @param {object} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<object | null>}
 */
export async function flushDelegationOutboxUnlocked(delegation, options = {}) {
  let current = getDelegationById(delegation?.id) || delegation;
  if (!current?.id) return current || null;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const pending = Array.isArray(current.outbox)
    ? current.outbox.filter((row) => !String(row.deliveredAt || '').trim())
    : [];
  for (const item of pending) {
    current = getDelegationById(current.id) || current;
    const dueAt = Date.parse(String(item.nextAttemptAt || ''));
    if (Number.isFinite(dueAt) && dueAt > now) continue;
    await Promise.resolve().then(() => runDelegationCrashHook(`outbox:${item.type}`, current));
    const snapshot = item.snapshot && typeof item.snapshot === 'object' ? item.snapshot : null;
    if (item.type === 'history') {
      const published = publishDelegationStatus(current, item.event || 'updated', snapshot);
      current = published || current;
      if (isHistoryOutboxSuccess(current, item)) {
        current = markOutboxItemDelivered(current, item.id) || current;
      } else {
        current = markOutboxItemRetry(current, item, 'history_append_failed', now) || current;
      }
      continue;
    }
    if (item.type !== 'mailbox') continue;
    await Promise.resolve().then(() => runDelegationCrashHook('before-mailbox', current));
    const result = await ensureDelegationParentMailboxReply(current, snapshot, { deferDelivery: true });
    if (isMailboxOutboxSuccess(result)) {
      current = markOutboxItemDelivered(current, item.id) || current;
    } else {
      const reason = result?.error || (result == null ? 'mailbox_skipped' : 'mailbox_failed');
      current = markOutboxItemRetry(current, item, reason, now) || current;
    }
  }
  return getDelegationById(current.id) || current;
}

/**
 * Deliver pending history/mailbox intents after a crash or restart.
 * Marks only the specific outbox id, and only after a confirmed result.
 *
 * @param {object} delegation
 * @param {{ now?: number }} [options]
 * @returns {Promise<object | null>}
 */
export async function flushDelegationOutbox(delegation, options = {}) {
  const flushed = await enqueueDelegationStoreWork(() => flushDelegationOutboxUnlocked(delegation, options));
  const parentChatId = delegationController(flushed) || delegationController(delegation);
  if (parentChatId) {
    await drainChatMailbox(parentChatId);
  }
  return getDelegationById(delegation?.id) || flushed;
}

/**
 * @param {object} delegation
 * @param {string} runId
 * @param {string} attemptId
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
 * @param {object | null | undefined} row
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
 * @param {object | null | undefined} latest
 * @param {{ attemptId?: string, runId?: string }} fence
 * @returns {{ ok: true, status: number, skipped: true, stale: true, delegation: object } | null}
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
    state = getChatRunState(input);
  } catch {
    state = null;
  }
  return !!(state?.busy || state?.waitingForInput);
}

/**
 * Durable end of this attempt: a fenced final_report, adapter finish, or
 * stored finishedAt for the same attemptId. Age or a null getState is not proof.
 *
 * @param {object | null | undefined} row
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
  return archived.some((item) => {
    if (String(item.attemptId || '').trim() !== wanted) return false;
    return Boolean(String(item.finishedAt || '').trim());
  });
}

/**
 * @param {object | null | undefined} row
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
 * @param {object} blocker
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
 * }} input
 */
function parentWidthConflict(input) {
  const workspaceFolder = String(input?.workspaceFolder || '').trim();
  /** @type {Map<string, string[]>} */
  const scopeCache = new Map();
  const resolveLeafScopePaths = (leafId) => {
    const key = String(leafId || '').trim();
    if (!key) return [];
    if (scopeCache.has(key)) return scopeCache.get(key) || [];
    const dataDir = String(deps.dataDir || '').trim() || resolveDataPath();
    const todo = workspaceFolder
      ? getTodoById(dataDir, workspaceFolder, key)
      : null;
    const paths = todo ? collectTodoLeafScopePaths(todo) : [];
    scopeCache.set(key, paths);
    return paths;
  };
  const ignoreQueued = input?.ignoreQueued === true;
  const notQueued = (row) => String(row?.status || '') !== 'queued';
  let activeForParent = listActiveDelegationsForController(input.parentChatId);
  if (ignoreQueued) {
    activeForParent = activeForParent.filter(notQueued);
  }
  const occupied = listOccupiedDelegations();
  // Tree identity: a resumed/retried/queued row keeps its recorded tree, a new
  // start joins the tree of its (child) parent chat. '' = no shared tree.
  const existing = input.resumeDelegationId
    ? loadDelegations().find((row) => row.id === input.resumeDelegationId)
    : null;
  const rootDelegationId = resolveIncomingTreeRootId({
    existing,
    parent: existing ? null : loadChats().find((chat) => chat.id === input.parentChatId),
  });
  const incomingLeafId = String(input?.incomingLeafId || '').trim()
    || (existing ? readDelegationWorkflowLeafIdFromRow(existing) : '');
  const width = resolveDelegationParentWidth({
    active: activeForParent,
    incomingAssignment: input.incomingAssignment,
    resumeDelegationId: input.resumeDelegationId,
    gate: input.gate,
    ignoreQueued,
    incomingLeafId,
    resolveLeafScopePaths,
  });
  if (!width.ok) {
    const inspected = inspectDelegationSlot(width.blocker);
    return {
      ...slotConflict(inspected, width.code, width.error),
      code: width.code,
      delegation: width.blocker,
    };
  }
  const workspace = resolveDelegationWorkspaceWriteConflict({
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
  const treeSlots = resolveDelegationTreeSlots({
    active: occupied,
    rootDelegationId,
    resumeDelegationId: input.resumeDelegationId,
  });
  if (!treeSlots.ok) {
    const inspected = inspectDelegationSlot(treeSlots.blocker);
    return {
      ...slotConflict(inspected, treeSlots.code, treeSlots.error),
      code: treeSlots.code,
      delegation: treeSlots.blocker,
    };
  }
  const global = resolveDelegationGlobalLimit({
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
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareQueuedDelegations(a, b) {
  const byTime = String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  if (byTime !== 0) return byTime;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/**
 * @param {string} parentChatId
 * @returns {object[]}
 */
function listQueuedForControllerSorted(parentChatId) {
  return listDelegationsForController(parentChatId)
    .filter((row) => String(row.status || '') === 'queued')
    .sort(compareQueuedDelegations);
}

/**
 * @param {object | null | undefined} row
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
 * @param {object} conflict a queueable parent-width conflict
 * @param {number} queueMax
 * @returns {{ ok: false, status: number, code: string, error: string, id: string, delegationId: string }}
 */
function queueFullConflict(conflict, queueMax) {
  const blockerId = String(conflict?.delegationId || conflict?.id || '').trim();
  return {
    ok: false,
    status: 409,
    code: 'queue_full',
    error: `The delegation queue for this parent is full (max ${queueMax}). Retry once a slot frees or raise CRETLI_DELEGATION_QUEUE_MAX.`,
    delegationId: blockerId,
    id: blockerId,
    blocker: conflict?.delegation || null,
  };
}

/**
 * Clear the parent slot after the child run is confirmed idle.
 *
 * @param {object | null | undefined} row
 * @returns {object | null}
 */
export function releaseDelegationRunSlot(row) {
  if (!row?.id) return row || null;
  if (isCancelUnconfirmedDelegationSlot(row)) return row;
  if (!String(row.runStoppingAt || '').trim()) return row;
  if (hasInFlightDelegationStart(row.id)) return row;
  const idle = isChatRunConfirmedIdle({ chatId: row.childChatId, runId: row.runId });
  const staleTerminal = isTerminalDelegationStatus(row.status) && isStaleTerminalRunStopping(row);
  if (!idle && !staleTerminal) return row;
  const released = updateDelegationRecord(row.id, { runStoppingAt: '', idleObservedAt: '' }) || row;
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
      if (delegationId) releaseDelegationRunSlot(getDelegationById(delegationId));
      return;
    }
    void cancelChatRun({ chatId, runId })
      .catch(() => {})
      .finally(() => {
        if (!delegationId) return;
        releaseDelegationRunSlot(getDelegationById(delegationId));
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
  const current = id ? getDelegationById(id) : null;
  if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
  if (!attemptId) return { ok: true, skipped: true, reason: 'unassigned', delegation: current };
  if (input?.mutateCurrent === false || attemptId !== String(current.attemptId || '').trim()) {
    return { ok: true, skipped: true, reason: 'stale_attempt', delegation: current };
  }
  if (current.status === 'cancelled') {
    return { ok: true, skipped: true, reason: 'already_cancelled', delegation: current };
  }
  if (isTerminalDelegationStatus(current.status) && current.status !== 'cancelling') {
    return { ok: true, skipped: true, reason: 'already_terminal', delegation: current };
  }
  const resolved = resolveDelegationFinishReport({
    assignment: current.assignment,
    report: input.report,
    taskOutcome: input.taskOutcome,
    status: 'completed',
  });
  const finished = finishDelegation(current, {
    status: resolved.status,
    report: resolved.report,
    error: resolved.error,
    taskOutcome: resolved.taskOutcome,
    enqueueParentReply: false,
  });
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
    holding = updateDelegationRecord(current.id, {
      runStoppingAt: runIdle ? '' : new Date().toISOString(),
      ...(runIdle ? { idleObservedAt: '' } : {}),
      finalReportAcceptedAt: new Date().toISOString(),
      finalReportAttemptId: attemptId,
      finalReportRunId: String(input.runId || current.runId || '').trim(),
    }) || holding;
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
    delegation: getDelegationById(current.id) || holding,
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
    const row = findDelegationByChildChatId(current);
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
 * @param {object | null | undefined} parent
 * @returns {object}
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
  const parent = input.parent;
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
  const depthGate = evaluateDelegationDepthGate({ parent });
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
  const model = resolveDelegationModel({ transport, model: requestedModel });
  if (!model || input.isModelAvailable({ transport, model }) === false) {
    return {
      ok: false,
      status: 400,
      error: describeUnavailableDelegationModel({ transport }),
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
      requested: input.allowChildDelegations,
    }),
  };
}

/**
 * @param {unknown} allowed
 * @param {unknown} depth
 * @returns {{ allowed: boolean, depth: number, remainingDepth: number }}
 */
function buildChildDelegationPromptInput(allowed, depth) {
  const maxDepth = resolveDelegationMaxDepth();
  return {
    allowed: normalizeAllowChildDelegations(allowed),
    depth: Number(depth) || 1,
    remainingDepth: remainingDelegationDepth({ depth, maxDepth }),
  };
}

/**
 * @param {{ latest: object, started?: { runId?: string }, childChatId: string }} input
 * @returns {Promise<object>}
 */
async function stopAcceptedRunIfObsolete(input) {
  const latest = input.latest;
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
  const after = getDelegationById(latest.id) || latest;
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
 * @returns {string}
 */
function resolveReviewedTodoPlanRevisionKey(input) {
  if (String(input.assignment || '').trim().toLowerCase() !== 'review') return '';
  if (String(input.reviewSubject || '').trim().toLowerCase() !== 'plan') return '';
  const leafId = String(input.leafId || '').trim();
  const workspaceFolder = String(input.workspaceFolder || '').trim();
  if (!leafId || !workspaceFolder) return '';
  const todo = getTodoById(resolveDataPath(), workspaceFolder, leafId);
  if (!String(todo?.plan?.markdown || '').trim()) return '';
  return computeTodoPlanRevisionKey(todo);
}

/**
 * @param {object} deps
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

  /**
   * Best-effort: record the executor chat in the parent todo's chat history.
   * Linking never bumps the todo revision.
   *
   * @param {object} child
   * @param {object} parent
   */
  function linkChildChatToTodo(child, parent) {
    const todoId = String(parent?.todoId || '').trim();
    const dataDir = String(deps.dataDir || '').trim();
    if (!todoId || !child?.id || !dataDir) return;
    const cwd = resolveCwd(child);
    if (!cwd) return;
    try {
      linkTodoChat(dataDir, cwd, todoId, child.id);
    } catch {
      // Linking is bookkeeping; a failure must not abort the delegation.
    }
  }

  /**
   * @param {{
   *   parentChatId: string,
   *   executor: { transport: string, model: string, options?: object },
   *   planRevision: number,
   *   idempotencyKey: string,
   *   extraInstructions?: string,
   *   title?: string,
   *   sourceKind?: string,
   *   historySeq?: number,
   *   contentHash?: string,
   *   taskText?: string,
   *   executionMode?: string,
   *   assignment?: string,
   *   reviewSubject?: string,
   * }} input
   */
  async function createAndStart(input) {
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
      const parent = loadChats().find((row) => row.id === parentChatId);
      const startGate = validateDelegationExecutorStart({
        parent,
        executor: input?.executor,
        isModelAvailable,
        resolveCwd,
        resolveExecutionFolder,
        allowChildDelegations: input?.allowChildDelegations ?? input?.allow_child_delegations,
      });
      if (!startGate.ok) {
        return parent ? startGate : { ok: false, status: 404, error: 'Chat not found.', code: 'chat_not_found' };
      }
      const { validateWorkspaceWatcherParentDelegation } = await import('./workspace-watcher-delegation-guard.js');
      const watcherGate = validateWorkspaceWatcherParentDelegation({
        parentChatId,
        executor: input?.executor,
        assignment: normalizeDelegationAssignment(
          input?.assignment,
          input?.executionMode || parent.sdkMode,
        ),
        reviewSubject: input?.reviewSubject ?? input?.review_subject,
        dataDir: resolveDataPath(),
      });
      if (!watcherGate.ok) {
        return watcherGate;
      }
      const cwd = startGate.cwd;
      const executionFolder = startGate.executionFolder || cwd;
      const sourceKind = normalizeDelegationSourceKind(input?.sourceKind);
      const requestedExecutionMode = input?.executionMode;
      // Keep the role requested by the caller before assignment normalization
      // flattens `fix` into the legacy shared implement/fix assignment, so a
      // real fix job is persisted explicitly instead of guessed later.
      const requestedRoleRaw = String(
        input?.requestedRole || input?.requested_role || input?.assignment || '',
      ).trim().toLowerCase();
      const requestedAssignment = normalizeDelegationAssignment(
        input?.assignment,
        requestedExecutionMode || parent.sdkMode,
      );
      const executionMode = resolveDelegationChildExecutionMode(
        requestedExecutionMode,
        requestedAssignment,
        parent.sdkMode,
      );
      const assignment = requestedAssignment;
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
        const found = resolveHistoryMessageSource(parentChatId, {
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
      const leafContext = resolveRequestLeafContext({
        input,
        parentChatId,
        workspaceFolder: cwd,
        dataDir: resolveDataPath(),
        sourceText,
        purpose: 'delegation_start',
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
      const transport = startGate.transport;
      const requestedModel = String(input?.executor?.model || '').trim();
      const model = startGate.model;
      // Host-verify policy for a review child: the effective (prior + observed)
      // `review_can_run_tests` trait decides whether the parent owes a
      // `delegation_verify`. Persisted once so the workflow gate reads one flag.
      const reviewVerifyPlan = resolveDelegationReviewVerifyPlan({
        assignment,
        executionMode,
        transport,
        rows: loadDelegations(),
      });
      const pickLink = resolveDelegationPickLinkFields({
        pickId,
        harness: transport,
        model,
        assignment,
        executionMode,
        role: requestedRoleRaw === 'fix' || requestedRoleRaw === 'plan' ? requestedRoleRaw : '',
        manualSource,
        pickFallbackFrom,
        fallbackFromRecord: pickFallbackFrom ? getDelegationById(pickFallbackFrom) : null,
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
        extraInstructions: input.extraInstructions,
        allowChildDelegations: startGate.allowChildDelegations,
      });
      const requestHash = buildRequestHash(parentChatId);
      if (idempotencyKey) {
        const existing = findDelegationByIdempotencyKey(idempotencyKey);
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
      // Start-side gates shared with `model_pick`: a named executor must not
      // bypass the flash-review rule, the adapter guarantee, the premium review
      // justification, or an active lockout/quota on the requested pair. Run
      // after the idempotency replay so a repeated request returns its existing
      // job even if the confirmation flag is omitted on the retry. `fix` is kept
      // explicit because assignment normalization folds it into implement.
      const gateRole = requestedRoleRaw === 'fix' ? 'fix' : resolveDelegationGateRole({
        assignment,
        executionMode,
      });
      const activeUsageLimits = safeListHarnessUsageLimits(cwd);
      const explicitNamedStart = !pickId;
      const startupLockoutWarning = explicitNamedStart
        ? readActiveStartupFailureLockoutWarning(transport, model, activeUsageLimits)
        : null;
      const modelGate = evaluateDelegationStartHardGates({
        ...buildNamedDelegationStartHardGateInput({
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
        }),
      });
      if (!modelGate.ok) return modelGate;
      const workflowGate = inspectDelegationWorkflowStart({
        parentChatId,
        leafId: workflowLeafId,
        assignment,
        resumeRounds: input.resumeRounds ?? input.resume_rounds,
        maxRounds: input.maxRounds ?? input.max_rounds,
      });
      if (!workflowGate.ok) return workflowGate;
      const reviewExtras = readExecutorPromptExtras({
        parentChatId,
        leafId: workflowLeafId,
        cwd,
        assignment,
        executionMode,
      });
      const codeReviewGate = inspectDelegationCodeReviewStart({
        assignment,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        workflow: reviewExtras.workflowRow,
        resumeRounds: input.resumeRounds ?? input.resume_rounds,
      });
      if (!codeReviewGate.ok) return codeReviewGate;
      const planReviewerSessionId = String(
        input?.planReviewerSessionId ?? input?.plan_reviewer_session_id ?? '',
      ).trim();
      const planReviewerPhase = String(
        input?.planReviewerPhase ?? input?.plan_reviewer_phase ?? 'independent',
      ).trim() || 'independent';
      const planReviewerGate = inspectPlanReviewerDelegationStart({
        planReviewerSessionId,
        planReviewerPhase,
        reviewSubject: reviewSubject.subject,
      });
      if (!planReviewerGate.ok) return planReviewerGate;
      const promptBuilt = buildDelegationExecutorPrompt({
        sourceKind,
        planMarkdown: planDoc.body,
        taskText: sourceText,
        parentChatId,
        sourceHistorySeq,
        workspaceFolder: executionFolder,
        extraInstructions: mergePlanReviewerDelegationExtraInstructions(input.extraInstructions, {
          planReviewerSessionId,
          planReviewerPhase,
        }),
        executionMode,
        assignment,
        childDelegation: buildChildDelegationPromptInput(startGate.allowChildDelegations, startGate.depth),
        workflowRow: reviewExtras.workflowRow,
        leafAcceptanceText: reviewExtras.leafAcceptanceText,
        leafMaterialText: reviewExtras.leafMaterialText,
        watcherFindingsText: reviewExtras.watcherFindingsText,
        reviewMode: codeReviewGate.mode,
      });
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
      const implementVerifyGate = inspectImplementVerifyBeforeReview({
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
      const todoPlanRevisionKey = resolveReviewedTodoPlanRevisionKey({
        assignment,
        reviewSubject: reviewSubject.subject,
        workspaceFolder: cwd,
        leafId: workflowLeafId,
      });
      const recheckGate = inspectReviewRecheckWithoutChange({
        parentChatId,
        assignment,
        reviewSubject: reviewSubject.subject,
        leafId: workflowLeafId,
        executor: { transport, model },
        todoPlanRevisionKey,
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
      const widthBlock = parentWidthConflict({
        parentChatId,
        incomingAssignment: assignment,
        gate: 'start',
        workspaceFolder: cwd,
        executionFolder,
        incomingLeafId: workflowLeafId,
      });
      if (widthBlock) {
        if (!isQueueableDelegationConflict(widthBlock.code)) return widthBlock;
        const queueMax = readDelegationQueueMax();
        if (queuedDepthForController(parentChatId) >= queueMax) return queueFullConflict(widthBlock, queueMax);
        queueConflict = { code: widthBlock.code, error: widthBlock.error };
      }
      // Reassigned only by an explicit, fully gated session resume (below).
      let childChatId = randomUUID();
      const attemptId = randomUUID();
      const title = String(input.title || '').trim()
        || `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : sourceKind === 'plan' ? 'build' : 'task'})`;
      const delegationId = randomUUID();
      if (codeReviewGate.mode === 'closure') {
        const workflowForClosure = resolveDelegationWorkflowRow({ parentChatId, leafId: workflowLeafId });
        const closureStartPatch = buildCodeReviewWorkflowPatchOnClosureStart(workflowForClosure);
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
      const pickRecord = pickLink.pickId ? getModelPickRecord(pickLink.pickId) : null;
      const exploreMarker = pickRecord?.explore || null;
      if (exploreMarker?.mode === 'real') {
        const exploreReserve = await reserveModelPickExploreBudget({
          marker: exploreMarker,
          delegationId,
          idempotencyKey,
          pickId: pickLink.pickId,
          workspaceKey: cwd,
          config: loadModelPickExploreConfig(),
          delegations: loadDelegations(),
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
      const parentRecheck = validateDelegationParent(loadChats().find(row => row.id === parentChatId));
      const widthRecheck = parentRecheck.ok ? parentWidthConflict({
        parentChatId,
        incomingAssignment: assignment,
        gate: 'start',
        workspaceFolder: cwd,
        executionFolder,
        incomingLeafId: workflowLeafId,
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
      const resumeDecision = inspectDelegationSessionResume({
        resumeSessionOf: readResumeSessionOfInput(input),
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
        delegations: loadDelegations(),
        findChat: (chatId) => loadChats().find((row) => row.id === chatId) || null,
        capabilities: getChatRunAdapterCapabilities(transport),
        lockoutActive: findActiveLockoutRow(activeUsageLimits, transport, model, Date.now()) != null,
        isRunActive: (chatId) => isChatRunStillActive({ chatId }),
        currentGeneration: (chatId) => getCacheStateForChat(chatId)?.generation ?? 0,
      });
      if (resumeDecision.resume) childChatId = resumeDecision.childChatId;
      const sessionResume = buildSessionResumeRecord(resumeDecision, {
        generation: getCacheStateForChat(childChatId)?.generation ?? 0,
      });
      let record;
      try {
        record = createDelegationRecord({
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
        // Not part of requestHash on purpose: adding it must not invalidate
        // in-flight/replayed starts created before the field existed.
        pickReason,
        pickId: pickLink.pickId,
        pickOrigin: pickLink.pickOrigin,
        pickOriginDetail: pickLink.pickOriginDetail,
        pickLinkStatus: pickLink.pickLinkStatus,
        pickRole: pickLink.pickRole,
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
      });
      } catch (err) {
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
      logDelegationEvent('queued', record);
      // Queue-time invalidation (decision U5): a queued review is `pending`, and
      // a queued implement/fix makes any prior `passed`/`manual` snapshot
      // `stale` before the job ever starts.
      safeSyncTodoReview(record, { dataDir: deps.dataDir });
      if (queueConflict) {
        // Parked behind a parent-width conflict: keep the durable `queued`
        // record, skip the child-run start, and let drainQueue resume it FIFO
        // once the slot frees. The response is a success (202), not a 409.
        const queuedRow = getDelegationById(record.id) || record;
        return attachLeafResolutionFields(attachDelegationStartWarning(tagReviewUncertified({
          ok: true,
          status: 202,
          delegation: queuedRow,
          chat: null,
          replayed: false,
          queued: true,
          queueConflict,
        }, reviewGate.reviewUncertified), startupLockoutWarning), leafContext);
      }
      const startPromise = startDelegationChildRun(record, parent, {
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
      const pendingStart = getDelegationById(record.id) || record;
      if (input?.returnWhenStarting === true && pendingStart.status === 'starting') {
        // MCP callers have a short HTTP request deadline. The start routine
        // synchronously persists the child and transitions the delegation to
        // `starting` before awaiting adapter acceptance, so it is safe to
        // acknowledge here and let the existing status/wait APIs track it.
        void startPromise.catch((err) => {
          try {
            const latest = getDelegationById(record.id) || record;
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
        const starting = getDelegationById(record.id) || pendingStart;
        const child = loadChats().find((row) => row.id === childChatId) || null;
        return attachLeafResolutionFields(attachDelegationStartWarning(tagReviewUncertified({
          ok: true,
          status: 202,
          delegation: starting,
          chat: child,
          replayed: false,
        }, reviewGate.reviewUncertified), startupLockoutWarning), leafContext);
      }
      const started = await startPromise;
      return attachLeafResolutionFields(
        attachDelegationStartWarning(tagReviewUncertified(started, reviewGate.reviewUncertified), startupLockoutWarning),
        leafContext,
      );
    });
  }

  /**
   * @param {object} existing
   * @param {object} parent
   * @param {object} ctx
   */
  async function resumeExistingDelegation(existing, parent, ctx, options = {}) {
    const fromDrain = options.fromDrain === true;
    const parentGate = validateDelegationParent(loadChats().find(row => row.id === parent.id));
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
      existing = updateDelegationRecord(existing.id, { assignment, executionMode }) || existing;
    }
    // A resume/retry reuses the frozen execution folder recorded at start.
    const executionFolder = String(
      existing.executionFolder || ctx.executionFolder || existing.workspaceFolder || '',
    ).trim();
    const reviewUncertified = assignment === 'review'
      && assertReviewAdapterAllowed(existing.executor?.transport).reviewUncertified === true;
    const childChatId = String(existing.childChatId || '').trim() || randomUUID();

    function buildReplay(extra = {}) {
      const latest = getDelegationById(existing.id) || existing;
      let child = loadChats().find((row) => row.id === childChatId) || null;
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

    function ensureResumeChildChat() {
      if (!String(existing.childChatId || '').trim()) {
        updateDelegationRecord(existing.id, { childChatId });
      }
      let child = loadChats().find((row) => row.id === childChatId) || null;
      if (!child) {
        const executor = existing.executor && typeof existing.executor === 'object' ? existing.executor : {};
        child = addChat(randomUUID(), `${parent.title || 'Chat'} (${assignment === 'review' ? 'review' : 'task'})`, parent.workspaceFile, parent.workspaceFolder, executor.model, {
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
          delegationAssignment: assignment,
          executionFolder,
          widgetInstallationId: parent.widgetInstallationId,
        });
      } else if (executionFolder && String(child.executionFolder || '').trim() !== executionFolder) {
        // Backfill a child created before the execution folder was persisted.
        child = updateChat(child.id, { executionFolder }) || child;
      }
      appendRelatedChatHistoryLinks({
        parentChat: parent,
        childChat: child,
        reason: 'delegation',
      });
      linkChildChatToTodo(child, parent);
      if (!hasDelegationHistoryEvent(parent.id, { id: existing.id, event: 'started', attemptId: existing.attemptId })) {
        publishDelegationStatus(existing, 'started');
      }
      return child;
    }

    if (hasInFlightDelegationStart(existing.id)) {
      ensureResumeChildChat();
      return buildReplay();
    }
    const knownChildId = String(existing.childChatId || '').trim();
    if (knownChildId) {
      const live = probeChatRunLiveness({ chatId: knownChildId, runId: existing.runId });
      if (live.busy) {
        ensureResumeChildChat();
        return buildReplay();
      }
    }
    if (existing.status !== 'queued' && existing.status !== 'starting') {
      const child = ensureResumeChildChat();
      return buildReplay({ chat: child });
    }
    const resumeGate = inspectQueuedDelegationResume(existing, parent, ctx, assignment, {
      ignoreQueuedWidth: fromDrain,
    });
    if (resumeGate.ok === false) return resumeGate;
    if (resumeGate.stayQueued) {
      return buildReplay({
        queued: true,
        queueConflict: resumeGate.queueConflict,
      });
    }
    const child = ensureResumeChildChat();
    const resumed = await startDelegationChildRun(getDelegationById(existing.id) || existing, parent, {
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
   * @param {object} existing
   * @param {object} parent
   * @param {object} ctx
   * @param {string} assignment
   */
  function inspectQueuedDelegationResume(existing, parent, ctx, assignment, options = {}) {
    const reviewGate = assignment === 'review'
      ? assertReviewAdapterAllowed(existing.executor?.transport)
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
    const workflowGate = inspectDelegationWorkflowStart({
      parentChatId: parent.id,
      assignment,
      leafId: workflowLeafId,
      resumeRounds: existing.resumeRounds ?? existing.resume_rounds,
      maxRounds: existing.maxRounds ?? existing.max_rounds,
    });
    if (!workflowGate.ok) return workflowGate;
    const workflowRow = resolveDelegationWorkflowRow({ parentChatId: parent.id, leafId: workflowLeafId });
    const codeReviewGate = inspectDelegationCodeReviewStart({
      assignment,
      reviewSubject: existing.reviewSubject,
      leafId: workflowLeafId,
      workflow: workflowRow,
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
    const widthBlock = parentWidthConflict({
      parentChatId: parent.id,
      incomingAssignment: assignment,
      resumeDelegationId: existing.id,
      gate: 'start',
      workspaceFolder: ctx.cwd || existing.workspaceFolder,
      executionFolder: existing.executionFolder || ctx.executionFolder || ctx.cwd || existing.workspaceFolder,
      ignoreQueued: ignoreQueuedWidth,
      incomingLeafId: workflowLeafId,
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
   * @param {object} record
   * @param {object} parent
   * @param {object} ctx
   */
  async function startDelegationChildRun(record, parent, ctx) {
    // Last gate before an adapter run is accepted. Covers replay/resume paths
    // that reach the start routine without passing the admission checks.
    if (!canAcceptNewRun()) return updateOperationConflict();
    const parentGate = validateDelegationParent(loadChats().find(row => row.id === parent.id));
    if (!parentGate.ok) {
      const failed = finishDelegation(record, { status: 'failed', error: parentGate.error });
      return { ...parentGate, delegation: failed };
    }
    const reviewExtras = readExecutorPromptExtras({
      parentChatId: parent.id,
      leafId: readDelegationWorkflowLeafIdFromRow(record),
      cwd: ctx.cwd,
      assignment: ctx.assignment,
      executionMode: ctx.executionMode,
    });
    const promptBuilt = buildDelegationExecutorPrompt({
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
      childDelegation: buildChildDelegationPromptInput(record.allowChildDelegations, record.depth),
      workflowRow: reviewExtras.workflowRow,
      leafAcceptanceText: reviewExtras.leafAcceptanceText,
      leafMaterialText: reviewExtras.leafMaterialText,
      watcherFindingsText: reviewExtras.watcherFindingsText,
      reviewMode: record.reviewMode,
      sessionResume: record.sessionResume?.status === 'resumed' ? record.sessionResume : null,
    });
    if (promptBuilt.ok && promptBuilt.prefixFingerprint && record.promptPrefixFingerprint !== promptBuilt.prefixFingerprint) {
      record = updateDelegationRecord(record.id, {
        promptPrefixFingerprint: promptBuilt.prefixFingerprint,
        promptCacheGeneration: Math.max(0, Number(getCacheStateForChat(ctx.childChatId)?.generation) || 0),
      }) || record;
    }
    if (!promptBuilt.ok) {
      const failed = finishDelegation(record, {
        status: 'failed',
        error: promptBuilt.error,
      });
      return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code, delegation: failed };
    }
    let child = loadChats().find((row) => row.id === ctx.childChatId) || null;
    if (!child) {
      try {
        child = addChat(randomUUID(), ctx.title, parent.workspaceFile, parent.workspaceFolder, ctx.model, {
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
          delegationAssignment: ctx.assignment,
          executionFolder: ctx.executionFolder || record.executionFolder,
          widgetInstallationId: parent.widgetInstallationId,
        });
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
      child = updateChat(child.id, {
        delegationId: record.id,
        delegationAssignment: ctx.assignment,
        sdkMode: ctx.executionMode,
        executionFolder: ctx.executionFolder || record.executionFolder,
        // Grant and tree position are re-bound too, never inherited.
        delegationGrant: record.allowChildDelegations === true,
        delegationDepth: record.depth,
        delegationRootChatId: record.rootChatId,
        delegationRootDelegationId: record.rootDelegationId,
      }) || child;
    }
    appendRelatedChatHistoryLinks({
      parentChat: parent,
      childChat: child,
      reason: 'delegation',
    });
    linkChildChatToTodo(child, parent);
    record = transition(record, 'starting', {
      childChatId: child.id,
      acceptRequestId: record.acceptRequestId || randomUUID(),
      acceptState: 'pending',
    }) || record;
    publishDelegationStatus(record, 'started');
    // Work-start hook: the attempt is now starting, so a review settles `pending`
    // and an implement/fix keeps the prior review `stale`.
    safeSyncTodoReview(record, { dataDir: deps.dataDir });
    rememberInFlightStart(record.id, { attemptId: record.attemptId, childChatId: child.id });
    try {
      const started = await startChatRun({
        chatId: child.id,
        prompt: promptBuilt.prompt,
        mode: ctx.executionMode,
        requestId: record.acceptRequestId || record.attemptId,
        displayText: promptBuilt.displayText,
        deps: {
          workspaceDirForAgent: deps.workspaceDirForAgent,
          todoSyncDataDir: deps.dataDir || '',
          ...(deps.chatRunDeps || {}),
          delegationId: record.id,
          attemptId: record.attemptId,
          assignment: ctx.assignment,
        },
      });
      runDelegationCrashHook('after-prompt-accept', record);
      const latest = await stopAcceptedRunIfObsolete({
        latest: getDelegationById(record.id) || record,
        started,
        childChatId: child.id,
      });
      if (isTerminalDelegationStatus(latest.status)) {
        const failed = latest.status === 'failed';
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
      const runningRow = running || latest;
      if (String(runningRow.pickOriginDetail || '').trim() === MODEL_PICK_EXPLORE_ORIGIN_DETAIL) {
        const explorePick = runningRow.pickId ? getModelPickRecord(String(runningRow.pickId)) : null;
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
      const latest = await stopAcceptedRunIfObsolete({
        latest: getDelegationById(record.id) || record,
        childChatId: child.id,
      });
      if (String(latest.pickOriginDetail || '').trim() === MODEL_PICK_EXPLORE_ORIGIN_DETAIL) {
        releaseModelPickExploreAttemptForDelegation({ delegationId: latest.id });
      }
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
    const current = getDelegationById(id);
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
      const latest = getDelegationById(id) || current;
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
    publishDelegationStatus(cancelling, 'cancelling');
    let cancelFailed = false;
    try {
      await cancelChatRun({ chatId: fence.childChatId, runId: fence.runId });
    } catch {
      cancelFailed = true;
    }
    const latest = getDelegationById(id) || cancelling;
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
   * @param {{ confirmation?: unknown, note?: string, actor?: string }} input
   */
  function confirmManualSlotRelease(id, input = {}) {
    const row = getDelegationById(id);
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
   * @returns {Promise<object>}
   */
  async function cancelTree(id) {
    const start = getDelegationById(id);
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
        start: getDelegationById(id),
        rows: listDelegationsForTreeRoot(resolveRecordTreeFields(start).rootDelegationId),
      });
      let touched = false;
      for (const row of subtree) {
        const before = getDelegationById(row.id) || row;
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
          const result = await cancel(before.id);
          const after = result?.delegation || getDelegationById(before.id) || before;
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
      status_of_root: String((getDelegationById(id) || start).status || ''),
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
  function acknowledge(id, input = {}) {
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    const reason = String(input.reason || 'reviewed').trim() || 'reviewed';
    // The actor is a channel signal derived server-side, never a body field a
    // client can choose (`docs/todo-review-contract.md` §7.2). A caller that
    // supplies nothing is an internal/unknown channel — never `human`.
    const actor = normalizeDelegationAckActor(input.actor) || 'unknown';
    // Acceptance carries the attempt and material (and optionally todo) revision
    // the card displayed; a stale screen is rejected instead of accepted (§7.3).
    const expectedAttemptId = String(input.expectedAttemptId || input.expected_attempt_id || '').trim();
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
      input.expected_material_revision,
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
      input.expected_todo_revision,
    );
    const expectedTodoRevision = expectedTodoRaw || '';
    const todoTarget = resolveDelegationAcceptTodo(current, {
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
      const next = updateDelegationRecord(current.id, {
        acknowledgedAt: new Date().toISOString(),
        acknowledgedReason: reason,
        acknowledgedActor: actor,
      });
      // A human acceptance can set `manual`; an agent/system ack is
      // decision-identical and produces no write.
      safeSyncTodoReview(next || current, { dataDir: deps.dataDir });
      return { ok: true, status: 200, delegation: next };
    }
    if (!isWaiting && !isTerminalAttention) {
      return { ok: true, status: 200, delegation: current, skipped: true };
    }
    const next = updateDelegationRecord(current.id, {
      acknowledgedAt: new Date().toISOString(),
      acknowledgedAttemptId: current.attemptId || '',
      acknowledgedReason: reason,
      acknowledgedActor: actor,
      // Audit trail of the CAS: the revision the accepting screen displayed
      // (`docs/todo-review-contract.md` §5.4 `acceptance.expectedTodoRevision`).
      acknowledgedExpectedTodoRevision: expectedTodoRevision,
      unverified: isTerminalAttention ? false : current.unverified,
    });
    if (isTerminalAttention && next) publishDelegationStatus(next, 'acknowledged');
    // Recompute after the acceptance write so `review.*.state` can reflect it.
    safeSyncTodoReview(next || current, { dataDir: deps.dataDir });
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
   * @param {object} row
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
   * @returns {{ ok: boolean, status: number, code?: string, error?: string,
   *   replayed?: boolean, rating?: object | null, delegation?: object }}
   */
  function rate(id, input = {}) {
    const current = getDelegationById(id);
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
    const payload = normalizeDelegationRatingPayload(input);
    if (!payload.ok) return { ok: false, status: payload.status, error: payload.error, code: payload.code };
    const fingerprint = fingerprintDelegationRating(payload.value);
    const existing = findDelegationRating(current.id, rater);
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
      if (!bias.ok) return { ...bias, delegation: current };
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
    let latest = getDelegationById(current.id) || current;
    if (rater === 'user') {
      // The card reads its rating from the history payload, so the user rating
      // publishes a (metadata-only) card event; a parent rating does not.
      const published = publishDelegationStatus(latest, 'rated');
      latest = published || latest;
    }
    return {
      ok: true,
      status: 200,
      replayed: false,
      rating: record,
      delegation: getDelegationById(current.id) || latest,
    };
  }

  /**
   * @param {string} chatId
   */
  async function cancelForDeletedChat(chatId) {
    const id = String(chatId || '').trim();
    if (!id) return { ok: true };
    const rows = loadDelegations().filter((row) => {
      // Deleting the historical starter must not cancel a job another chat controls.
      if (row.childChatId !== id && delegationController(row) !== id) return false;
      return isActiveDelegationStatus(row.status);
    });
    for (const row of rows) {
      const result = await cancel(row.id);
      if (!result.ok) {
        return {
          ok: false,
          status: 409,
          error: result.error || 'Could not stop the executor run.',
          code: result.code || 'cancel_failed',
        };
      }
      if (!result.pending) continue;
      let latest = getDelegationById(row.id);
      if (!latest || latest.status !== 'cancelling') continue;
      const now = Date.now();
      let live = probeChatRunLiveness({ chatId: row.childChatId, runId: row.runId });
      const busy = live.busy === true || live.known !== true || hasInFlightDelegationStart(latest.id);
      const outcome = resolveCancellingDeadline(latest, now, {
        busy,
        known: live.known === true,
      }, { finishDelegation, hasInFlightDelegationStart });
      if (outcome === 'released' || outcome === 'escalated') continue;
      latest = getDelegationById(row.id) || latest;
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
    const current = getDelegationById(id);
    if (!current) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
    return withParentLock(delegationController(current), async () => {
      const latest = getDelegationById(id);
      if (!latest) return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
      if (isActiveDelegationStatus(latest.status) || isDelegationSlotOccupied(latest)) {
        const blocker = inspectDelegationSlot(latest);
        return slotConflict(blocker, 'still_active', 'This delegation is still active.');
      }
      const interruptedGate = inspectInterruptedRetryGate(latest);
      if (!interruptedGate.ok) return interruptedGate;
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
      const reviewExtras = readExecutorPromptExtras({
        parentChatId: delegationController(latest),
        leafId: workflowLeafIdRetry,
        cwd: retryWorkspaceFolder,
        assignment,
        executionMode,
      });
      const codeReviewGateRetry = inspectDelegationCodeReviewStart({
        assignment,
        reviewSubject: latest.reviewSubject,
        leafId: workflowLeafIdRetry,
        workflow: reviewExtras.workflowRow,
      });
      if (!codeReviewGateRetry.ok) return codeReviewGateRetry;
      const promptBuilt = buildDelegationExecutorPrompt({
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
        childDelegation: buildChildDelegationPromptInput(latest.allowChildDelegations, latest.depth),
        workflowRow: reviewExtras.workflowRow,
        leafAcceptanceText: reviewExtras.leafAcceptanceText,
        leafMaterialText: reviewExtras.leafMaterialText,
        watcherFindingsText: reviewExtras.watcherFindingsText,
        reviewMode: latest.reviewMode || codeReviewGateRetry.mode,
      });
      if (!promptBuilt.ok) {
        return { ok: false, status: 400, error: promptBuilt.error, code: promptBuilt.code };
      }
      // Backfill the runner cwd on a child chat created before the split.
      if (retryExecutionFolder && latest.childChatId) {
        const existingChild = loadChats().find((row) => row.id === latest.childChatId);
        if (existingChild && String(existingChild.executionFolder || '').trim() !== retryExecutionFolder) {
          updateChat(existingChild.id, { executionFolder: retryExecutionFolder });
        }
      }
      const reviewGate = assignment === 'review'
        ? assertReviewAdapterAllowed(startGate.transport)
        : { ok: true };
      if (!reviewGate.ok) return reviewGate;
      const workflowLeafId = readDelegationWorkflowLeafIdFromRow(latest);
      const workflowGate = inspectDelegationWorkflowStart({
        parentChatId: delegationController(latest),
        assignment,
        leafId: workflowLeafId,
      });
      if (!workflowGate.ok) return workflowGate;
      const widthBlock = parentWidthConflict({
        parentChatId: delegationController(latest),
        incomingAssignment: latest.assignment,
        resumeDelegationId: latest.id,
        gate: 'retry',
        workspaceFolder: retryWorkspaceFolder,
        executionFolder: retryExecutionFolder,
        incomingLeafId: workflowLeafId,
      });
      if (widthBlock) return widthBlock;
      const parentRecheck = validateDelegationParent(loadChats().find(row => row.id === parent.id));
      if (!parentRecheck.ok) return parentRecheck;
      // Same synchronous re-check as a new start: an update claimed during the
      // awaits above must not let this retry start a child run.
      if (!canAcceptNewRun()) return updateOperationConflict();
      const attemptId = randomUUID();
      const acceptRequestId = randomUUID();
      const archived = snapshotDelegationAttempt(latest);
      const usedServerRestartContinuation = normalizeDelegationInterruptCode(latest.interruptCode) === DELEGATION_INTERRUPT_SERVER_RESTART;
      const starting = transition(latest, 'starting', {
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
        unverified: true,
        acknowledgedAt: '',
        acknowledgedAttemptId: '',
        acknowledgedReason: '',
        acknowledgedActor: '',
        acknowledgedExpectedTodoRevision: '',
        attempts: [...(Array.isArray(latest.attempts) ? latest.attempts : []), archived],
      });
      logDelegationEvent('retry', starting || latest, { attemptId });
      // Retry opens a new attempt: recompute so a superseded PASS cannot stay
      // current while the fresh attempt runs (`§4.6`, `§5.2`).
      safeSyncTodoReview(starting || latest, { dataDir: deps.dataDir });
      rememberInFlightStart(latest.id, { attemptId, childChatId: latest.childChatId });
      try {
        const started = await startChatRun({
          chatId: latest.childChatId,
          prompt: promptBuilt.prompt,
          mode: executionMode,
          requestId: acceptRequestId,
          displayText: promptBuilt.displayText,
          deps: {
            workspaceDirForAgent: deps.workspaceDirForAgent,
            todoSyncDataDir: deps.dataDir || '',
            ...(deps.chatRunDeps || {}),
            delegationId: latest.id,
            attemptId,
            assignment,
          },
        });
        runDelegationCrashHook('after-prompt-accept', starting || latest);
        const afterStart = await stopAcceptedRunIfObsolete({
          latest: getDelegationById(latest.id) || starting || latest,
          started,
          childChatId: latest.childChatId,
        });
        if (isTerminalDelegationStatus(afterStart.status)) {
          const failed = afterStart.status === 'failed';
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
        publishDelegationStatus(running || afterStart, 'retry');
        return tagReviewUncertified({ ok: true, status: 200, delegation: running || afterStart }, reviewGate.reviewUncertified);
      } catch (err) {
        const afterErr = await stopAcceptedRunIfObsolete({
          latest: getDelegationById(latest.id) || latest,
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
      const gate = parentWidthConflict({
        parentChatId,
        incomingAssignment: row.assignment,
        resumeDelegationId: row.id,
        gate: 'start',
        workspaceFolder: row.workspaceFolder,
        executionFolder: row.executionFolder || row.workspaceFolder,
        ignoreQueued: true,
        incomingLeafId: readDelegationWorkflowLeafIdFromRow(row),
      });
      if (gate) {
        // Transient slot / workspace / global hold: keep FIFO head parked.
        break;
      }
      const parent = loadChats().find((chat) => chat.id === parentChatId);
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
      const watcherGate = validateWorkspaceWatcherParentDelegation({
        parentChatId,
        executor: row.executor,
        assignment: normalizeDelegationAssignment(row.assignment, row.executionMode),
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
        const after = getDelegationById(row.id);
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
    const rows = only ? listDelegationsForController(only) : loadDelegations();
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

  return {
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
 * run ended, so the slot stays occupied. Confirmed idle running/waiting jobs
 * get the same 60s orphan grace as the worker.
 */
export async function reconcileDelegationsOnBoot() {
  return enqueueDelegationStoreWork(async () => {
    const now = Date.now();
    for (const row of loadDelegations()) {
      let current = row;
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
            if (busy) updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() });
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
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
        // Confirmed idle adapter: the restart leaves the start unconfirmed.
        // Unknown liveness (missing run id or not) keeps the slot because the
        // adapter may have accepted a run before restart.
        if (known) {
          const finished = finishDelegation(row, {
            status: 'interrupted',
            interruptCode: DELEGATION_INTERRUPT_SERVER_RESTART,
            error: SERVER_RESTART_ERROR,
            enqueueParentReply: true,
          });
          await flushDelegationOutboxUnlocked(finished || row);
        }
        continue;
      }

      if (row.status === 'cancelling') {
        const lastError = Array.isArray(row.errors) ? row.errors[row.errors.length - 1] : null;
        resolveCancellingDeadline(row, now, {
          busy,
          known,
          appendCancelTimeoutError: true,
          lastCancelTimeoutErrorAt: lastError?.code === 'cancel_timeout' ? lastError.at : '',
        }, { finishDelegation, hasInFlightDelegationStart });
        await flushDelegationOutboxUnlocked(getDelegationById(row.id) || row);
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
            if (busy) updateDelegationRecord(repaired.id, { runStoppingAt: new Date().toISOString() });
            else releaseDelegationRunSlot(repaired);
          }
          continue;
        }
        if (busy) continue;
        // Unknown liveness is not proof of a lost run: keep the occupied slot.
        if (!known) continue;
        if (row.status === 'running' || row.status === 'waiting_for_input') {
          const observed = String(row.idleObservedAt || '').trim();
          if (!observed) {
            updateDelegationRecord(row.id, { idleObservedAt: new Date(now).toISOString() });
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
        publishDelegationStatus(row, 'finished');
      }
    }
    reconcileMailboxOnBoot();
    for (const chat of loadChats()) {
      await drainChatMailbox(chat.id);
    }
  });
}

export const delegationService = createDelegationService();
