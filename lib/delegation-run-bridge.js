/**
 * Map harness room events onto the active delegation record.
 */

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

import {
  applyLateDelegationMetrics,
  finishDelegation,
  flushDelegationOutbox,
  isDelegationEventCurrent,
  refreshFinishedDelegationSessionContinuity,
  scheduleDelegationHistoryPublish,
} from './delegation-service.js';
import { drainChatMailbox } from './delegation-mailbox.js';
import { canTransitionDelegationStatus, isActiveDelegationStatus } from './delegation-status.js';
import {
  getDelegationById,
  updateDelegationRecord,
} from './persist/delegations-persist.js';
import { loadChats, updateChat } from './persist/chats-persist.js';
import { getSdkToolCallName } from './sdk/sdk-plan-guard.ts';
import { readReportedTokenCount } from './sdk/sdk-context-advisory.ts';
import {
  buildRunMetrics,
  diffGitSnapshots,
  isExecuteAssignment,
} from './delegation-metrics.js';
import { readAttemptUsageMetrics } from './usage/attempt-usage.ts';
import { captureGitSnapshot } from './delegation-metrics-git.js';
import { isReviewReadOnlyAssignment } from './delegation-review-policy.js';
import {
  applyFinalReportQuietStopToPayload,
  applyFinalReportQuietStopToSdkEvent,
  DELEGATION_FINAL_REPORT_ERROR_CODE,
  normalizeSdkRunStatus,
} from './sdk/sdk-run-outcome.ts';
import { resolveDelegationFinishReport } from './delegation-verdict.js';
import { queueVerdictFollowUp } from './delegation-verdict-followup.js';
import { delegationRuntimeAssignment } from './delegation-work-role.js';
import { readCurrentSessionContinuity } from './delegation-session-continuity.js';
import { getChatHistorySince } from './persist/chat-history-service.js';

/** Find the durable terminal record captured by this event, even if later turns were flushed. */
async function findFinishedHistoryBoundary(chatId, before, marker) {
  if (!before || !Number.isSafeInteger(marker.roomEventSeq) || !marker.eventStreamId) return null;
  let cursor = Math.max(0, before.historyHeadSeq - 1);
  for (;;) {
    const page = await getChatHistorySince(chatId, cursor, 500);
    if (page?.ok !== true || !Array.isArray(page.events)) return null;
    const terminal = page.events.find(({ rec }) => rec?.kind === 'meta'
      && rec.variant === 'runFinished'
      && rec.eventStreamId === marker.eventStreamId
      && rec.roomEventSeq === marker.roomEventSeq);
    if (terminal) return { ...before, historyHeadSeq: terminal.seq };
    const last = page.events.at(-1);
    if (!page.hasMore || !last || last.seq <= cursor) return null;
    cursor = last.seq;
  }
}
import { noteChatRunFinished } from './chat-run/chat-run-recovery.ts';

/**
 * @param {any} room
 * @param {Record<string, unknown>} payload
 * @returns {Promise<unknown> | void}
 */
export function noteDelegationRoomEvent(room, payload) {
  if (!payload || typeof payload !== 'object') return;
  const type = typeof payload.type === 'string' ? payload.type : '';
  const delegationId = String(room?.delegationId || '').trim();
  const eventRunId = typeof payload.runId === 'string' ? payload.runId : '';
  let current = /** @type {Record<string, any>} */ (delegationId ? getDelegationById(delegationId) : null);
  if (type === 'sdkPromptStarted' && current) {
    current = adoptDelegationContinuationRun(room, current, payload, eventRunId);
  }
  const isCurrent = current && isDelegationEventCurrent(current, eventRunId, room.delegationAttemptId);
  /** @type {Promise<unknown> | null} */
  let pingParent = null;
  if (current && isCurrent) {
    if (type === 'sdkEvent') {
      // Real sdkEvent payloads carry no runId: fall back to the run the room
      // remembered on sdkPromptStarted (`_runId`, survives the run end), then to
      // the adapter's live `currentRun`.
      noteAttemptToolCall(room, payload.event, eventRunId || String(room?._runId || room?.currentRun?.id || ''));
      noteInputRequest(room, current, payload.event);
      clearStartupRetryOnConfirmedExecution(current, payload.event);
    } else if (type === 'opencodeQuestionResolved' || type === 'opencodePermissionResolved') {
      if (current.status === 'waiting_for_input' && canTransitionDelegationStatus(current.status, 'running')) {
        const running = /** @type {DelegationRecord | null} */ (updateDelegationRecord(current.id, { status: 'running' }));
        if (running) scheduleDelegationHistoryPublish(running, 'running');
      }
    } else if (type === 'sdkPromptStarted') {
      // Snapshot the working tree before the run edits it, so the finish diff
      // attributes only this run's changes (git works for every harness, not
      // just the SDK). Baseline lives on the room; a mid-run restart loses it
      // and the git metrics simply stay null ("no data", never an error).
      captureRoomDelegationGitBase(room, current);
    } else if (type === 'sdkRunFinished') {
      const status = normalizeSdkRunStatus(payload.status);
      const assistantText = String(room._currentRunAssistantText || '').trim();
      let deferFinish = shouldDeferDelegationRunFinish(room, current);
      let reportText = assistantText;
      // Guard resume and VERDICT follow-up continue the SAME attempt in a new
      // adapter run; a plain `waiting_for_input` deferral does not.
      let continuationQueued = room?._codexReviewGuardResumeQueued === true;
      if (status === 'completed' && !deferFinish) {
        // A follow-up reply is judged together with the original report so a
        // bare VERDICT line is never mistaken for a too-short review.
        const base = String(room._verdictFollowUpBase || '');
        if (base) {
          reportText = `${base}\n\n${assistantText}`.trim();
          room._verdictFollowUpBase = '';
        } else if (current.assignment === 'review' && queueVerdictFollowUp(room, {
          assignment: current.assignment,
          report: assistantText,
          harness: current.harness || room.harness,
        })) {
          room._verdictFollowUpBase = assistantText;
          deferFinish = true;
          continuationQueued = true;
        }
      }
      if (deferFinish && continuationQueued) {
        noteDelegationContinuation(room, current);
      }
      // An accepted final_report already finished this job; its quiet stop only releases the hold.
      const isAcceptedReportStop = payload.lastErrorCode === DELEGATION_FINAL_REPORT_ERROR_CODE;
      let finished = null;
      // Collect this run's efficiency metrics once, attached to whichever
      // terminal finish actually writes. A deferred finish keeps nothing for
      // the later (re-bound) run to record.
      const finishMetrics = deferFinish
        ? null
        : collectRoomDelegationMetrics(room, current, {
          usageMetrics: readLedgerMetricsSafe(current),
          runId: eventRunId,
        });
      if (isAcceptedReportStop) {
        room.serverHold = false;
        // The report already closed the attempt; the adapter's own metrics
        // arrive here and only complete it (verdict/ACK/slot untouched).
        if (finishMetrics) {
          applyLateDelegationMetrics(current.id, room.delegationAttemptId || current.attemptId, finishMetrics);
        }
      } else if (status === 'completed') {
        if (!deferFinish) {
          const resolved = resolveDelegationFinishReport({
            assignment: current.assignment,
            report: reportText,
            taskOutcome: current.taskOutcome,
            status: 'completed',
          });
          finished = finishDelegation(current, {
            status: resolved.status,
            report: resolved.report,
            error: resolved.error,
            taskOutcome: resolved.taskOutcome,
            attemptId: room.delegationAttemptId,
            enqueueParentReply: true,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      } else if (status === 'cancelled') {
        if (!deferFinish) {
          finished = finishDelegation(current, {
            status: 'cancelled',
            report: assistantText,
            attemptId: room.delegationAttemptId,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      } else if (status === 'error' || status === 'failed') {
        if (!deferFinish) {
          const error = typeof payload.lastErrorMessage === 'string'
            ? payload.lastErrorMessage
            : typeof payload.result === 'string' ? payload.result : '';
          const errorCode = String(payload.lastErrorCode || '').trim();
          finished = finishDelegation(current, {
            status: 'failed',
            error: errorCode === 'adapter_timeout' && error && !error.includes('adapter_timeout')
              ? `[adapter_timeout] ${error}`
              : errorCode === 'review_guard_exhausted' && error && !error.includes('review_guard_exhausted')
                ? `[review_guard_exhausted] ${error}`
                : error,
            report: assistantText,
            attemptId: room.delegationAttemptId,
            enqueueParentReply: true,
            metrics: finishMetrics,
          });
          room.serverHold = false;
        }
      }
      // Not awaited by the room handler either: an outbox flush that fails
      // (history service closed during shutdown, storage host going away)
      // stays queued for the next drain or boot recovery, so log it instead of
      // letting it become an unhandled rejection.
      if (finished) {
        pingParent = flushDelegationOutbox(finished).catch((error) => {
          console.warn(`[delegation] outbox flush for ${finished.id} failed: ${error?.message || error}`);
          return null;
        });
      }
    }
  }
  if (type === 'sdkRunFinished' && current && !isCurrent) {
    applyLateMetricsForSupersededAttempt(room, current, payload);
  }
  if (type === 'sdkRunFinished') {
    const beforeFlush = current && isCurrent ? readCurrentSessionContinuity(current.childChatId) : null;
    const terminalAttemptId = String(room?.delegationAttemptId || current?.attemptId || '');
    const terminalMarker = { eventStreamId: String(room?.eventStreamId || ''), roomEventSeq: Number(payload.roomEventSeq) };
    const continuityRefresh = current && isCurrent && typeof room?._flushHistory === 'function'
      ? Promise.resolve().then(() => room._flushHistory()).then(async (result) => {
        if (result?.ok !== true || Number(result?.pending) > 0) return null;
        const boundary = await findFinishedHistoryBoundary(current.childChatId, beforeFlush, terminalMarker);
        if (!boundary) return null;
        return refreshFinishedDelegationSessionContinuity({
          delegationId: current.id,
          attemptId: terminalAttemptId,
          boundary,
          expectedSession: beforeFlush,
        });
      }).catch(() => null)
      : null;
    syncRoomDelegationAssignment(room);
    const chatId = String(room?.chatId || '').trim();
    // R5 terminal evidence for a server-started chat run (no-op for runs the
    // server did not launch). Never throws.
    noteChatRunFinished({ chatId, runId: eventRunId, status: String(payload.status || '') });
    if (chatId) {
      // Room handlers do not await this promise. A drain that fails (storage
      // host shutting down, a request expired in the storage queue) leaves the
      // rows queued for the next drain or the boot recovery, so it is logged
      // instead of surfacing as an unhandled rejection.
      const drain = drainChatMailbox(chatId).catch((error) => {
        console.warn(`[delegation] mailbox drain for ${chatId} failed: ${error?.message || error}`);
        return [];
      });
      const work = [pingParent, drain, continuityRefresh].filter(Boolean);
      return work.length > 1 ? Promise.all(work) : work[0];
    }
    if (continuityRefresh) return continuityRefresh;
  }
  return pingParent || undefined;
}

/** Statuses in which a queued continuation run may take over the record's run fence. */
const CONTINUATION_ADOPT_STATUSES = new Set(['running', 'waiting_for_input', 'cancelling']);

/**
 * Remember that the deferred finish of this run hands the attempt over to the
 * next queued run of the same room (codex review guard resume, VERDICT
 * follow-up). Observation only: nothing is started or finished here.
 *
 * @param {any} room
 * @param {Record<string, any>} current
 */
function noteDelegationContinuation(room, current) {
  if (!room || typeof room !== 'object' || !current?.id) return;
  room._delegationContinuation = {
    delegationId: String(current.id),
    attemptId: String(current.attemptId || '').trim(),
    fromRunId: String(current.runId || '').trim(),
  };
}

/**
 * The continuation prompt runs under a NEW adapter run id while the record
 * still fences on the deferred run. Without adopting it, that run's finish is
 * dropped as foreign, liveness probes read `run_mismatch` (unknown) and a plain
 * cancel targets the dead run, so a read-only review ends `review_cancel_stuck`
 * although the history shows the run finished. Adopt the new run id once, only
 * for the same delegation + attempt while the record still points at the
 * deferred run; a late event of the old run is then fenced out and can never
 * finalize the new one. No run is started, resumed or killed here.
 *
 * @param {any} room
 * @param {Record<string, any>} current
 * @param {Record<string, unknown>} payload
 * @param {string} eventRunId
 * @returns {Record<string, any>}
 */
function adoptDelegationContinuationRun(room, current, payload, eventRunId) {
  const pending = room?._delegationContinuation;
  if (!pending || typeof pending !== 'object') return current;
  room._delegationContinuation = null;
  const runId = String(eventRunId || '').trim();
  if (!runId || payload.fromQueue !== true) return current;
  if (pending.delegationId !== String(current.id)) return current;
  const attemptId = String(current.attemptId || '').trim();
  const roomAttemptId = String(room.delegationAttemptId || '').trim();
  if (pending.attemptId !== attemptId || (roomAttemptId && roomAttemptId !== attemptId)) return current;
  if (pending.fromRunId !== String(current.runId || '').trim()) return current;
  if (!CONTINUATION_ADOPT_STATUSES.has(String(current.status || ''))) return current;
  if (runId === pending.fromRunId) return current;
  return updateDelegationRecord(current.id, { runId, idleObservedAt: '' }) || current;
}

/**
 * Executor-output event types that prove the run reached its first event:
 * anything the executor itself produced (assistant text, thinking, a tool
 * call). A `user` event is the local prompt echo and is deliberately not
 * accepted — it precedes the first event the startup timeout waits for.
 *
 * @param {unknown} event
 * @returns {boolean}
 */
function isConfirmedExecutionEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const type = String(/** @type {{ type?: unknown }} */ (event).type || '').trim().toLowerCase();
  return type === 'assistant' || type === 'thinking' || type === 'tool_call';
}

/**
 * Authoritative "confirmed valid execution" signal for the bounded startup
 * retry: the first executor-output event for the CURRENT attempt clears the
 * retry budget, because from that point on a failure can no longer be a
 * startup failure (the first-event timeout cannot fire after the first event).
 * `isCurrent` (run id + attempt id fence) has already been checked by the
 * caller, so a late event from a superseded attempt cannot clear a live
 * budget. At most one write per job: rows without retry bookkeeping return
 * before any store access.
 *
 * @param {Record<string, any>} current
 * @param {unknown} event
 */
function clearStartupRetryOnConfirmedExecution(current, event) {
  if (!current?.startupRetry) return;
  if (!isConfirmedExecutionEvent(event)) return;
  updateDelegationRecord(current.id, { startupRetry: null });
}

/**
 * @param {any} room
 * @returns {{ jobStatus: string, finalReportAcceptedAt: string, finalReportRunId: string }}
 */
function readDelegationQuietStopMeta(room) {
  let id = String(room?.delegationId || '').trim();
  if (!id) {
    const chatId = String(room?.chatId || '').trim();
    if (chatId) {
      const chat = loadChats().find((row) => row.id === chatId);
      id = String(chat?.delegationId || '').trim();
    }
  }
  if (!id) return { jobStatus: '', finalReportAcceptedAt: '', finalReportRunId: '' };
  const row = /** @type {DelegationRecord | null} */ (getDelegationById(id));
  return {
    jobStatus: String(row?.status || '').trim(),
    finalReportAcceptedAt: String(row?.finalReportAcceptedAt || '').trim(),
    finalReportRunId: String(row?.finalReportRunId || row?.runId || '').trim(),
  };
}

/**
 * Quiet leftover-run cancel after an accepted `final_report`. Mutates payload.
 *
 * @param {any} room
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown> | null | undefined}
 */
export function applyDelegationFinalReportRunFinished(room, payload) {
  if (!payload || payload.type !== 'sdkRunFinished') return payload;
  return applyFinalReportQuietStopToPayload(payload, readDelegationQuietStopMeta(room));
}

/**
 * Quiet leftover-run `status` cancel after an accepted `final_report`.
 *
 * @param {any} room
 * @param {Record<string, unknown> | null | undefined} payload
 * @returns {Record<string, unknown> | null | undefined}
 */
export function applyDelegationFinalReportSdkEvent(room, payload) {
  if (!payload || payload.type !== 'sdkEvent') return payload;
  const event = /** @type {Record<string, any>} */ (payload.event);
  if (!event || typeof event !== 'object') return payload;
  applyFinalReportQuietStopToSdkEvent(event, {
    ...readDelegationQuietStopMeta(room),
    runId: event.run_id || event.runId || room?.lastRunId,
  });
  return payload;
}

/**
 * @param {any} room
 * @param {DelegationRecord} current
 * @param {unknown} event
 */
/**
 * @param {any} room
 * @returns {boolean}
 */
function roomHasPendingOpenCodeUserInput(room) {
  if (!room || typeof room !== 'object') return false;
  const questions = room._pendingOpenCodeQuestions instanceof Map && room._pendingOpenCodeQuestions.size > 0;
  const permissions = room._pendingOpenCodePermissions instanceof Map && room._pendingOpenCodePermissions.size > 0;
  return questions || permissions;
}

/**
 * @param {any} room
 * @param {Record<string, any>} current
 * @returns {boolean}
 */
function shouldDeferDelegationRunFinish(room, current) {
  if (current.status === 'waiting_for_input') return true;
  // Codex review aborted one command and already queued a follow-up prompt.
  if (room?._codexReviewGuardResumeQueued === true) return true;
  return roomHasPendingOpenCodeUserInput(room);
}

function noteInputRequest(room, current, event) {
  if (!event || typeof event !== 'object') return;
  const name = getSdkToolCallName(event).toLowerCase();
  const rec = /** @type {Record<string, unknown>} */ (event);
  const eventType = typeof rec.type === 'string' ? rec.type.trim().toLowerCase() : '';
  const isQuestion =
    eventType === 'opencode_question' ||
    eventType === 'opencode_permission' ||
    name.includes('question') ||
    name.includes('permission') ||
    rec.type === 'user_action_required';
  if (!isQuestion) return;
  if (current.status === 'waiting_for_input') return;
  if (!canTransitionDelegationStatus(current.status, 'waiting_for_input')) return;
  const waiting = /** @type {DelegationRecord | null} */ (updateDelegationRecord(current.id, { status: 'waiting_for_input' }));
  if (waiting) scheduleDelegationHistoryPublish(waiting, 'waiting_for_input');
}

/**
 * Snapshot the shared working tree so the finish diff can attribute only this
 * run's edits. Skipped for read-only roles (plan/review) — they change no files.
 *
 * @param {any} room
 * @param {Record<string, any>} current
 */
function captureRoomDelegationGitBase(room, current) {
  if (!room || typeof room !== 'object') return;
  if (!isExecuteAssignment(current?.assignment)) return;
  const cwd = String(current?.workspaceFolder || room.cwd || '').trim();
  room._delegationGitBase = captureGitSnapshot(cwd);
}

/**
 * Build the `metrics` object stored on the delegation record at close.
 *
 * Sources, kept strictly nullable so "no data" is never an error:
 * - tokens: sdk/qwen/opencode/deepseek rooms track them (`_lastUsagePayload`
 *   carries the run's cumulative usage); other harnesses report none, so that
 *   field stays null. tool calls: only the Cursor SDK room counts them
 *   (`_toolCallsTotal`), so the field stays null elsewhere.
 * - git diff: implement/fix only, from the baseline captured at run start versus
 *   the tree now. A missing baseline (non-repo, restart) yields null.
 *
 * - claude/codex: tokens, cache and cost come from the attempt-scoped usage
 *   ledger (`options.usageMetrics`, already deduplicated); tool calls are the
 *   distinct finished `tool_call` ids seen for the attempt.
 *
 * @param {any} room
 * @param {Record<string, any>} current
 * @param {{ usageMetrics?: Record<string, number | string | null> | null, omitGit?: boolean, runId?: string }} [options]
 * @returns {Record<string, number | string | null>}
 */
export function collectRoomDelegationMetrics(room, current, options = {}) {
  const transport = String(current?.executor?.transport || '').trim().toLowerCase();
  const ledger = options.usageMetrics && typeof options.usageMetrics === 'object'
    ? options.usageMetrics
    : null;
  let tokensIn = null;
  let tokensOut = null;
  let toolCalls = null;
  if (transport === 'sdk' || transport === 'qwen' || transport === 'opencode' || transport === 'deepseek') {
    const usage = room && typeof room === 'object'
      && room._lastUsagePayload && typeof room._lastUsagePayload === 'object'
      ? room._lastUsagePayload
      : null;
    tokensIn = usage ? readReportedTokenCount(usage.inputTokens) : null;
    tokensOut = usage ? readReportedTokenCount(usage.outputTokens) : null;
    const assignment = String(current?.assignment || '').trim().toLowerCase();
    if (transport === 'sdk' && (isExecuteAssignment(assignment) || isReviewReadOnlyAssignment(assignment))) {
      const total = room ? Number(room._toolCallsTotal) : NaN;
      toolCalls = Number.isFinite(total) && total >= 0 ? total : null;
    }
  }
  if (LEDGER_METRICS_TRANSPORTS.has(transport)) {
    // Claude/Codex stream deltas into the usage ledger rather than a room
    // payload, and their tool events are `tool_call` rows keyed by call id.
    // The attempt-scoped ledger is deduplicated, so it owns the token fields.
    tokensIn = ledger ? asKnownCount(ledger.tokens_in) : null;
    tokensOut = ledger ? asKnownCount(ledger.tokens_out) : null;
    toolCalls = readAttemptToolCallCount(room, current?.attemptId);
  } else if (ledger) {
    if (tokensIn == null) tokensIn = asKnownCount(ledger.tokens_in);
    if (tokensOut == null) tokensOut = asKnownCount(ledger.tokens_out);
  }
  // One source per token family: sdk/qwen room `inputTokens` already include
  // cache, so ledger cache would overlap them. Cache keys are only attached
  // when the ledger also supplied tokens_in (claude/codex, or a room without
  // its own usage payload).
  const tokensFromLedger = LEDGER_METRICS_TRANSPORTS.has(transport)
    || (ledger && tokensIn != null && tokensIn === asKnownCount(ledger.tokens_in));
  const extras = ledger && !tokensFromLedger
    ? { ...ledger, cache_read_tokens: null, cache_write_tokens: null }
    : ledger;
  let filesChanged = null;
  let linesAdded = null;
  let linesRemoved = null;
  if (options.omitGit !== true && isExecuteAssignment(current?.assignment)) {
    const base = room && typeof room === 'object' ? room._delegationGitBase : null;
    const head = captureGitSnapshot(String(current?.workspaceFolder || room?.cwd || '').trim());
    const delta = diffGitSnapshots(base, head);
    if (delta) {
      filesChanged = delta.files_changed;
      linesAdded = delta.lines_added;
      linesRemoved = delta.lines_removed;
    }
  }
  const startedAtMs = Date.parse(String(current?.startedAt || ''));
  return buildRunMetrics({
    tokensIn,
    tokensOut,
    toolCalls,
    filesChanged,
    linesAdded,
    linesRemoved,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    finishedAtMs: Date.now(),
    extras,
  });
}

/** Transports whose tokens come from the usage ledger and tools from `tool_call` events. */
const LEDGER_METRICS_TRANSPORTS = new Set(['claude', 'codex']);

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function asKnownCount(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/**
 * Ledger metrics for the current attempt; `null` when the ledger is unreadable.
 *
 * @param {Record<string, any>} current
 * @param {string} [attemptId]
 * @returns {Record<string, number | string | null> | null}
 */
function readLedgerMetricsSafe(current, attemptId = current?.attemptId) {
  try {
    return readAttemptUsageMetrics({ delegation: current, attemptId });
  } catch {
    return null;
  }
}

/**
 * Count one finished tool call per attempt. The set is keyed by run id + call id, so a
 * replayed event, a resumed turn in the same attempt, or the running+completed
 * pair of one call never counts twice; a new attempt starts a new set.
 *
 * @param {any} room
 * @param {unknown} event
 * @param {string} [runId]
 */
function noteAttemptToolCall(room, event, runId = '') {
  if (!room || typeof room !== 'object' || !event || typeof event !== 'object') return;
  const rec = /** @type {Record<string, unknown>} */ (event);
  if (String(rec.type || '') !== 'tool_call') return;
  const status = String(rec.status || '').trim().toLowerCase();
  if (status !== 'completed' && status !== 'error') return;
  const callId = typeof rec.call_id === 'string' ? rec.call_id.trim() : '';
  if (!callId) return;
  // Adapter call ids (Codex `item_N`) restart on every run, so the key carries
  // the run id; a replayed event of the same run still collapses to one key.
  const key = `${runId || ''}\u0000${callId}`;
  const attemptId = String(room.delegationAttemptId || '').trim();
  if (room._attemptToolCalls?.attemptId !== attemptId) {
    room._attemptToolCalls = { attemptId, ids: new Set() };
  }
  room._attemptToolCalls.ids.add(key);
}

/**
 * @param {any} room
 * @param {unknown} attemptId
 * @returns {number | null} `null` when no tool event was ever observed
 */
function readAttemptToolCallCount(room, attemptId) {
  const tracked = room?._attemptToolCalls;
  if (!tracked || tracked.attemptId !== String(attemptId || '').trim()) return null;
  return tracked.ids.size;
}

/**
 * A finish for an attempt that a retry already superseded: the event is not
 * current, so it must not change the record, but its usage still belongs to the
 * archived attempt. Git metrics are skipped (the tree moved on since).
 *
 * @param {any} room
 * @param {Record<string, any>} current
 * @param {Record<string, unknown>} payload
 */
function applyLateMetricsForSupersededAttempt(room, current, payload) {
  const attemptId = String(room?.delegationAttemptId || '').trim();
  if (!attemptId || attemptId === String(current.attemptId || '').trim()) return;
  const archived = (Array.isArray(current.attempts) ? current.attempts : [])
    .find((row) => String(row?.attemptId || '').trim() === attemptId);
  if (!archived) return;
  const view = { ...current, attemptId, executor: current.executor, startedAt: archived.startedAt, attempts: current.attempts };
  const metrics = collectRoomDelegationMetrics(room, view, {
    usageMetrics: readLedgerMetricsSafe(current, attemptId),
    omitGit: true,
    runId: typeof payload.runId === 'string' ? payload.runId : '',
  });
  applyLateDelegationMetrics(current.id, attemptId, metrics);
}

/**
 * @param {any} room
 * @param {{ delegationId?: string, attemptId?: string, assignment?: string }} [meta]
 */
export function bindRoomToDelegation(room, meta = {}) {
  if (!room) return;
  const chatId = String(room.chatId || '').trim();
  const metaDelegationId = String(meta.delegationId || '').trim();
  const metaAttemptId = String(meta.attemptId || '').trim();
  const metaAssignment = String(meta.assignment || '').trim();
  let hydrated = null;
  if (!metaDelegationId && !String(room.delegationId || '').trim() && chatId) {
    hydrated = readActiveRoomChatDelegation(chatId);
  }
  const delegationId = metaDelegationId || String(hydrated?.id || '').trim();
  if (delegationId) room.delegationId = delegationId;
  const attemptId = metaAttemptId || String(hydrated?.attemptId || '').trim();
  if (attemptId) room.delegationAttemptId = attemptId;
  const assignment = metaAssignment || String(hydrated?.assignment || '').trim();
  if (assignment) room.delegationAssignment = assignment;
  if (delegationId) room.serverHold = true;
  syncRoomDelegationAssignment(room);
}

/**
 * Reattach hydration: a room recreated without deps meta can recover its job
 * from the persisted child chat, like `readDelegationQuietStopMeta` does.
 * Only a live job that still owns this chat may adopt the room.
 *
 * @param {string} chatId
 * @returns {Record<string, any> | null}
 */
function readActiveRoomChatDelegation(chatId) {
  const chat = loadChats().find((row) => row.id === chatId);
  const delegationId = String(chat?.delegationId || '').trim();
  if (!delegationId) return null;
  const record = /** @type {DelegationRecord | null} */ (getDelegationById(delegationId));
  if (!record || !isActiveDelegationStatus(record.status)) return null;
  if (String(record.childChatId || '').trim() !== chatId) return null;
  return record;
}

/**
 * Review read-only applies only while that job is still active.
 * Follow-up turns in the same child chat use SDK mode after the job ends.
 *
 * @param {any} room
 * @returns {string}
 */
export function syncRoomDelegationAssignment(room) {
  if (!room || typeof room !== 'object') return '';
  const id = String(room.delegationId || '').trim();
  const rec = /** @type {Record<string, any>} */ (id ? getDelegationById(id) : null);
  const next = rec && isActiveDelegationStatus(rec.status)
    ? delegationRuntimeAssignment(rec)
    : '';
  room.delegationAssignment = next;
  persistChatDelegationAssignment(String(room.chatId || '').trim(), next);
  return next;
}

/**
 * @param {any} room
 * @returns {string}
 */
export function readRoomDelegationAssignment(room) {
  return syncRoomDelegationAssignment(room);
}

/**
 * @param {string} chatId
 * @param {string} assignment
 */
function persistChatDelegationAssignment(chatId, assignment) {
  if (!chatId) return;
  const chat = loadChats().find((row) => row.id === chatId);
  if (!chat) return;
  const current = /** @type {Record<string, any>} */ (String(chat.delegationAssignment || '').trim());
  if (current === assignment) return;
  updateChat(chatId, { delegationAssignment: assignment || null });
}
