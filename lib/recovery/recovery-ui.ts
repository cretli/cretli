/**
 * UI-facing view of persisted recovery runs (leaf R13).
 *
 * Maps the recovery lifecycle states onto the status keys the sidebar and the
 * delegation views render (`chat.delegationStatus.*`), and implements the
 * "Keep stopped" decision. Because the decision is a persisted CAS transition
 * (`interrupted|unknown -> cancelled`), a reload or a second device reads the
 * same state from the store; no client-side flag is involved.
 */

import { getRun, listRuns, transitionRun } from './recovery-store.ts';

/** Lifecycle states the UI surfaces (everything else is not a recovery item). */
const UI_STATES = Object.freeze(['interrupted', 'recovering', 'unknown', 'waiting']);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * Status key + allowed actions for one run. Pure.
 *
 * - `interrupted` + `server_restart` reason -> `interrupted_restart`
 * - `interrupted` (other reason)            -> `interrupted`
 * - `recovering`                            -> `resuming`
 * - `waiting`                               -> `waiting` (no actions)
 * - `unknown`                               -> `unknown` (resume needs confirmation)
 *
 * @param {Record<string, any>} run
 * @returns {{ status: string, canResume: boolean, canKeepStopped: boolean, needsConfirm: boolean }}
 */
export function describeRecoveryRun(run: Record<string, any>): { status: string, canResume: boolean, canKeepStopped: boolean, needsConfirm: boolean } {
  const state = text(run?.state);
  const none = { status: '', canResume: false, canKeepStopped: false, needsConfirm: false };
  if (!UI_STATES.includes(state)) return none;
  if (state === 'recovering') return { ...none, status: 'resuming' };
  if (state === 'waiting') return { ...none, status: 'waiting' };
  if (state === 'unknown') {
    return { status: 'unknown', canResume: true, canKeepStopped: true, needsConfirm: true };
  }
  const restart = text(run?.reason) === 'server_restart';
  return {
    status: restart ? 'interrupted_restart' : 'interrupted',
    canResume: true,
    canKeepStopped: true,
    needsConfirm: false,
  };
}

/**
 * Secret-free projection of a run (never the prompt, session or request ids).
 *
 * @param {Record<string, any>} run
 * @returns {Record<string, any>}
 */
export function toRecoveryRunView(run: Record<string, any>): Record<string, any> {
  return {
    logicalRunId: text(run.logicalRunId),
    chatId: text(run.chatId),
    state: text(run.state),
    revision: Number(run.revision) || 0,
    reason: text(run.reason),
    keptStopped: run.keptStopped === true,
    updatedAt: run.updatedAt ?? null,
    ...describeRecoveryRun(run),
  };
}

/**
 * Recovery items of one chat that the UI should show.
 *
 * The chat filter runs in the store query, before the per-state cap: filtering
 * the first 500 global rows afterwards would hide a newer chat as soon as
 * enough unrelated runs exist.
 *
 * @param {string} chatId
 * @param {Record<string, any>} [store]
 * @returns {Record<string, any>[]}
 */
export function listChatRecoveryViews(chatId: string, store?: Record<string, any>): Record<string, any>[] {
  const id = text(chatId);
  if (!id) return [];
  return UI_STATES.flatMap((state) => listRuns({ state, chatIds: [id], limit: 500 }, store))
    .map(toRecoveryRunView);
}

/**
 * Persist "Keep stopped": `interrupted|unknown -> cancelled` via one store CAS.
 * Idempotent: an already cancelled run returns `ok` with `replayed: true`.
 *
 * @param {{ chatId: string, logicalRunId: string, expectedState?: string, expectedRevision?: number }} input
 * @param {Record<string, any>} [store]
 * @returns {{ status: 'kept_stopped'|'not_found'|'conflict'|'not_resumable', replayed?: boolean, revision?: number, state?: string }}
 */
export function keepRunStopped(input: { chatId: string, logicalRunId: string, expectedState?: string, expectedRevision?: number }, store?: Record<string, any>): { status: 'kept_stopped'|'not_found'|'conflict'|'not_resumable', replayed?: boolean, revision?: number, state?: string } {
  const run = getRun(text(input?.logicalRunId), store);
  if (!run || text(run.chatId) !== text(input?.chatId)) return { status: 'not_found' };
  if (run.state === 'cancelled' && run.keptStopped === true) {
    return { status: 'kept_stopped', replayed: true, revision: run.revision, state: run.state };
  }
  if (run.state !== 'interrupted' && run.state !== 'unknown') return { status: 'not_resumable', state: run.state };
  const expectedRevision = Number(input?.expectedRevision);
  if (!Number.isFinite(expectedRevision) || expectedRevision !== run.revision) {
    return { status: 'conflict', revision: run.revision, state: run.state };
  }
  const moved = transitionRun(
    {
      logicalRunId: run.logicalRunId,
      expectedRevision: run.revision,
      expectedState: run.state,
      to: 'cancelled',
      infraOutcome: 'cancelled',
      patch: { keptStopped: true },
    },
    store
  );
  if (!moved.ok) return { status: 'conflict', revision: moved.run?.revision, state: moved.run?.state };
  return { status: 'kept_stopped', revision: moved.run?.revision, state: moved.run?.state };
}
