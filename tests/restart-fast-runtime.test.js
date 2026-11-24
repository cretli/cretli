import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createFastRestartRunner, planFastRestartContinuations, dispatchFastRestartContinuations, resumeFastRestartWatchers,
} from '../lib/restart-fast-runtime.js';
import {
  dispatchedFastRestartChatIds, writeFastRestartParticipants, readFastRestartParticipants, pendingFastRestartChatIds,
} from '../lib/restart-fast.js';
import { requestServerRestart } from '../lib/routes/dev-actions-routes.js';

function newDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE recovery_meta(key TEXT PRIMARY KEY, value TEXT)');
  return db;
}
const participant = (chatId, extra = {}) => ({ chatId, harness: 'claude', sessionId: `s-${chatId}`, unfinished: true, ...extra });
const goodDeps = (db, over = {}) => ({
  getDb: () => db,
  loadSettings: () => ({ chatRestartRecoveryMode: 'manual' }),
  getChat: async (id) => ({ id, cursorSessionId: `s-${id}`, workspaceFolder: '/w' }),
  getCapabilities: () => ({ canResumeSession: true }),
  listRunsForChat: () => [{ family: 'chat', state: 'interrupted' }],
  ...over,
});

// Runner: pauses only unpaused watchers, steers only claude/codex, writes the record, then triggers.
{
  const db = newDb();
  const calls = [];
  let clock = 0;
  const runner = createFastRestartRunner({
    dataDir: '/d',
    deps: {
      getDb: () => db,
      loadSettings: () => ({ restartGraceMs: 20000 }),
      listLive: () => [
        { transport: 'claude', chatId: 'a', sessionId: 's-a', busy: true, canSteer: true },
        { transport: 'opencode', chatId: 'x', sessionId: 's-x', busy: true, canSteer: true },
      ],
      now: () => clock, sleep: async (ms) => { clock += ms; },
      steer: async () => calls.push('steer'),
      loadWatchers: () => [{ workspaceFolder: '/w1', enabled: true, mode: 'autopilot', paused: false }, { workspaceFolder: '/w2', enabled: true, mode: 'autopilot', paused: true }],
      patchWatcher: ({ workspaceFolder, patch }) => calls.push(`patch:${workspaceFolder}:${patch.paused}`),
    },
  });
  await runner({ trigger: () => calls.push('trigger') });
  assert.deepEqual(calls, ['patch:/w1:true', 'steer', 'trigger']);
  const record = readFastRestartParticipants(db);
  assert.deepEqual(record.pausedWorkspaces, ['/w1']);
  assert.deepEqual(record.participants.map((p) => p.chatId), ['a']);
}

// Plan: eligible participant passes; each gate fails closed.
{
  const db = newDb();
  writeFastRestartParticipants(db, { participants: [participant('ok'), participant('nosess'), participant('off'), participant('codexless', { harness: 'opencode' }), participant('stopped'), participant('waiting'), participant('fam'), participant('nocaps'), participant('done')] });
  const plan = await planFastRestartContinuations({ deps: goodDeps(db, {
    loadSettings: () => ({ chatRestartRecoveryMode: 'manual', chatRestartRecoveryWorkspaces: {} }),
    getChat: async (id) => ({ id, cursorSessionId: id === 'nosess' ? 'other' : `s-${id}`, workspaceFolder: id === 'off' ? '/off' : '/w' }),
    getCapabilities: (h) => ({ canResumeSession: h !== 'x' }),
    listRunsForChat: (id) => [{
      family: id === 'fam' ? 'delegation' : 'chat',
      state: id === 'waiting' ? 'waiting' : id === 'done' ? 'completed' : id === 'stopped' ? 'cancelled' : 'interrupted',
    }],
  }) });
  assert.deepEqual(plan.eligible.map((p) => p.chatId).sort(), ['nocaps', 'off', 'ok']);
}
// `off` wins even over the confirmed fast restart; unsupported harness skipped.
{
  const db = newDb();
  writeFastRestartParticipants(db, { participants: [participant('a'), participant('b', { harness: 'opencode' })] });
  const plan = await planFastRestartContinuations({ deps: goodDeps(db, { loadSettings: () => ({ chatRestartRecoveryMode: 'off' }) }) });
  assert.equal(plan.eligible.length, 0);
  assert.deepEqual(plan.skipped.map((s) => s.reason), ['recovery_mode_off', 'recovery_mode_off']);
  assert.equal(pendingFastRestartChatIds(db).size, 0);
}
{
  const db = newDb();
  writeFastRestartParticipants(db, { participants: [participant('b', { harness: 'opencode' })] });
  const plan = await planFastRestartContinuations({ deps: goodDeps(db) });
  assert.equal(plan.skipped[0].reason, 'harness_unsupported');
}
// No record / broken store: empty plan, never throws.
assert.deepEqual((await planFastRestartContinuations({ deps: { getDb: () => { throw new Error('x'); } } })).eligible, []);

// Dispatch: continues idle chats, skips busy, marks states, resumes only our paused watchers, clears record.
{
  const db = newDb();
  writeFastRestartParticipants(db, { pausedWorkspaces: ['/w1'], participants: [participant('a'), participant('b'), participant('c')] });
  const started = [];
  const patched = [];
  const result = await dispatchFastRestartContinuations({
    eligible: readFastRestartParticipants(db).participants,
    dataDir: '/d',
    deps: {
      getDb: () => db,
      probeLiveness: async ({ chatId }) => ({ busy: chatId === 'b' }),
      startChatRun: async ({ chatId, prompt }) => { if (chatId === 'c') throw new Error('boom'); started.push([chatId, prompt]); return { accepted: true }; },
      patchWatcher: (input) => patched.push(`${input.workspaceFolder}:${input.patch.paused}`),
    },
  });
  assert.deepEqual(result, { dispatched: 1, failed: 2 });
  assert.deepEqual(started.map((s) => s[0]), ['a']);
  assert.match(started[0][1], /Cretli restarted/);
  assert.deepEqual(patched, ['/w1:false']);
  // The dispatched participant keeps its hold; the record is not cleared (F2).
  assert.deepEqual([...dispatchedFastRestartChatIds(db)], ['a']);
  assert.deepEqual(readFastRestartParticipants(db).pausedWorkspaces, []);
}

// No eligible participant (F1): boot dispatch still resumes the Watchers this restart paused, even from an expired record.
{
  const db = newDb();
  writeFastRestartParticipants(db, { pausedWorkspaces: ['/w1', '/w2'], participants: [participant('a')] }, { now: 0 });
  const patched = [];
  const result = await dispatchFastRestartContinuations({ eligible: [], dataDir: '/d', deps: { getDb: () => db, patchWatcher: (i) => patched.push(`${i.workspaceFolder}:${i.patch.paused}`) } });
  assert.deepEqual(result, { dispatched: 0, failed: 0 });
  assert.deepEqual(patched, ['/w1:false', '/w2:false']);
  assert.deepEqual(resumeFastRestartWatchers({ dataDir: '/d', deps: { getDb: () => db, patchWatcher: () => { throw new Error('x'); } } }), { resumed: [] }, 'idempotent');
}

// F2: the guard is refreshed on dispatch even when the Watchers were already paused (empty pausedWorkspaces).
{
  const db = newDb();
  const t0 = Date.now();
  writeFastRestartParticipants(db, { pausedWorkspaces: [], participants: [participant('a')] });
  await dispatchFastRestartContinuations({
    eligible: readFastRestartParticipants(db).participants, dataDir: '/d',
    deps: { getDb: () => db, probeLiveness: async () => ({ busy: false }), startChatRun: async () => ({ accepted: true }), patchWatcher: () => {} },
  });
  const record = readFastRestartParticipants(db);
  assert.ok(Date.parse(record.expiresAt) > t0 + 60 * 60 * 1000, 'dispatched hold outlives the 15 min TTL');
  assert.ok(dispatchedFastRestartChatIds(db, { now: t0 + 30 * 60 * 1000 }).has('a'), 'still held 30 min later');
}

// REG-1: an expired record is cleaned up (Watchers resumed, record cleared) and never revived.
{
  const db = newDb();
  writeFastRestartParticipants(db, { pausedWorkspaces: ['/w1'], participants: [participant('a')] }, { now: 0 });
  const patched = [];
  await dispatchFastRestartContinuations({ eligible: [], dataDir: '/d', deps: { getDb: () => db, patchWatcher: (i) => patched.push(i.workspaceFolder) } });
  assert.deepEqual(patched, ['/w1']);
  assert.equal(readFastRestartParticipants(db, { now: 1 }), null);
  assert.equal(db.prepare("SELECT 1 FROM recovery_meta WHERE key = 'fastRestartParticipants'").get(), undefined, 'record deleted');
  assert.equal(pendingFastRestartChatIds(db).size, 0, 'the hold does not respawn');
}

// Runner failure before the restart (F1): paused Watchers are un-paused again.
{
  const calls = [];
  const runner = createFastRestartRunner({
    dataDir: '/d',
    deps: {
      getDb: () => newDb(), loadSettings: () => ({}),
      loadWatchers: () => [{ workspaceFolder: '/w1', enabled: true, mode: 'autopilot', paused: false }],
      patchWatcher: ({ workspaceFolder, patch }) => calls.push(`${workspaceFolder}:${patch.paused}`),
      listLive: () => { throw new Error('boom'); },
    },
  });
  await assert.rejects(() => runner({ trigger: () => calls.push('trigger') }), /boom/);
  assert.deepEqual(calls, ['/w1:true', '/w1:false']);
}

// Restart gate: fast mode needs the orchestrator and bypasses the active-delegation gate.
{
  let scheduled = false;
  const ctx = { getServerRestartScheduled: () => scheduled, setServerRestartScheduled: (v) => { scheduled = v; }, projectRoot: '/p' };
  assert.equal(requestServerRestart(ctx, { action: 'restart-server', mode: 'fast' }).status, 501);
  assert.equal(requestServerRestart(ctx, { action: 'restart-server', mode: 'bogus' }).status, 400);
  const ok = requestServerRestart({ ...ctx, runFastRestart: async () => {} }, { action: 'restart-server', mode: 'fast' });
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'fast');
  assert.equal(scheduled, true);
}
console.log('restart-fast-runtime tests passed');
