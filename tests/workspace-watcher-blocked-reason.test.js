/**
 * Regression tests for the Workspace Watcher blocked-reason markers.
 *
 * The findings loop parks a todo with the `WORKSPACE_WATCHER_PARKED_REASON`
 * marker but never records it in `watcher.failures`. The per-todo retry and the
 * Settings/todo "clear stop" action must both recognize that marker, otherwise a
 * todo parked solely by the findings loop stays blocked forever. These tests pin
 * the shared predicate and the UI wiring to it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX,
  WORKSPACE_WATCHER_PARKED_REASON,
  isWorkspaceWatcherBlockedReason,
  isWorkspaceWatcherRetryableBlockedTodo,
  workspaceWatcherFailureCeilingReason,
} from '../lib/workspace-watcher-blocked-reason.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiSource = fs.readFileSync(path.join(root, 'app_front/api.js'), 'utf8');
const cardSource = fs.readFileSync(
  path.join(root, 'app_front/components/ui/cr-todo-card.js'),
  'utf8',
);

test('the findings-park marker classifies as a watcher blocker', () => {
  assert.ok(isWorkspaceWatcherBlockedReason(WORKSPACE_WATCHER_PARKED_REASON));
  // The marker may be embedded in a longer reason text without losing identity.
  assert.ok(isWorkspaceWatcherBlockedReason(`prefix ${WORKSPACE_WATCHER_PARKED_REASON}`));
});

test('the failure-ceiling marker classifies as a watcher blocker', () => {
  assert.ok(isWorkspaceWatcherBlockedReason(workspaceWatcherFailureCeilingReason(3, 3)));
  assert.match(workspaceWatcherFailureCeilingReason(3, 3), /failure ceiling reached \(3\/3\)/);
  assert.ok(WORKSPACE_WATCHER_FAILURE_CEILING_PREFIX.length > 0);
});

test('foreign or empty blocked reasons are not watcher blockers', () => {
  assert.equal(isWorkspaceWatcherBlockedReason(''), false);
  assert.equal(isWorkspaceWatcherBlockedReason(null), false);
  assert.equal(isWorkspaceWatcherBlockedReason('Waiting on dependency'), false);
  assert.equal(isWorkspaceWatcherBlockedReason('Workspace Watcher unrelated text'), false);
});

test('the retry path accepts a todo parked only by the findings loop', () => {
  assert.equal(
    isWorkspaceWatcherRetryableBlockedTodo({
      blockedReason: WORKSPACE_WATCHER_PARKED_REASON,
      status: 'ready',
    }),
    true,
  );
  assert.equal(
    isWorkspaceWatcherRetryableBlockedTodo({
      blockedReason: workspaceWatcherFailureCeilingReason(2, 2),
      status: 'ready',
    }),
    true,
  );
});

test('the retry path still refuses foreign reasons, doing and done todos', () => {
  assert.equal(
    isWorkspaceWatcherRetryableBlockedTodo({ blockedReason: 'Waiting on dependency', status: 'ready' }),
    false,
  );
  assert.equal(
    isWorkspaceWatcherRetryableBlockedTodo({
      blockedReason: WORKSPACE_WATCHER_PARKED_REASON,
      status: 'doing',
    }),
    false,
  );
  assert.equal(
    isWorkspaceWatcherRetryableBlockedTodo({
      blockedReason: WORKSPACE_WATCHER_PARKED_REASON,
      status: 'done',
    }),
    false,
  );
});

test('the API retry path uses the shared predicate instead of a literal', () => {
  assert.match(apiSource, /isWorkspaceWatcherRetryableBlockedTodo\(todo\)/);
  assert.doesNotMatch(apiSource, /Workspace Watcher failure ceiling/);
});

test('the todo card shows Retry from the shared predicate, not a literal', () => {
  assert.match(cardSource, /isWorkspaceWatcherRetryableBlockedTodo\(item\)/);
  assert.doesNotMatch(cardSource, /Workspace Watcher failure ceiling/);
});
