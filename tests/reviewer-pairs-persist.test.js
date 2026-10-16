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
