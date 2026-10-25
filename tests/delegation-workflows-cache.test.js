import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolated data dir: must be set before the persist module resolves its path.
process.env.CRETLI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-wf-cache-'));
const {
  getDelegationWorkflow,
  getDelegationWorkflowsDataPath,
  getDelegationWorkflowsParseCount,
  loadDelegationWorkflows,
  resetDelegationWorkflowsCache,
  upsertDelegationWorkflow,
} = await import('../lib/persist/delegation-workflows-persist.js');
const { getPoolRoundMembershipReadCount } = await import('../lib/delegation-pool-round.js');

const file = getDelegationWorkflowsDataPath();
const poolRound = { key: 'k', mode: 'audit', started: ['a'], memberships: { a: 'member' } };

test('repeated loads without a write parse and normalize once', () => {
  assert.ok(file.includes('delegation-workflows.json'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.writeFileSync(file, JSON.stringify({ v: 1, items: [] }));
    resetDelegationWorkflowsCache();
    upsertDelegationWorkflow({ parentChatId: 'chat-cache-1', leafId: 'leaf', codeReviewPoolRound: poolRound });
    const parsesBefore = getDelegationWorkflowsParseCount();
    const readsBefore = getPoolRoundMembershipReadCount();
    let row = null;
    for (let i = 0; i < 25; i += 1) row = getDelegationWorkflow('chat-cache-1', 'leaf');
    for (let i = 0; i < 25; i += 1) loadDelegationWorkflows();
    assert.equal(getDelegationWorkflowsParseCount() - parsesBefore, 1);
    assert.equal(getPoolRoundMembershipReadCount() - readsBefore, 1);
    assert.deepEqual(row?.codeReviewPoolRound?.memberships, { a: 'member' });

    // Cached rows cannot be poisoned by callers.
    assert.throws(() => { row.role = 'x'; }, TypeError);
    assert.throws(() => { row.codeReviewPoolRound.memberships.a = 'learning'; }, TypeError);
    loadDelegationWorkflows().pop();
    assert.equal(getDelegationWorkflow('chat-cache-1', 'leaf')?.role, '');

    // A save invalidates the cache.
    upsertDelegationWorkflow({ parentChatId: 'chat-cache-1', leafId: 'leaf', role: 'review' });
    assert.equal(getDelegationWorkflow('chat-cache-1', 'leaf')?.role, 'review');
    const parsesAfterSave = getDelegationWorkflowsParseCount();
    getDelegationWorkflow('chat-cache-1', 'leaf');
    assert.equal(getDelegationWorkflowsParseCount(), parsesAfterSave);

    // An external rewrite (different size) is picked up via stat.
    fs.writeFileSync(file, JSON.stringify({ v: 1, items: [{ parentChatId: 'chat-cache-2', role: 'plan' }, { parentChatId: 'c3' }] }));
    assert.equal(getDelegationWorkflow('chat-cache-2', '')?.role, 'plan');
    assert.equal(getDelegationWorkflow('chat-cache-1', 'leaf'), null);
  } finally {
    if (backup) fs.writeFileSync(file, backup);
    else fs.rmSync(file, { force: true });
    resetDelegationWorkflowsCache();
  }
});
