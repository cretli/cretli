import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { requestDecision, DECISION_WAIT_MAX_MS } from '../lib/decisions/decision-request.js';
import { changeDecision, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { buildWorkspaceWatcherCyclePrompt } from '../lib/workspace-watcher-cycle.js';
import { buildScoutPrompt, buildScoutPromptForProfile } from '../lib/workspace-watcher-scout.js';

after(closeDecisionStores);
const input = { workspaceFolder: '/tmp/my-app', chatId: randomUUID(), title: 'Choose next step', idempotencyKey: 'question',
  options: [{ label: 'Retry', effect: 'Retry the task', risk: 'low', reversible: true }, { label: 'Defer', effect: 'Postpone the task' }],
  recommended: 'option_1', why: 'Retry can recover a temporary failure.' };

test('request is scoped, idempotent, classified by server and cannot resolve', async () => {
  const result = await requestDecision(dataDir, { ...input, optionId: 'option_1' });
  assert.equal(result.decision.status, 'pending');
  assert.equal(result.decision.options[0].risk, 'medium');
  assert.equal(result.decision.options[0].reversible, false);
  assert.equal(result.decision.otherOption.id, '__other__');
  assert.equal((await requestDecision(dataDir, input)).decision.id, result.decision.id);
  const raised = await requestDecision(dataDir, { ...input, idempotencyKey: 'higher-risk', options: input.options.map((o) => ({ ...o, risk: 'high' })) });
  assert.equal(raised.decision.options[0].risk, 'high');
  await assert.rejects(requestDecision(dataDir, { ...input, decisionId: result.decision.id, chatId: randomUUID() }), /outside/);
  await assert.rejects(requestDecision(dataDir, { ...input, decisionId: result.decision.id, workspaceFolder: '/tmp/other' }), /outside/);
  for (const kind of ['plan_approval', 'integration', 'policy_upgrade']) {
    await assert.rejects(requestDecision(dataDir, { ...input, kind, onTimeout: 'recommended' }), /Recommended timeout/);
  }
});

test('long-poll returns a decision, timeout and cancellation; MCP clamps wait under 25 seconds', async () => {
  const { decision } = await requestDecision(dataDir, { ...input, idempotencyKey: 'wait' });
  const waiting = requestDecision(dataDir, { ...input, decisionId: decision.id, waitMs: 2000 });
  await changeDecision(dataDir, decision.id, decision.revision, 'decided', { optionId: 'option_2' });
  assert.equal((await waiting).decision.optionId, 'option_2');
  const pending = await requestDecision(dataDir, { ...input, idempotencyKey: 'timeout', waitMs: 10 });
  assert.equal(pending.pending, true);
  const controller = new AbortController(); controller.abort();
  const start = Date.now();
  await requestDecision(dataDir, { ...input, decisionId: pending.decision.id, waitMs: 1e9 }, { signal: controller.signal });
  assert.ok(Date.now() - start < 1000);
  assert.ok(DECISION_WAIT_MAX_MS < 25_000);
  let captured;
  const handlers = createCretliMcpToolHandlers({ decisionRequest: async (args) => { captured = args; return pending; } },
    { workspaceFolder: input.workspaceFolder, chatId: input.chatId, mode: 'plan' });
  const result = await handlers.decision_request({ ...input, wait_ms: 1e9 });
  assert.ok(!result.isError);
  assert.equal(captured.waitMs, 24_000);
  assert.equal(handlers.decision_resolve, undefined);
});

test('Watcher and Scout prompts require options, recommendation and a one-sentence explanation', () => {
  for (const prompt of [buildWorkspaceWatcherCyclePrompt({ workspaceFolder: input.workspaceFolder, watcher: { policy: {} }, decision: {}, todo: {} }),
    buildScoutPrompt({ workspaceFolder: input.workspaceFolder }),
    buildScoutPromptForProfile({ id: 'test', revision: 1 }, { workspaceFolder: input.workspaceFolder })]) {
    assert.match(prompt, /2–4 options/);
    assert.match(prompt, /recommendation/);
    assert.match(prompt, /one sentence/);
  }
});
