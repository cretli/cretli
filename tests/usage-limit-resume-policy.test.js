import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideResumeAction,
  resolvePauseDueAt,
  resolvePauseJitterMs,
  selectResumeCandidates,
} from '../lib/usage-limit-resume-policy.js';

const RESET = Date.parse('2026-10-19T12:00:00Z');
const settings = {
  enabled: true, marginMs: 120_000, jitterMs: 90_000, maxChain: 2, maxPerTick: 3,
  catchUpMs: 900_000, allowPremium: false, resumeDelegations: true,
};
const rec = (over = {}) => ({
  id: 'pause:a', subjectType: 'chat', resetAt: new Date(RESET).toISOString(), resetSource: 'provider',
  chain: 0, state: 'armed', pausedAt: new Date(RESET - 60_000).toISOString(), ...over,
});
const dueAt = resolvePauseDueAt(rec(), settings);
const decide = (over = {}, now = dueAt) => decideResumeAction({
  record: rec(over.record), now, dueAt, settings: { ...settings, ...over.settings },
  costTier: 2, parentBusy: false, sessionResumable: true, lockout: null, ...over.input,
});

test('due instant is reset + margin + deterministic jitter', () => {
  assert.equal(resolvePauseDueAt(rec(), settings), dueAt);
  const jitter = resolvePauseJitterMs('pause:a', 90_000);
  assert.ok(jitter >= 0 && jitter < 90_000);
  assert.equal(dueAt, RESET + 120_000 + jitter);
  assert.equal(resolvePauseDueAt(rec(), { ...settings, jitterMs: 0 }), RESET + 120_000);
  assert.ok(Number.isNaN(resolvePauseDueAt(rec({ resetAt: 'nope' }), settings)));
});

test('candidates: only due armed, ordered by dueAt then pausedAt then id, optional cap', () => {
  const s = { ...settings, jitterMs: 0 };
  const records = [
    rec({ id: 'c', resetAt: new Date(RESET + 10_000).toISOString() }),
    rec({ id: 'b' }),
    rec({ id: 'a' }),
    rec({ id: 'late', resetAt: new Date(RESET + 3_600_000).toISOString() }),
    rec({ id: 'done', state: 'resumed' }),
  ];
  const now = RESET + 200_000;
  const all = selectResumeCandidates({ records, now, settings: s });
  assert.deepEqual(all.map((c) => c.record.id), ['a', 'b', 'c']);
  assert.equal(selectResumeCandidates({ records, now, settings: s, limit: 2 }).length, 2);
});

test('decision table: every branch', () => {
  assert.deepEqual(decide({ settings: { enabled: false } }), { action: 'skip', reason: 'disabled' });
  assert.deepEqual(decide({ record: { resetSource: 'fallback-ttl' } }), { action: 'block', reason: 'unconfirmed_reset' });
  assert.deepEqual(decide({}, dueAt - 1), { action: 'defer', reason: 'before_due' });
  assert.deepEqual(decide({ input: { subjectMissing: true } }), { action: 'block', reason: 'session_not_resumable' });
  assert.deepEqual(decide({ input: { subjectMoved: true } }), { action: 'cancel', reason: 'subject_moved' });
  assert.deepEqual(decide({ record: { chain: 2 } }), { action: 'block', reason: 'chain_exhausted' });
  assert.deepEqual(decide({ input: { costTier: 5 } }), { action: 'block', reason: 'premium_model' });
  assert.deepEqual(decide({ settings: { allowPremium: true }, input: { costTier: 5 } }).action, 'resume');
  assert.deepEqual(decide({}, dueAt + settings.catchUpMs + 1), { action: 'expire', reason: 'catch_up_window_missed' });
  assert.equal(decide({}, dueAt + settings.catchUpMs).action, 'resume');
  assert.deepEqual(decide({ input: { parentBusy: true } }), { action: 'defer', reason: 'parent_busy' });
  assert.deepEqual(decide({ input: { sessionResumable: false } }), { action: 'block', reason: 'session_not_resumable' });
  assert.deepEqual(
    decide({ record: { subjectType: 'delegation' }, settings: { resumeDelegations: false } }),
    { action: 'skip', reason: 'delegations_disabled' },
  );
  assert.deepEqual(decide({}), { action: 'resume', reason: 'due' });
});

test('empty or unknown cost tier counts as premium', () => {
  assert.equal(decide({ input: { costTier: undefined } }).reason, 'premium_model');
  assert.equal(decide({ input: { costTier: Number.NaN } }).reason, 'premium_model');
});

test('limit_active defers to the later reset plus margin and jitter', () => {
  const laterReset = dueAt + 300_000;
  const out = decide({ input: { lockout: { resetAt: new Date(laterReset).toISOString() } } });
  assert.equal(out.action, 'defer');
  assert.equal(out.reason, 'limit_active');
  assert.equal(out.deferUntil, laterReset + 120_000 + resolvePauseJitterMs('pause:a', 90_000));
});

test('limit_active expires when the deferral lands past the catch-up window', () => {
  const laterReset = dueAt + settings.catchUpMs + 60_000;
  assert.deepEqual(
    decide({ input: { lockout: { resetAt: new Date(laterReset).toISOString() } } }),
    { action: 'expire', reason: 'catch_up_window_missed' },
  );
});

test('an elapsed lockout row is ignored', () => {
  const out = decide({ input: { lockout: { resetAt: new Date(dueAt - 1000).toISOString() } } });
  assert.equal(out.action, 'resume');
});
