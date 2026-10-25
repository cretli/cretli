import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The data dir is resolved at import time, so set it before the dynamic import.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-'));
process.env.CRETLI_DATA_DIR = dataDir;
const { addReviewerPairMember, readReviewerPairMembers, removeReviewerPairMember } = await import('../lib/persist/reviewer-pairs-persist.js');

test('orchestrator pair is learned, kept, and an errored member is replaced', () => {
  assert.equal(addReviewerPairMember('p1', { harness: 'codex', model: 'a::effort=low' }), true);
  assert.equal(addReviewerPairMember('p1', { harness: 'codex', model: 'a' }), false);
  assert.equal(addReviewerPairMember('p1', { harness: 'claude', model: 'b' }), true);
  assert.equal(addReviewerPairMember('p1', { harness: 'qwen', model: 'c' }), false);
  assert.equal(readReviewerPairMembers('p1').length, 2);
  assert.equal(readReviewerPairMembers('p2').length, 0);
  const failed = [{ assignment: 'review', parentChatId: 'p1', status: 'failed', queuedAt: '2026-10-15T10:00:00Z', executor: { transport: 'claude', model: 'b' } }];
  assert.deepEqual(readReviewerPairMembers('p1', failed).map((m) => m.model), ['a::effort=low']);
  assert.equal(addReviewerPairMember('p1', { harness: 'qwen', model: 'c' }), true);
  const verdictFail = [{ assignment: 'review', parentChatId: 'p1', status: 'completed', verdict: 'FAIL', executor: { transport: 'qwen', model: 'c' } }];
  assert.equal(readReviewerPairMembers('p1', verdictFail).length, 2);
  assert.ok(fs.existsSync(path.join(dataDir, 'reviewer-pairs.json')));
});

test('a learned member can be rolled back (canonical alias included)', () => {
  assert.equal(addReviewerPairMember('p3', { harness: 'claude', model: 'sonnet' }, 'code'), true);
  assert.equal(readReviewerPairMembers('p3', [], 'code').length, 1);
  // The alias names the same member, so it is the one removed.
  assert.equal(removeReviewerPairMember('p3', { harness: 'claude', model: 'claude-sonnet-5-5' }, 'code'), true);
  assert.equal(readReviewerPairMembers('p3', [], 'code').length, 0);
  assert.equal(removeReviewerPairMember('p3', { harness: 'claude', model: 'sonnet' }, 'code'), false, 'already gone');
  // The legacy (no subject) partition rolls back too.
  assert.equal(addReviewerPairMember('p4', { harness: 'codex', model: 'x' }), true);
  assert.equal(removeReviewerPairMember('p4', { harness: 'codex', model: 'x::effort=low' }), true);
  assert.equal(readReviewerPairMembers('p4').length, 0);
});

test('a learned member that can no longer be started is evicted on read (with the predicate only)', () => {
  assert.equal(addReviewerPairMember('p5', { harness: 'codex', model: 'astra::effort=low' }, 'code'), true);
  assert.equal(addReviewerPairMember('p5', { harness: 'claude', model: 'opus' }, 'code'), true);
  const notAstra = (member) => member.harness !== 'codex';
  // Without the predicate nothing changes.
  assert.equal(readReviewerPairMembers('p5', [], 'code').length, 2);
  assert.deepEqual(
    readReviewerPairMembers('p5', [], 'code', { isMemberStartable: notAstra }).map((m) => m.model),
    ['opus'],
  );
  // The eviction is persisted.
  assert.deepEqual(readReviewerPairMembers('p5', [], 'code').map((m) => m.model), ['opus']);
});

test('a member with a review in flight, or just learned, is not evicted by configuration', () => {
  assert.equal(addReviewerPairMember('p6', { harness: 'codex', model: 'astra' }, 'code'), true);
  assert.equal(addReviewerPairMember('p6', { harness: 'claude', model: 'opus' }, 'code'), true);
  const notAstra = (member) => member.harness !== 'codex';
  const row = (status) => [{
    assignment: 'review', parentChatId: 'p6', reviewSubject: 'code', status,
    queuedAt: '2026-10-20T10:00:00Z', executor: { transport: 'codex', model: 'astra::effort=low' },
  }];
  for (const status of ['queued', 'starting', 'running', 'waiting_for_input', 'cancelling']) {
    assert.equal(readReviewerPairMembers('p6', row(status), 'code', { isMemberStartable: notAstra }).length, 2, status);
  }
  // A run of another subject does not protect it.
  const planRow = [{ ...row('running')[0], reviewSubject: 'plan' }];
  assert.equal(readReviewerPairMembers('p6', planRow, 'code', {
    isMemberStartable: notAstra,
    keepMember: { harness: 'codex', model: 'astra::effort=high' },
  }).length, 2, 'keepMember exempts the member the current start just learned');
  assert.deepEqual(
    readReviewerPairMembers('p6', row('completed'), 'code', { isMemberStartable: notAstra }).map((m) => m.model),
    ['opus'],
  );
});

test('a throwing predicate never evicts', () => {
  assert.equal(addReviewerPairMember('p7', { harness: 'codex', model: 'astra' }, 'code'), true);
  const boom = () => { throw new Error('settings unreadable'); };
  assert.equal(readReviewerPairMembers('p7', [], 'code', { isMemberStartable: boom }).length, 1);
});
