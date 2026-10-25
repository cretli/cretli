/**
 * Server-side manual resume service (leaf R12).
 *
 * One entry point, `resumeRun`, used by the HTTP "Resume" action (and reused by
 * the scheduler in leaf R15). It never decides policy on its own: it applies the
 * R1 state matrix, the R6/R7 adapter capabilities, the R5 acceptance rules and
 * the R10 family ownership, and it refuses instead of guessing.
 *
 * Guarantees:
 * - **CAS + idempotency.** The caller passes the revision/state it saw and a
 *   client idempotency key. The claim `interrupted|unknown -> recovering` is a
 *   single store CAS (`transitionRun`) that also persists the key and its
 *   result on the run row, so a replay returns the stored result and never
 *   launches twice, even across a restart.
 * - **Per-logical-run exclusion.** The `recovering` state is the lock: a second
 *   resume loses the CAS and gets `already_recovering`.
 * - **Path by capability.** `reattach` only for a verifiably alive executor and
 *   a reattach-capable adapter; `new_turn_same_session` only for an adapter that
 *   resumes the persisted session; otherwise `unsupported`. A fresh session is
 *   never started silently, and a live executor is never given a second turn.
 * - **No replay.** The continuation prompt is the fixed neutral
 *   `RESUME_CONTINUATION_PROMPT`; the previous prompt/command is never re-sent.
 * - **Fencing.** The CAS binds a new attempt id as `activeAttemptId`;
 *   `checkRunFence` rejects any callback from an older attempt with
 *   `run_mismatch`. The adapter ack (`recordResumedAttemptAck`, run in
 *   `resumeRun` right after an accepted launch) and the terminal write
 *   (`finishResumedAttempt`) both pass the fence first, so a stale attempt can
 *   never mutate the run. The ack links the new adapter run id to the new
 *   attempt and moves the run `starting -> running`; resumed results report
 *   `fencing: 'enforced'` (adapter run id linked) or `'unlinked'` (the adapter
 *   returned no run id, so the run stays `starting`).
 * - **Lost claim.** If Stop/sweep took the claim after the executor already
 *   started, only the just-started adapter turn is cancelled (`cancelLaunched`, reason
 *   `claim_lost`); no durable run cancel is written, so a later resume stays
 *   possible unless a real Stop was recorded.
 * - **Reattach.** Without an injected `reattach` that really attaches, a live
 *   executor yields `reattach_deferred` and nothing is claimed or mutated.
 * - **Accounting (R1).** Resume touches neither failures/backoff nor the
 *   one-shot delegation `server_restart` retry (`interruptContinuedAt`); the
 *   interruption was already counted once when it was recorded.
 *
 * Scope: store-level plus injected collaborators. No timers, no `process.env`,
 * no runtime imports; the production wiring lives in the route layer.
 */

import { getRun, registerAttempt, transitionRun } from './recovery-store.ts';
import { finishRun } from './recovery-lifecycle.ts';
import { getRunWaiting, isRunCancelled } from './recovery-queue.ts';
import { createRecoveryIds, isRecoveryId } from './recovery-ids.ts';
import { RUN_ACTIVE_STATES } from './recovery-contract.ts';
import type { ThrownLike } from './recovery-types.ts';

/** Fixed neutral continuation prompt: never the previous prompt or command. */
export const RESUME_CONTINUATION_PROMPT = [
  'The server restarted or the previous turn was interrupted.',
  'Continue the work that was in progress.',
  'Before doing anything, verify the actual state first: check the workspace',
  'changes (git status/diff), running processes and files already written.',
  'Do not repeat steps that are already done and do not assume the last command',
  'completed or failed.',
].join(' ');

/** Result statuses `resumeRun` may return. */
export const RESUME_STATUSES = Object.freeze([
  'resumed',
  'invalid',
  'not_found',
  'conflict',
  'already_recovering',
  'not_resumable',
  'cancelled',
  'waiting',
  'stopping',
  'limit_blocked',
  'family_blocked',
  'liveness_unknown',
  'executor_alive',
  'unsupported',
  'launch_failed',
  'in_progress',
  'superseded',
  'reattach_deferred',
]);

/** Closed set of error codes that may reach a result/HTTP body (never raw messages). */
export const RESUME_ERROR_CODES = Object.freeze([
  'chat_not_found',
  'chat_archived',
  'adapter_unavailable',
  'prompt_required',
  'recipient_busy',
  'server_shutting_down',
  'update_in_progress',
  'attempt_write_failed',
]);

/**
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string} an allowlisted code, else `fallback`
 */
export function toSafeErrorCode(err: unknown, fallback: string = 'internal_error'): string {
  const code = text((err as ThrownLike)?.code);
  return RESUME_ERROR_CODES.includes(code) ? code : fallback;
}

/** Resume paths. */
export const RESUME_PATHS = Object.freeze(['reattach', 'new_turn_same_session', 'none']);

/** Max stored idempotency keys per run (oldest dropped). */
export const RESUME_MAX_STORED_KEYS = 20;

const KEY_MAX_LENGTH = 200;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Result body of a resume request. */
type ResumeResult = { status: string, path: string, attemptId: string, reason: string, logicalRunId: string, revision: number, replayed: boolean, fencing?: unknown, details?: Record<string, any> };

/**
 * @param {object} fields
 * @returns {object}
 */
function result(fields: Record<string, any>): ResumeResult {
  return {
    status: fields.status,
    path: fields.path || 'none',
    attemptId: fields.attemptId || '',
    reason: fields.reason || '',
    logicalRunId: fields.logicalRunId || '',
    revision: Number.isFinite(fields.revision) ? fields.revision : 0,
    replayed: fields.replayed === true,
    ...(fields.fencing ? { fencing: fields.fencing } : {}),
    ...(fields.details ? { details: fields.details } : {}),
  };
}

/**
 * Fence for callbacks/events of an older attempt. Pure read.
 *
 * @param {{ logicalRunId: string, attemptId: string }} input
 * @param {object} [store]
 * @returns {{ ok: boolean, code: string, activeAttemptId: string }}
 */
export function checkRunFence(input: { logicalRunId: string, attemptId: string }, store?: Record<string, any>): { ok: boolean, code: string, activeAttemptId: string } {
  const logicalRunId = text(input?.logicalRunId);
  const attemptId = text(input?.attemptId);
  const run = logicalRunId ? getRun(logicalRunId, store) : null;
  if (!run) return { ok: false, code: 'run_mismatch', activeAttemptId: '' };
  const active = text(run.activeAttemptId) || text(run.attemptId);
  if (!attemptId || attemptId !== active) {
    return { ok: false, code: 'run_mismatch', activeAttemptId: active };
  }
  return { ok: true, code: 'ok', activeAttemptId: active };
}

/**
 * Adapter ack for a resumed attempt: fence first, then link the new adapter run
 * id to the attempt and move the run `starting -> running`. A stale fence
 * (another attempt/owner) is rejected and the run is left untouched.
 *
 * @param {{ logicalRunId: string, attemptId: string, adapterRunId: string, now?: number }} input
 * @param {object} [store]
 * @returns {{ applied: boolean, reason: string, run?: object }}
 */
export function recordResumedAttemptAck(input: { logicalRunId: string, attemptId: string, adapterRunId: string, now?: number }, store?: Record<string, any>): { applied: boolean, reason: string, run?: Record<string, any> | null } {
  const fence = checkRunFence(input, store);
  if (!fence.ok) return { applied: false, reason: fence.code };
  const adapterRunId = text(input?.adapterRunId);
  if (!adapterRunId) return { applied: false, reason: 'adapter_run_id_missing' };
  const run = getRun(text(input.logicalRunId), store);
  if (!run || run.state !== 'starting') return { applied: false, reason: 'state_not_starting', run: run || undefined };
  const moved = transitionRun(
    {
      logicalRunId: run.logicalRunId,
      expectedRevision: run.revision,
      expectedState: 'starting',
      to: 'running',
      infraOutcome: 'accepted',
      now: input.now,
      patch: {
        acceptance: {
          state: 'accepted',
          source: 'adapter_ack',
          adapterRunId,
          attemptId: text(input.attemptId),
          ackedAt: input.now ?? Date.now(),
        },
      },
    },
    store
  );
  return { applied: moved.applied === true, reason: moved.applied ? 'applied' : text(moved.reason) || 'conflict', run: moved.run };
}

/**
 * Terminal write for a resumed attempt, behind the same fence as the ack. Kept
 * as the fenced finish for adapters that report terminal state through the
 * recovery layer with an attempt id; the production chat path does not call it
 * (`noteChatRunFinished` matches by chat id + adapter run id instead).
 *
 * @param {{ logicalRunId: string, attemptId: string, to: string, infraOutcome?: string, reason?: string, proof: object }} input
 * @param {object} [store]
 * @returns {{ applied: boolean, reason: string }}
 */
export function finishResumedAttempt(input: { logicalRunId: string, attemptId: string, to: string, infraOutcome?: string, reason?: string, proof: Record<string, any> }, store?: Record<string, any>): { applied: boolean, reason: string } {
  const fence = checkRunFence(input, store);
  if (!fence.ok) return { applied: false, reason: fence.code };
  const run = getRun(text(input.logicalRunId), store) as Record<string, any>;
  const outcome = finishRun(
    {
      logicalRunId: run.logicalRunId,
      expectedRevision: run.revision,
      to: input.to,
      infraOutcome: input.infraOutcome || input.to,
      reason: input.reason,
      proof: input.proof,
    },
    store
  );
  return { applied: outcome.applied === true, reason: outcome.applied ? 'applied' : text(outcome.reason) || 'conflict' };
}

/**
 * @param {object} run
 * @param {string} key
 * @param {object} value
 * @returns {Record<string, object>}
 */
function withStoredResult(run: Record<string, any>, key: string, value: Record<string, any>): Record<string, Record<string, any>> {
  const previous: Record<string, any> = run.resumeRequests && typeof run.resumeRequests === 'object' ? run.resumeRequests : {};
  const entries = Object.entries(previous).filter(([k]) => k !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries.slice(-RESUME_MAX_STORED_KEYS)) as Record<string, Record<string, any>>;
}

/**
 * @param {{
 *   store?: object,
 *   now?: () => number,
 *   uuid?: () => string,
 *   probeLiveness?: (input: { run: object }) => ('alive'|'dead'|'unknown'),
 *   getCapabilities?: (harness: string) => { canReattach?: boolean, canResumeSession?: boolean, transcriptLost?: boolean },
 *   checkLimits?: (input: { run: object, actor: string }) => { allowed: boolean, reason?: string },
 *   authorizeFamily?: (input: { run: object, actor: string }) => { allowed: boolean, reason?: string },
 *   isRunStopping?: (input: { run: object }) => boolean,
 *   getCurrentSessionId?: (input: { run: object }) => string,
 *   cancelLaunched?: (input: { run: object, attemptId: string, adapterRunId: string }) => Promise<unknown>,
 *   isAdapterValidated?: (harness: string) => boolean,
 *   reattach?: (input: { run: object, attemptId: string }) => Promise<{ accepted: boolean, adapterRunId?: string }>,
 *   startContinuation?: (input: { run: object, attemptId: string, requestId: string, prompt: string, sessionId: string }) => Promise<{ accepted: boolean, adapterRunId?: string }>,
 * }} deps
 */
export function createRecoveryResumeService(deps: { store?: Record<string, any>, now?: () => number, uuid?: () => string, probeLiveness?: (input: { run: Record<string, any> }) => ('alive'|'dead'|'unknown'), getCapabilities?: (harness: string) => { canReattach?: boolean, canResumeSession?: boolean, transcriptLost?: boolean }, checkLimits?: (input: { run: Record<string, any>, actor: string }) => { allowed: boolean, reason?: string }, isAdapterValidated?: (harness: string) => boolean, authorizeFamily?: (input: { run: Record<string, any>, actor: string }) => { allowed: boolean, reason?: string }, isRunStopping?: (input: { run: Record<string, any> }) => boolean, getCurrentSessionId?: (input: { run: Record<string, any> }) => string, cancelLaunched?: (input: { run: Record<string, any>, attemptId: string, adapterRunId: string, reason?: string }) => Promise<unknown>, reattach?: (input: { run: Record<string, any>, attemptId: string }) => Promise<{ accepted: boolean, adapterRunId?: string }>, startContinuation?: (input: { run: Record<string, any>, attemptId: string, requestId: string, prompt: string, sessionId: string }) => Promise<{ accepted: boolean, adapterRunId?: string }>, } = {}) {
  const store = deps.store;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const mintIds = () => createRecoveryIds({ uuid: typeof deps.uuid === 'function' ? deps.uuid() : undefined });
  const probeLiveness = deps.probeLiveness || (() => 'unknown');
  const getCapabilities = deps.getCapabilities || (() => ({} as { canReattach?: boolean, canResumeSession?: boolean, transcriptLost?: boolean }));
  const checkLimits = deps.checkLimits || (() => ({ allowed: true } as { allowed: boolean, reason?: string }));
  const isRunStopping = deps.isRunStopping || ((input: { run: Record<string, any> }) => Boolean(text(input.run?.runStoppingAt)));
  const authorizeFamily =
    deps.authorizeFamily ||
    ((input: { run: Record<string, any>, actor: string }) => (input.run?.family === 'chat'
      ? { allowed: true, reason: 'chat_family' }
      : { allowed: false, reason: 'family_owner_required' }));
  const inflight: Map<string, Promise<ResumeResult>> = new Map();

  /**
   * Run the pre-claim gates. Returns a refusal result or `null`.
   */
  function gate(run: Record<string, any>, input: Record<string, any>) {
    const logicalRunId = run.logicalRunId;
    const base = { logicalRunId, revision: run.revision };
    if (run.state === 'cancelled' || isRunCancelled(logicalRunId, store)) {
      return result({ ...base, status: 'cancelled', reason: 'user_stop' });
    }
    if (run.state === 'recovering') {
      return result({ ...base, status: 'already_recovering', reason: 'recovering', attemptId: text(run.activeAttemptId) });
    }
    if (run.state === 'waiting' || getRunWaiting(logicalRunId, store)) {
      return result({ ...base, status: 'waiting', reason: 'awaiting_human_answer' });
    }
    if (RUN_ACTIVE_STATES.includes(run.state) || run.state === 'completed') {
      return result({ ...base, status: 'not_resumable', reason: `state_${run.state}` });
    }
    if (input.expectedState !== run.state || input.expectedRevision !== run.revision) {
      return result({
        ...base,
        status: 'conflict',
        reason: input.expectedState !== run.state ? 'state_mismatch' : 'revision_conflict',
        details: { actualState: run.state, actualRevision: run.revision },
      });
    }
    if (run.state !== 'interrupted' && run.state !== 'unknown') {
      return result({ ...base, status: 'not_resumable', reason: `state_${run.state}` });
    }
    if (isRunStopping({ run })) {
      return result({ ...base, status: 'stopping', reason: 'run_stopping' });
    }
    const family = authorizeFamily({ run, actor: input.actor });
    if (!family.allowed) {
      return result({ ...base, status: 'family_blocked', reason: text(family.reason) || 'family_blocked' });
    }
    const limits = checkLimits({ run, actor: input.actor });
    if (!limits.allowed) {
      return result({ ...base, status: 'limit_blocked', reason: text(limits.reason) || 'limit_blocked' });
    }
    // Automatic actors are fail-closed on the per-adapter enable gate here too,
    // independent of whoever calls `resumeRun` (the scheduler pre-check is not
    // the only line of defence). A missing validator means "not validated".
    if (input.actor === 'automatic' && !(typeof deps.isAdapterValidated === 'function' && deps.isAdapterValidated(run.harness) === true)) {
      return result({ ...base, status: 'unsupported', reason: 'adapter_not_validated' });
    }
    return null;
  }

  /**
   * Choose the path. Returns `{ path }` or a refusal result.
   */
  function selectPath(run: Record<string, any>, input: Record<string, any>) {
    const base = { logicalRunId: run.logicalRunId, revision: run.revision };
    const liveness = probeLiveness({ run });
    const caps: { canReattach?: boolean, canResumeSession?: boolean, transcriptLost?: boolean } = getCapabilities(run.harness) || {};
    // `unknown` state or unknown liveness is only resumable on explicit human
    // confirmation: otherwise a still-running executor could get a second turn.
    if ((run.state === 'unknown' || liveness === 'unknown') && input.confirmUnknown !== true) {
      return { refusal: result({ ...base, status: 'liveness_unknown', reason: 'confirm_unknown_required' }) };
    }
    // Boot re-probes `unknown` on a bounded schedule; confirming before that
    // bound is spent could race a still-starting executor.
    const ev = run.bootEvidence;
    if (run.state === 'unknown' && ev && ev.state === 'unknown' && ev.escalated !== true) {
      return { refusal: result({ ...base, status: 'liveness_unknown', reason: 'reprobe_pending' }) };
    }
    if (liveness === 'alive') {
      if (caps.canReattach === true) {
        if (typeof deps.reattach !== 'function') {
          return { refusal: result({ ...base, status: 'reattach_deferred', reason: 'liveness_confirmed_only' }) };
        }
        return { path: 'reattach', caps };
      }
      return { refusal: result({ ...base, status: 'executor_alive', reason: 'reattach_unsupported' }) };
    }
    if (caps.canResumeSession === true && text(run.sessionId)) {
      // The continuation runs in the chat's CURRENT session; if that is not the
      // run's persisted session, refuse instead of silently using another one.
      if (typeof deps.getCurrentSessionId === 'function' && text(deps.getCurrentSessionId({ run })) !== text(run.sessionId)) {
        return { refusal: result({ ...base, status: 'unsupported', reason: 'session_changed' }) };
      }
      return { path: 'new_turn_same_session', caps };
    }
    return {
      refusal: result({
        ...base,
        status: 'unsupported',
        reason: text(run.sessionId) ? 'no_resume_capability' : 'no_persisted_session',
        details: { transcriptLost: caps.transcriptLost !== false },
      }),
    };
  }

  /**
   * Move `recovering` back to `interrupted` and record the final result.
   */
  function finishClaim(claimed: Record<string, any>, key: string, nextState: string, rawFinal: ResumeResult, patch: Record<string, any> = {}) {
    // The finishing CAS lands on claimed.revision + 1, so the stored result
    // already carries the revision a client must use for its next request.
    const final = { ...rawFinal, revision: claimed.revision + 1 };
    const moved = transitionRun(
      {
        logicalRunId: claimed.logicalRunId,
        expectedRevision: claimed.revision,
        expectedState: 'recovering',
        to: nextState,
        now: now(),
        patch: { ...patch, resumeRequests: withStoredResult(claimed, key, final) },
      },
      store
    );
    return { moved, final };
  }

  async function execute(input: Record<string, any>): Promise<ResumeResult> {
    const logicalRunId = text(input.logicalRunId);
    const key = text(input.idempotencyKey);
    const run = getRun(logicalRunId, store);
    if (!run || (text(input.chatId) && text(run.chatId) !== text(input.chatId))) {
      return result({ status: 'not_found', reason: 'run_not_found', logicalRunId });
    }
    const stored = run.resumeRequests?.[key];
    if (stored) {
      if (stored.status !== 'in_progress') return { ...stored, replayed: true };
      // A stored `in_progress` is only true while the claim is still held; after a
      // crash/Stop/sweep it must not be reported as a launch.
      if (run.state === 'recovering' && text(run.activeAttemptId) === text(stored.attemptId)) {
        return { ...stored, revision: run.revision, replayed: true };
      }
      return result({
        status: 'superseded', path: stored.path, attemptId: stored.attemptId,
        reason: 'claim_not_finished', logicalRunId, revision: run.revision, replayed: true,
      });
    }

    const refusal = gate(run, input);
    if (refusal) return refusal;
    const selected = selectPath(run, input);
    if (selected.refusal) return selected.refusal;
    const path = selected.path;

    const minted = mintIds();
    const attemptId = minted.attemptId;
    const requestId = minted.requestId;
    const pending = result({
      status: 'in_progress',
      path,
      attemptId,
      reason: 'launch_pending',
      logicalRunId,
      revision: run.revision + 1,
    });
    const claim = transitionRun(
      {
        logicalRunId,
        expectedRevision: run.revision,
        expectedState: run.state,
        to: 'recovering',
        now: now(),
        patch: {
          activeAttemptId: attemptId,
          previousAttemptId: text(run.activeAttemptId) || text(run.attemptId),
          recoveryPath: path,
          resumeClaimedAt: now(),
          resumeActor: text(input.actor),
          resumeRequests: withStoredResult(run, key, pending),
        },
      },
      store
    );
    if (!claim.applied) {
      const state = claim.run?.state;
      if (state === 'recovering') {
        return result({ status: 'already_recovering', reason: 'recovering', logicalRunId, revision: claim.run?.revision });
      }
      return result({ status: 'conflict', reason: text(claim.reason) || 'conflict', logicalRunId, revision: claim.run?.revision });
    }
    const claimed = claim.run as Record<string, any>;

    try {
      registerAttempt(
        { logicalRunId, attemptId, requestId, cause: 'manual_resume', now: now() },
        store
      );
    } catch {
      const failed = result({ status: 'launch_failed', path, attemptId, reason: 'attempt_write_failed', logicalRunId });
      return finishClaim(claimed, key, 'interrupted', failed, { resumeFailure: 'attempt_write_failed' }).final;
    }

    // Stop or a sweep may have landed between the claim and the launch.
    const fresh = getRun(logicalRunId, store);
    if (isRunCancelled(logicalRunId, store)) {
      const stopped = result({ status: 'cancelled', path, attemptId, reason: 'cancelled_during_resume', logicalRunId });
      return finishClaim(claimed, key, 'cancelled', stopped).final;
    }
    if (!fresh || fresh.state !== 'recovering' || text(fresh.activeAttemptId) !== attemptId) {
      return result({
        status: 'superseded', path, attemptId, reason: 'claim_lost_before_launch',
        logicalRunId, revision: fresh?.revision,
      });
    }

    let launch: { accepted: boolean, adapterRunId?: string, error?: string } | undefined;
    try {
      launch = path === 'reattach'
        ? await deps.reattach!({ run: claimed, attemptId })
        : await deps.startContinuation!({
          run: claimed,
          attemptId,
          requestId,
          prompt: RESUME_CONTINUATION_PROMPT,
          sessionId: text(claimed.sessionId),
        });
    } catch (err) {
      launch = { accepted: false, error: toSafeErrorCode(err, 'launch_failed') };
    }
    if (launch?.accepted !== true) {
      const failed = result({
        status: 'launch_failed',
        path,
        attemptId,
        reason: RESUME_ERROR_CODES.includes(text(launch?.error)) || text(launch?.error) === 'launch_failed'
          ? text(launch.error)
          : 'launch_not_accepted',
        logicalRunId,
      });
      // Back to `interrupted`: a launch that was not accepted must not leave the
      // run stuck in `recovering`, and must not be retried automatically.
      return finishClaim(claimed, key, 'interrupted', failed, { resumeFailure: failed.reason }).final;
    }
    const done = result({
      status: 'resumed',
      path,
      attemptId,
      reason: path === 'reattach' ? 'reattached' : 'new_turn_started',
      logicalRunId,
      fencing: text(launch.adapterRunId) ? 'enforced' : 'unlinked',
    });
    const finished = finishClaim(claimed, key, 'starting', done, {
      resumeLaunchedAt: now(),
      resumeAdapterRunId: text(launch.adapterRunId),
    });
    if (!finished.moved.applied) {
      // The executor was already started; the run moved underneath us (Stop/sweep).
      // Do not leave that turn running: stop just that turn.
      await cancelLostLaunch(claimed, attemptId, text(launch.adapterRunId));
      return result({
        status: 'superseded', path, attemptId, reason: 'claim_lost_after_launch',
        logicalRunId, revision: finished.moved.run?.revision,
      });
    }
    // Adapter ack: link the new adapter run to the new attempt (fenced).
    if (text(launch.adapterRunId)) {
      try {
        recordResumedAttemptAck({ logicalRunId, attemptId, adapterRunId: text(launch.adapterRunId), now: now() }, store);
      } catch { /* the run stays `starting`; boot reconciliation classifies it */ }
    }
    return finished.final;
  }

  /**
   * Best-effort cancel of ONLY the executor turn that was just launched. It
   * never writes a durable run cancel: a user Stop already recorded its own, and
   * a sweep/reconcile/other resumer must not be turned into a Stop that never
   * happened (that would block every later resume).
   */
  async function cancelLostLaunch(run: Record<string, any>, attemptId: string, adapterRunId: string) {
    if (typeof deps.cancelLaunched !== 'function') return;
    try {
      await deps.cancelLaunched({ run, attemptId, adapterRunId, reason: 'claim_lost' });
    } catch { /* never mask the superseded result */ }
  }

  /**
   * @param {{
   *   chatId?: string, logicalRunId: string, expectedState: string,
   *   expectedRevision: number, idempotencyKey: string, actor?: string,
   *   confirmUnknown?: boolean,
   * }} rawInput
   * @returns {Promise<{ status: string, path: string, attemptId: string, reason: string, logicalRunId: string, revision: number, replayed: boolean }>}
   */
  async function resumeRun(rawInput: { chatId?: string, logicalRunId: string, expectedState: string, expectedRevision: number, idempotencyKey: string, actor?: string, confirmUnknown?: boolean, }): Promise<{ status: string, path: string, attemptId: string, reason: string, logicalRunId: string, revision: number, replayed: boolean }> {
    const src: Record<string, any> = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const input = {
      chatId: text(src.chatId),
      logicalRunId: text(src.logicalRunId),
      expectedState: text(src.expectedState),
      expectedRevision: Math.floor(Number(src.expectedRevision)),
      idempotencyKey: text(src.idempotencyKey),
      actor: text(src.actor) || 'manual',
      confirmUnknown: src.confirmUnknown === true,
    };
    if (
      !isRecoveryId(input.logicalRunId, 'logical_run') ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > KEY_MAX_LENGTH ||
      !input.expectedState ||
      !Number.isFinite(input.expectedRevision) ||
      input.expectedRevision < 1
    ) {
      return result({ status: 'invalid', reason: 'invalid_resume_input', logicalRunId: input.logicalRunId });
    }
    const inflightKey = `${input.logicalRunId}\u0000${input.idempotencyKey}`;
    const existing = inflight.get(inflightKey);
    if (existing) return { ...(await existing), replayed: true };
    const promise = execute(input).finally(() => inflight.delete(inflightKey));
    inflight.set(inflightKey, promise);
    return promise;
  }

  return { resumeRun };
}
