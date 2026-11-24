/**
 * Runtime wiring for the fast restart (`lib/restart-fast.js` stays pure):
 * - `createFastRestartRunner` builds `ctx.runFastRestart` for the dev-actions route
 *   (live rooms + steer, Watcher pause, participant record in the recovery store);
 * - `planFastRestartContinuations` / `dispatchFastRestartContinuations` run at boot:
 *   plan gates every participant fail-closed (before the Watcher reconcile),
 *   dispatch sends the continuation turn once the runtime is up.
 *
 * Every collaborator is injectable so the module is unit-tested without a server.
 */
import {
  FAST_RESTART_NOTICE, runFastRestart, writeFastRestartParticipants, readFastRestartParticipants,
  setFastRestartParticipantState, clearFastRestartParticipants, RESTART_GRACE_DEFAULT_MS,
  readFastRestartPausedWorkspaces, markFastRestartWatchersResumed, extendFastRestartDispatchedHold,
} from './restart-fast.js';
import { listLiveChatRuns, steerLiveChatRun, startChatRun, probeChatRunLivenessAsync, getChatRunAdapterCapabilities } from './chat-run-service.js';
import { getRecoveryStoreDatabase, listRuns } from './recovery/recovery-store.ts';
import { loadSettings } from './persist/settings.js';
import { resolveChatRestartRecoveryMode } from './recovery/recovery-policy.ts';
import { isHarnessEnabled } from './harness-enabled.js';
import { getChatByIdAsync } from './persist/chats-persist.js';
import { loadWorkspaceWatchers } from './persist/workspace-watchers-persist.js';
import { applyWorkspaceWatcherPatch } from './workspace-watcher-control.js';

export const FAST_RESTART_CONTINUATION_PROMPT = 'Cretli restarted. Continue from the note you wrote before the restart; '
  + 'do not redo work that is already on disk.';

/** Harnesses whose live rooms can be steered and resumed in the same model session. */
const FAST_RESTART_HARNESSES = new Set(['claude', 'codex']);

/** @returns {any} */
function defaultDb() { return getRecoveryStoreDatabase(); }

/**
 * @param {{ dataDir: string, deps?: Record<string, any> }} input
 * @returns {(request: { trigger: () => void }) => Promise<object>}
 */
export function createFastRestartRunner({ dataDir, deps = {} }) {
  const live = deps.listLive || listLiveChatRuns;
  const steer = deps.steer || steerLiveChatRun;
  const readSettings = deps.loadSettings || loadSettings;
  const getDb = deps.getDb || defaultDb;
  const listWatchers = deps.loadWatchers || ((opts) => loadWorkspaceWatchers(opts));
  const patchWatcher = deps.patchWatcher || applyWorkspaceWatcherPatch;
  const run = deps.runFastRestart || runFastRestart;
  return async function runFast({ trigger }) {
    const settings = readSettings();
    const graceMs = settings && settings.restartGraceMs !== undefined ? settings.restartGraceMs : RESTART_GRACE_DEFAULT_MS;
    /** @type {string[]} */
    const pausedByUs = [];
    const enabledRows = () => (listWatchers({ dataDir }) || []).filter((row) => row && row.enabled !== false && row.mode !== 'off');
    const resumeOurs = () => {
      for (const folder of pausedByUs.splice(0)) {
        try { patchWatcher({ dataDir, workspaceFolder: folder, patch: { paused: false } }); } catch { /* best effort */ }
      }
    };
    try {
    return await run({
      graceMs,
      now: deps.now,
      sleep: deps.sleep,
      pollMs: deps.pollMs,
      listAgents: () => live()
        .filter((r) => FAST_RESTART_HARNESSES.has(r.transport))
        .map((r) => ({ chatId: r.chatId, harness: r.transport, sessionId: r.sessionId, busy: r.busy, canSteer: r.canSteer })),
      steer: (agent, notice) => steer({ transport: agent.harness, chatId: agent.chatId, text: notice }),
      // The agent's note lives in its own session; the continuation prompt points at it.
      readNote: () => '',
      getWatcherPaused: () => enabledRows().every((row) => row.paused === true),
      setWatcherPaused: (paused) => {
        for (const row of enabledRows()) {
          if (paused && row.paused !== true) {
            patchWatcher({ dataDir, workspaceFolder: row.workspaceFolder, patch: { paused: true } });
            pausedByUs.push(String(row.workspaceFolder));
          }
        }
      },
      writeRecord: ({ participants, previouslyPaused }) => {
        writeFastRestartParticipants(getDb(), { participants, previouslyPaused, pausedWorkspaces: pausedByUs });
      },
      triggerRestart: trigger,
    });
    } catch (err) {
      // The restart never happened: do not leave the Watchers this run paused stuck on pause.
      resumeOurs();
      throw err;
    }
  };
}

/**
 * Gate every pending participant (fail closed). Ineligible ones are marked `failed`
 * immediately; the returned eligible list is dispatched later by
 * `dispatchFastRestartContinuations`. Never throws.
 *
 * @param {{ deps?: Record<string, any> }} [input]
 * @returns {Promise<{ eligible: Array<Record<string, any>>, skipped: Array<{ chatId: string, reason: string }> }>}
 */
export async function planFastRestartContinuations({ deps = {} } = {}) {
  const getDb = deps.getDb || defaultDb;
  const out = { eligible: [], skipped: [] };
  let db;
  let record;
  try {
    db = getDb();
    record = readFastRestartParticipants(db);
  } catch { return out; }
  if (!record) return out;
  const settings = (deps.loadSettings || loadSettings)() || {};
  const getChat = deps.getChat || getChatByIdAsync;
  const caps = deps.getCapabilities || getChatRunAdapterCapabilities;
  const runsFor = deps.listRunsForChat || ((chatId) => listRuns({ chatIds: [chatId], order: 'desc', limit: 1 }));
  const skip = (p, reason) => {
    out.skipped.push({ chatId: p.chatId, reason });
    try { setFastRestartParticipantState(db, p.chatId, 'failed'); } catch { /* record stays pending until TTL */ }
  };
  for (const p of record.participants) {
    if (p.state !== 'pending') continue;
    try {
      const chat = await getChat(p.chatId);
      if (!chat) { skip(p, 'chat_not_found'); continue; }
      // `off` always wins; `manual` is overridden by the confirmed fast restart itself.
      if (resolveChatRestartRecoveryMode(settings, chat.workspaceFolder || chat.workspace || '') === 'off') { skip(p, 'recovery_mode_off'); continue; }
      if (!FAST_RESTART_HARNESSES.has(p.harness) || !isHarnessEnabled(p.harness, settings.enabledHarnesses)) { skip(p, 'harness_unsupported'); continue; }
      if (!caps(p.harness).canResumeSession) { skip(p, 'resume_unsupported'); continue; }
      const sessionId = String(chat.cursorSessionId || '').trim();
      if (!sessionId || sessionId !== p.sessionId) { skip(p, 'session_mismatch'); continue; }
      const last = runsFor(p.chatId)[0];
      if (!last) { skip(p, 'no_run_record'); continue; }
      if (last.family !== 'chat') { skip(p, 'family_blocked'); continue; }
      if (last.runStoppingAt || last.keptStopped === true || last.state === 'cancelled') { skip(p, 'stopped'); continue; }
      if (last.state === 'waiting') { skip(p, 'waiting'); continue; }
      if (last.state === 'completed') { skip(p, 'already_completed'); continue; }
      out.eligible.push(p);
    } catch (err) {
      skip(p, String(err && err.code || 'gate_error'));
    }
  }
  return out;
}

/**
 * Send the continuation turn to every eligible participant, then resume the
 * Watchers this restart paused and clear the record. A failure marks only that
 * participant `failed`; it never throws.
 *
 * @param {{ eligible: Array<Record<string, any>>, dataDir: string, deps?: Record<string, any> }} input
 */
export async function dispatchFastRestartContinuations({ eligible, dataDir, deps = {} }) {
  const getDb = deps.getDb || defaultDb;
  const start = deps.startChatRun || startChatRun;
  const probe = deps.probeLiveness || probeChatRunLivenessAsync;
  const patchWatcher = deps.patchWatcher || applyWorkspaceWatcherPatch;
  let db;
  try { db = getDb(); } catch { return { dispatched: 0, failed: 0 }; }
  let dispatched = 0;
  let failed = 0;
  for (const p of eligible) {
    try {
      const live = await probe({ chatId: p.chatId });
      // A busy room means someone already continued the chat: never run two turns.
      if (live.busy) { setFastRestartParticipantState(db, p.chatId, 'failed'); failed += 1; continue; }
      setFastRestartParticipantState(db, p.chatId, 'dispatched');
      const started = await start({
        chatId: p.chatId,
        prompt: FAST_RESTART_CONTINUATION_PROMPT,
        requestId: `fast-restart-continuation:${p.chatId}:${p.sessionId}`,
      });
      if (started && started.accepted === false) throw new Error('not_accepted');
      // Stays `dispatched`: the Watcher keeps the leaf held while this chat is live
      // (see the restart_interrupted_worktree guard); the record is not cleared here.
      dispatched += 1;
    } catch {
      try { setFastRestartParticipantState(db, p.chatId, 'failed'); } catch { /* best effort */ }
      failed += 1;
    }
  }
  // Refresh the guard for as long as a dispatched continuation may run, whatever the Watchers' pause state was.
  if (dispatched > 0) { try { extendFastRestartDispatchedHold(db); } catch { /* guard keeps the original TTL */ } }
  resumeFastRestartWatchers({ dataDir, deps: { getDb: () => db, patchWatcher } });
  return { dispatched, failed };
}

/**
 * Resume the Watchers a fast restart paused. Runs at EVERY boot, also with zero
 * eligible participants, a failed plan or an expired/unusable record (TTL is
 * ignored on purpose), so autopilot is never left paused by this feature.
 * Idempotent: the record forgets the workspaces afterwards.
 *
 * @param {{ dataDir: string, deps?: Record<string, any> }} input
 * @returns {{ resumed: string[] }}
 */
export function resumeFastRestartWatchers({ dataDir, deps = {} }) {
  const getDb = deps.getDb || defaultDb;
  const patchWatcher = deps.patchWatcher || applyWorkspaceWatcherPatch;
  const resumed = [];
  try {
    const db = getDb();
    const folders = readFastRestartPausedWorkspaces(db);
    for (const folder of folders) {
      try { patchWatcher({ dataDir, workspaceFolder: folder, patch: { paused: false } }); resumed.push(folder); } catch { /* best effort */ }
    }
    if (readFastRestartParticipants(db) === null) {
      // Expired (or unusable) record: nobody will run its continuations, so drop it.
      // Its expiry is never extended, so it cannot hold a leaf again.
      clearFastRestartParticipants(db, { force: true });
    } else if (folders.length) {
      markFastRestartWatchersResumed(db);
      // Nothing left to hold: drop a record without pending/dispatched participants.
      clearFastRestartParticipants(db);
    }
  } catch { /* store unavailable: nothing to resume */ }
  return { resumed };
}

export { FAST_RESTART_NOTICE };
