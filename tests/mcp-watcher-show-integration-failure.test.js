import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactWatcherViewForMcp, formatWatcher } from '../lib/mcp/builtin/watcher-tools.js';
import { normalizeWorkspaceWatcherDecision } from '../lib/persist/workspace-watchers-persist.js';

test('watcher_show text and structured view name the leaf and cause of integration_failure_limit', () => {
  // Round-trip through the persisted normalizer so the test covers what the store keeps.
  const decision = normalizeWorkspaceWatcherDecision({
    at: new Date().toISOString(), kind: 'integration_failure_limit', reason: 'integration_failure_limit', shouldNotify: true,
    integrationFailure: { todoId: 'fac124b7-0000-0000-0000-000000000000', cause: 'patch_invalid', count: 3, todoIds: ['fac124b7-0000-0000-0000-000000000000'] },
  });
  assert.equal(decision.integrationFailure.cause, 'patch_invalid');
  const view = { workspaceFolder: '/tmp/my-app', watcher: { decisions: [decision], policy: {} } };
  const text = formatWatcher(view);
  assert.match(text, /integration_failure_limit\/integration_failure_limit \[leaf=fac124b7; cause=patch_invalid; failures=3\]/);
  const compact = compactWatcherViewForMcp(view);
  const row = compact.watcher.decisions[0];
  assert.equal(row.integrationFailure.cause, 'patch_invalid');
  assert.equal(row.integrationFailure.todoId, 'fac124b7-0000-0000-0000-000000000000');
});
