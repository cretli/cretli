/**
 * Regression: a codex + claude reviewer pair (Settings → Delegation → Review)
 * yields two independent base models for plan AND code reviews, even when the
 * claude pair is a measured high-infra candidate, and both pair members can be
 * started with the resulting pick_id (no executor_not_picked).
 */
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { selectModelPick } from '../lib/model-role-profiles.js';
import { classifyDelegationPickOrigin, persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { makeTempDir } from './helpers/temp-dir.js';

const harnesses = [
  { id: 'codex', enabled: true, ready: true, can_delegate: true },
  { id: 'claude', enabled: true, ready: true, can_delegate: true },
];
const item = (id) => ({ id, roles: ['review'], cost_tier: 2, quality_tier: 4, speed_tier: 3 });
const modelsByHarness = {
  codex: { favorites_configured: true, items: [item('gpt-6-luna')] },
  claude: { favorites_configured: true, items: [item('claude-sonnet-5-5')] },
};
const history = {
  prior: { infra_fail_rate: 0.02 },
  observed: {
    'codex/gpt-6-luna': { n: 30, pass_rate: 0.9, infra_fail_rate: 0.45, completion_rate: 0.95, median_min: 2, quality: 4 },
    'claude/claude-sonnet-5-5': { n: 565, pass_rate: 0.83, infra_fail_rate: 0.65, completion_rate: 0.95, median_min: 2, quality: 4 },
  },
};
const file = path.join(makeTempDir('pair-'), 'model-pick-decisions.json');

for (const subject of ['plan', 'code']) {
  const result = selectModelPick({
    role: 'review', reviewSubject: subject, count: 2, diverse: true, harnesses, modelsByHarness, history,
  });
  assert.deepEqual(result.picks.map((p) => p.harness).sort(), ['claude', 'codex'], `${subject}: two harnesses`);
  assert.equal(new Set(result.picks.map((p) => p.model)).size, 2, `${subject}: two base models`);
  assert.equal(result.rotation.high_infra_relaxed_harnesses, 1, `${subject}: relaxation reported`);

  const persisted = persistModelPickProposal({ chatId: 'chat-1', role: 'review', pickResult: result, file });
  for (const row of result.picks) {
    const linked = classifyDelegationPickOrigin({
      pickId: persisted.pickId, harness: row.harness, model: row.model,
      assignment: 'review', executionMode: 'agent', parentChatId: 'chat-1', file,
    });
    assert.equal(linked.linkStatus, 'linked', `${subject}: ${row.harness} start links to the pick`);
    assert.equal(linked.origin, 'auto');
  }
  // The independence requirement is not lowered: an unpicked executor is still refused.
  const foreign = classifyDelegationPickOrigin({
    pickId: persisted.pickId, harness: 'codex', model: 'other-model',
    assignment: 'review', executionMode: 'agent', parentChatId: 'chat-1', file,
  });
  assert.equal(foreign.originDetail, 'rejected-link');
}

removeIsolatedDataDir();
console.log('model-pick-review-pair-codex-claude: ok');
