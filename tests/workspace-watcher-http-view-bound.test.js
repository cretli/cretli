import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toWorkspaceWatcherHttpView,
  WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT,
} from '../lib/workspace-watcher-control.js';

test('HTTP view keeps only the newest decisions and reports the total', () => {
  const decisions = Array.from({ length: WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT + 25 }, (_, i) => ({ n: i }));
  const view = toWorkspaceWatcherHttpView({ watcher: { decisions }, snapshot: { items: [], count: 1 } });
  assert.equal(view.watcher.decisions.length, WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT);
  assert.equal(view.watcher.decisions.at(-1).n, decisions.length - 1);
  assert.equal(view.watcher.decisionsTotal, decisions.length);
  assert.equal(decisions.length, WORKSPACE_WATCHER_HTTP_DECISIONS_LIMIT + 25);
});

test('HTTP view leaves a short decision log untouched', () => {
  const view = toWorkspaceWatcherHttpView({ watcher: { decisions: [{ n: 1 }] } });
  assert.equal(view.watcher.decisions.length, 1);
  assert.equal(view.watcher.decisionsTotal, undefined);
});
