import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  RESTART_GRACE_DEFAULT_MS, clampRestartGraceMs, normalizeRestartMode, validateRestartGraceMs,
  runFastRestart, writeFastRestartParticipants, readFastRestartParticipants,
  setFastRestartParticipantState, pendingFastRestartChatIds, clearFastRestartParticipants, dispatchedFastRestartChatIds,
} from '../lib/restart-fast.js';

assert.equal(normalizeRestartMode(undefined), 'drain');
assert.equal(normalizeRestartMode('fast'), 'fast');
assert.throws(() => normalizeRestartMode('nope'), RangeError);
assert.equal(RESTART_GRACE_DEFAULT_MS, 75000);
assert.equal(clampRestartGraceMs(1), 20000);
assert.equal(clampRestartGraceMs(9e9), 300000);
assert.equal(clampRestartGraceMs('x'), 75000);
assert.equal(validateRestartGraceMs(10).ok, false);
assert.equal(validateRestartGraceMs(60000).ok, true);

function harness({ agentsAt, steerFail = false, paused = false }) {
  let t = 0; const log = [];
  let polls = 0;
  return {
    log,
    deps: {
      graceMs: 30000, pollMs: 1000,
      now: () => t, sleep: async (ms) => { t += ms; },
      listAgents: () => agentsAt(polls++, t),
      steer: async (a) => { log.push(`steer:${a.chatId}`); if (steerFail) throw new Error('boom'); },
      readNote: (a) => `note-${a.chatId}`,
      getWatcherPaused: () => paused,
      setWatcherPaused: (p) => log.push(`paused:${p}`),
      writeRecord: (r) => log.push(`record:${r.participants.length}:${r.previouslyPaused}`),
      triggerRestart: () => log.push('restart'),
    },
  };
}
const busy = { chatId: 'a', harness: 'claude', busy: true, canSteer: true };

// Ends early when agents go idle; restart only after the record write.
{
  const h = harness({ agentsAt: (n) => [{ ...busy, busy: n < 2 }] });
  const r = await runFastRestart(h.deps);
  assert.equal(r.timedOut, false);
  assert.deepEqual(h.log.filter((l) => l !== 'steer:a' && !l.startsWith('paused')), ['record:1:false', 'restart']);
  assert.equal(r.participants[0].unfinished, false);
  assert.equal(r.participants[0].note, 'note-a');
}
// Runs to the limit when an agent stays busy.
{
  const h = harness({ agentsAt: () => [busy] });
  const r = await runFastRestart(h.deps);
  assert.equal(r.timedOut, true);
  assert.equal(r.participants[0].unfinished, true);
}
// No-steer agents are not waited on; steer errors do not abort.
{
  const h = harness({ agentsAt: () => [{ ...busy, canSteer: false }] });
  const r = await runFastRestart(h.deps);
  assert.equal(r.timedOut, false);
  const h2 = harness({ agentsAt: () => [busy], steerFail: true });
  const r2 = await runFastRestart(h2.deps);
  assert.equal(r2.steerErrors.length, 1);
  assert.ok(h2.log.includes('restart'));
}
// Previously paused watcher is recorded and not re-paused.
{
  const h = harness({ agentsAt: () => [], paused: true });
  const r = await runFastRestart(h.deps);
  assert.equal(r.previouslyPaused, true);
  assert.ok(!h.log.includes('paused:true'));
}

// Participant record lifecycle, independent of the restartIntent key.
{
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE recovery_meta(key TEXT PRIMARY KEY, value TEXT)');
  writeFastRestartParticipants(db, { previouslyPaused: false, participants: [{ chatId: 'a', unfinished: true }, { chatId: 'b' }] });
  db.prepare("INSERT OR REPLACE INTO recovery_meta(key, value) VALUES('restartIntent', '{}')").run();
  db.prepare("DELETE FROM recovery_meta WHERE key = 'restartIntent'").run();
  assert.equal(readFastRestartParticipants(db).participants.length, 2);
  assert.deepEqual([...pendingFastRestartChatIds(db)].sort(), ['a', 'b']);
  setFastRestartParticipantState(db, 'a', 'dispatched');
  assert.ok(!pendingFastRestartChatIds(db).has('a'), 'dispatched is held by liveness, not by the pending set');
  assert.ok(dispatchedFastRestartChatIds(db).has('a'));
  assert.equal(clearFastRestartParticipants(db), false);
  setFastRestartParticipantState(db, 'a', 'done');
  setFastRestartParticipantState(db, 'b', 'failed');
  assert.equal(pendingFastRestartChatIds(db).size, 0);
  assert.equal(clearFastRestartParticipants(db), true);
  assert.equal(readFastRestartParticipants(db), null);
  // TTL
  writeFastRestartParticipants(db, { participants: [{ chatId: 'a' }] }, { now: 0 });
  assert.equal(readFastRestartParticipants(db, { now: 1e12 }), null);
}
console.log('restart-fast tests passed');
