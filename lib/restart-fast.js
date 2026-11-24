/**
 * Fast restart orchestration: pause the Watcher, tell running agents about the
 * restart, wait a bounded grace window, persist a participant record and only
 * then trigger the supervised restart.
 *
 * The participant record lives under its own `recovery_meta` key so that
 * `writeRestartIntent` (rewritten at SIGTERM) and `consumeBootRestartIntent`
 * (deleted at boot) never touch it. Every dependency is injectable so the
 * orchestration is unit-tested without restarting a real server.
 */

export const RESTART_MODES = Object.freeze(['drain', 'fast']);
export const DEFAULT_RESTART_MODE = 'drain';
export const RESTART_GRACE_DEFAULT_MS = 75000;
export const RESTART_GRACE_MIN_MS = 20000;
export const RESTART_GRACE_MAX_MS = 300000;
export const FAST_RESTART_PARTICIPANTS_META_KEY = 'fastRestartParticipants';
export const FAST_RESTART_PARTICIPANTS_TTL_MS = 15 * 60 * 1000;
/** A dispatched continuation may run for hours; its leaf hold must outlive the 15 min record TTL. */
export const FAST_RESTART_CONTINUATION_HOLD_TTL_MS = 6 * 60 * 60 * 1000;
export const FAST_RESTART_PARTICIPANT_STATES = Object.freeze(['pending', 'dispatched', 'done', 'failed']);

export const FAST_RESTART_NOTICE = 'Cretli is about to restart. Finish your current step, do not start a new one, '
  + 'and write a short note about where you are.';

/** @param {unknown} value @returns {'drain' | 'fast'} */
export function normalizeRestartMode(value) {
  if (value === undefined || value === null || value === '') return 'drain';
  if (value === 'drain' || value === 'fast') return value;
  throw new RangeError(`mode must be one of: ${RESTART_MODES.join(', ')}`);
}

/**
 * Clamp the grace window; non-numeric input falls back to the default.
 * @param {unknown} value
 */
export function clampRestartGraceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return RESTART_GRACE_DEFAULT_MS;
  return Math.min(RESTART_GRACE_MAX_MS, Math.max(RESTART_GRACE_MIN_MS, Math.round(n)));
}

/**
 * Validate a settings value strictly (rejects out-of-range instead of clamping).
 * @param {unknown} value
 * @returns {{ ok: boolean, value?: number }}
 */
export function validateRestartGraceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < RESTART_GRACE_MIN_MS || n > RESTART_GRACE_MAX_MS) return { ok: false };
  return { ok: true, value: Math.round(n) };
}

function metaDb(store) {
  if (store && typeof store.prepare === 'function') return store;
  throw new TypeError('a recovery_meta database handle is required');
}

/**
 * Persist the participant record (INSERT OR REPLACE under its own key).
 * @param {object} db recovery store database
 * @param {{ participants: Array<Record<string, any>>, previouslyPaused: boolean, pausedWorkspaces?: string[], mode?: string }} input
 * @param {{ now?: number }} [opts]
 */
export function writeFastRestartParticipants(db, input, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const record = {
    schemaVersion: 1,
    writtenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FAST_RESTART_PARTICIPANTS_TTL_MS).toISOString(),
    previouslyPaused: input.previouslyPaused === true,
    // Workspaces this orchestration paused; resumed after the continuations are dispatched.
    pausedWorkspaces: Array.isArray(input.pausedWorkspaces) ? input.pausedWorkspaces.map(String) : [],
    participants: (input.participants || []).map((p) => ({
      chatId: String(p.chatId),
      harness: String(p.harness || ''),
      sessionId: String(p.sessionId || ''),
      note: String(p.note || '').slice(0, 2000),
      unfinished: p.unfinished === true,
      state: FAST_RESTART_PARTICIPANT_STATES.includes(p.state) ? p.state : 'pending',
    })),
  };
  metaDb(db).prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
    .run(FAST_RESTART_PARTICIPANTS_META_KEY, JSON.stringify(record));
  return record;
}

/**
 * Read the record; a malformed or expired one reads as null.
 * @returns {Record<string, any> | null}
 */
export function readFastRestartParticipants(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const row = metaDb(db).prepare('SELECT value FROM recovery_meta WHERE key = ?').get(FAST_RESTART_PARTICIPANTS_META_KEY);
  if (!row) return null;
  try {
    const record = JSON.parse(String(row.value));
    if (!record || !Array.isArray(record.participants)) return null;
    if (Date.parse(record.expiresAt) <= now) return null;
    return record;
  } catch {
    return null;
  }
}

/** Persist one participant's dispatch state (before/after a continuation). */
export function setFastRestartParticipantState(db, chatId, state, opts = {}) {
  if (!FAST_RESTART_PARTICIPANT_STATES.includes(state)) throw new RangeError('invalid participant state');
  const record = readFastRestartParticipants(db, opts);
  if (!record) return null;
  for (const p of record.participants) if (p.chatId === chatId) p.state = state;
  metaDb(db).prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
    .run(FAST_RESTART_PARTICIPANTS_META_KEY, JSON.stringify(record));
  return record;
}

/**
 * Chat ids with a continuation still pending (not yet started). The Watcher
 * reconcile must not requeue the leaf of such a run (single owner); a dispatched
 * one is held by `dispatchedFastRestartChatIds` plus a liveness probe.
 * @returns {Set<string>}
 */
export function pendingFastRestartChatIds(db, opts = {}) {
  const record = readFastRestartParticipants(db, opts);
  const out = new Set();
  if (!record) return out;
  for (const p of record.participants) {
    if (p.state === 'pending') out.add(p.chatId);
  }
  return out;
}

/** Delete the record once every participant is done/failed (or unconditionally with force). */
/** @param {any} db @param {{ force?: boolean, now?: number }} [opts] */
export function clearFastRestartParticipants(db, { force = false, now } = {}) {
  if (!force) {
    const record = readFastRestartParticipants(db, { now });
    if (record && record.participants.some((p) => p.state === 'pending' || p.state === 'dispatched')) return false;
  }
  metaDb(db).prepare('DELETE FROM recovery_meta WHERE key = ?').run(FAST_RESTART_PARTICIPANTS_META_KEY);
  return true;
}

/**
 * Run the fast-restart sequence.
 *
 * @param {{
 *   graceMs?: number,
 *   pollMs?: number,
 *   listAgents: () => Array<Record<string, any>> | Promise<Array<Record<string, any>>>,
 *   steer: (agent: Record<string, any>, notice: string) => Promise<void> | void,
 *   readNote?: (agent: Record<string, any>) => string | Promise<string>,
 *   getWatcherPaused: () => boolean | Promise<boolean>,
 *   setWatcherPaused: (paused: boolean) => void | Promise<void>,
 *   writeRecord: (input: { participants: object[], previouslyPaused: boolean, pausedWorkspaces?: string[] }) => void | Promise<void>,
 *   triggerRestart: () => void | Promise<void>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export async function runFastRestart(deps) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graceMs = clampRestartGraceMs(deps.graceMs);
  const pollMs = Math.max(1, Number(deps.pollMs) || 1000);

  const previouslyPaused = (await deps.getWatcherPaused()) === true;
  if (!previouslyPaused) await deps.setWatcherPaused(true);

  const startAgents = await deps.listAgents();
  const notified = new Set();
  const steerErrors = [];
  for (const agent of startAgents) {
    if (!agent.busy || !agent.canSteer) continue;
    try {
      await deps.steer(agent, FAST_RESTART_NOTICE);
      notified.add(agent.chatId);
    } catch (err) {
      // A steer failure must never abort the restart.
      steerErrors.push({ chatId: agent.chatId, error: String(err && err.message || err) });
    }
  }

  const deadline = now() + graceMs;
  let current = startAgents;
  let timedOut = false;
  for (;;) {
    // Only agents that received the notice are waited on; no-steer runs are not.
    const waiting = current.filter((a) => a.busy && notified.has(a.chatId));
    if (waiting.length === 0) break;
    if (now() >= deadline) { timedOut = true; break; }
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    current = await deps.listAgents();
  }

  const participants = [];
  for (const agent of current) {
    if (!agent.busy && !notified.has(agent.chatId)) continue;
    let note = '';
    if (deps.readNote) {
      try { note = String(await deps.readNote(agent) || ''); } catch { note = ''; }
    }
    participants.push({
      chatId: agent.chatId,
      harness: agent.harness,
      sessionId: agent.sessionId,
      note,
      unfinished: agent.busy === true,
      state: 'pending',
    });
  }

  // The record is written BEFORE the restart: shutdown phase 1 kills providers at once.
  await deps.writeRecord({ participants, previouslyPaused });
  await deps.triggerRestart();
  return { mode: 'fast', graceMs, timedOut, previouslyPaused, participants, steerErrors };
}

/**
 * Workspaces a fast restart paused, read WITHOUT the TTL check: the boot cleanup
 * must still resume them when the record expired or its participants are unusable.
 * @param {any} db
 * @returns {string[]}
 */
export function readFastRestartPausedWorkspaces(db) {
  try {
    const row = metaDb(db).prepare('SELECT value FROM recovery_meta WHERE key = ?').get(FAST_RESTART_PARTICIPANTS_META_KEY);
    if (!row) return [];
    const record = JSON.parse(String(row.value));
    return Array.isArray(record && record.pausedWorkspaces) ? record.pausedWorkspaces.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * After the Watchers were resumed: forget them (idempotent cleanup). Never touches
 * the expiry, so an old record cannot be revived by a cleanup pass.
 * @param {any} db
 */
export function markFastRestartWatchersResumed(db) {
  const row = metaDb(db).prepare('SELECT value FROM recovery_meta WHERE key = ?').get(FAST_RESTART_PARTICIPANTS_META_KEY);
  if (!row) return null;
  const record = JSON.parse(String(row.value));
  record.pausedWorkspaces = [];
  metaDb(db).prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
    .run(FAST_RESTART_PARTICIPANTS_META_KEY, JSON.stringify(record));
  return record;
}

/**
 * Push the expiry out so a `dispatched` hold outlives a long continuation run.
 * Only a LIVE (unexpired) record with at least one dispatched participant is
 * extended; an expired record is never revived.
 * @param {any} db
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {boolean} whether the hold was extended
 */
export function extendFastRestartDispatchedHold(db, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const record = readFastRestartParticipants(db, { now });
  if (!record || !record.participants.some((p) => p.state === 'dispatched')) return false;
  record.expiresAt = new Date(now + (opts.ttlMs || FAST_RESTART_CONTINUATION_HOLD_TTL_MS)).toISOString();
  metaDb(db).prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
    .run(FAST_RESTART_PARTICIPANTS_META_KEY, JSON.stringify(record));
  return true;
}

/** Chat ids whose continuation was dispatched; the hold lasts while that chat is live. */
export function dispatchedFastRestartChatIds(db, opts = {}) {
  const record = readFastRestartParticipants(db, opts);
  const out = new Set();
  if (record) for (const p of record.participants) if (p.state === 'dispatched') out.add(p.chatId);
  return out;
}
