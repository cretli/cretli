import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { addTodo } from '../lib/persist/todos-store.js';
import { upsertWorkspaceWatcher, mutateWorkspaceWatcherRow, getWorkspaceWatcher } from '../lib/persist/workspace-watchers-persist.js';
import { reportWorkspaceWatcherCycle } from '../lib/workspace-watcher-cycle.js';
import { listPendingDecisions, closeDecisionStores } from '../lib/decisions/decision-store.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';

after(closeDecisionStores);
for (const invalid of [false, true, 'missing']) test(`needs_human closes cycle with ${invalid ? 'fallback and one violation' : 'structured options'}`, async () => {
  const workspaceFolder = `/tmp/human-${randomUUID()}`;
  const chatId = randomUUID();
  const todo = (await addTodo(dataDir, workspaceFolder, { title: 'Task', status: 'doing' })).item;
  const cycleId = randomUUID();
  upsertWorkspaceWatcher(workspaceFolder, { mode: 'autopilot', policy: { requirePlanApproval: false } }, { dataDir });
  mutateWorkspaceWatcherRow(workspaceFolder, () => ({ activeCycle: { cycleId, chatId, todoIds: [todo.id], startedAt: new Date().toISOString(), phase: 'running' } }), { dataDir });
  const input = { dataDir, workspaceFolder, sourceChatId: chatId, outcome: 'blocked', reasonCode: 'needs_human', cycleId,
    ...(invalid === 'missing' ? {} : invalid ? { options: [{ label: 'Incomplete' }] } : {
      options: [{ id: 'retry', label: 'Retry', effect: 'Retry task', risk: 'low', reversible: true }, { id: 'defer', label: 'Defer', effect: 'Postpone task' }],
      recommended: 'retry', why: 'Retry could recover a temporary error.',
    }), deps: { loadDelegations: () => [] } };
  const result = await reportWorkspaceWatcherCycle(input);
  assert.equal(result.ok, true);
  assert.equal(result.closed, true);
  assert.ok(result.decision, result.warning);
  assert.equal(Boolean(result.warning), Boolean(invalid));
  assert.equal(result.decision.options[0].risk, 'medium');
  assert.equal(result.decision.options[0].reversible, false);
  assert.equal(result.decision.options[0].label, invalid ? 'Odpowiedz w czacie' : 'Retry');
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  assert.equal(row.activeCycle, null);
  assert.equal(row.decisionProducerViolations[chatId] || 0, invalid ? 1 : 0);
  const replay = await reportWorkspaceWatcherCycle(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.decision.id, result.decision.id);
  assert.equal(Boolean(replay.warning), Boolean(invalid));
  assert.equal(getWorkspaceWatcher(workspaceFolder, { dataDir }).decisionProducerViolations[chatId] || 0, invalid ? 1 : 0);
  assert.equal((await listPendingDecisions(dataDir, workspaceFolder)).items.length, 1);
});

test('both MCP report entry points forward options and return the soft warning', async () => {
  const handlers = createCretliMcpToolHandlers({ workspaceWatcherUpdate: async (input) => ({ ok: true,
    warning: 'fallback', options: input.options, recommended: input.recommended, why: input.why }) },
  { workspaceFolder: '/tmp/my-app', chatId: randomUUID(), mode: 'agent' });
  for (const name of ['watcher_report', 'watcher_update']) {
    const result = await handlers[name]({ action: 'report', outcome: 'blocked', reason_code: 'needs_human', options: [], recommended: 'x', why: 'why' });
    assert.equal(result.structuredContent.warning, 'fallback');
    assert.deepEqual(result.structuredContent.options, []);
    assert.equal(result.structuredContent.recommended, 'x');
  }
});
