/**
 * Unit tests for the workspace git-switch guard.
 *
 * All registry readers are injected, so no durable state or live git process
 * is needed; the assertions cover the folder-containment rule, the three
 * work sources (chats, delegations, watcher cycles) and the fail-open
 * behaviour on registry errors.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  collectWorkspaceGitActivity,
  isFolderInsideBase,
} from '../lib/git-switch-guard.js';

const ROOT = path.resolve('/tmp/work/project');
const WORKTREE = path.resolve('/tmp/other/worktree');

function baseDeps(overrides = {}) {
  return {
    loadChats: () => [],
    probeChatRunLiveness: () => ({ known: false, busy: false }),
    listActiveDelegations: () => [],
    isDelegationSlotOccupied: () => false,
    isActiveDelegationStatus: () => false,
    loadWorkspaceWatchers: () => [],
    getWorkspaceWatcherActiveCycles: () => [],
    ...overrides,
  };
}

test('isFolderInsideBase accepts the base itself, children and rejects siblings', () => {
  assert.equal(isFolderInsideBase(ROOT, ROOT), true);
  assert.equal(isFolderInsideBase(ROOT, path.join(ROOT, 'sub', 'dir')), true);
  assert.equal(isFolderInsideBase(ROOT, WORKTREE), false);
  assert.equal(isFolderInsideBase(ROOT, ''), false);
  assert.equal(isFolderInsideBase('', ROOT), false);
});

test('idle workspace reports not busy with zeroed counters', () => {
  const activity = collectWorkspaceGitActivity(ROOT, { deps: baseDeps() });
  assert.deepEqual(activity, { busy: false, runningChats: 0, runningDelegations: 0, watcherCycles: 0 });
});

test('a busy chat inside the repo makes the workspace busy', () => {
  const activity = collectWorkspaceGitActivity(ROOT, {
    deps: baseDeps({
      loadChats: () => [
        { id: 'chat-1', executionFolder: path.join(ROOT, 'sub') },
        { id: 'chat-2', executionFolder: WORKTREE },
      ],
      probeChatRunLiveness: ({ chat }) => ({ known: true, busy: chat.id === 'chat-1' }),
    }),
  });
  assert.equal(activity.busy, true);
  assert.equal(activity.runningChats, 1);
});

test('a chat in a worktree outside the repo does not block the switch', () => {
  const activity = collectWorkspaceGitActivity(ROOT, {
    deps: baseDeps({
      loadChats: () => [{ id: 'chat-1', executionFolder: WORKTREE }],
      probeChatRunLiveness: () => ({ known: true, busy: true }),
    }),
  });
  assert.equal(activity.busy, false);
});

test('delegations with an occupied slot or active status count as running', () => {
  const activity = collectWorkspaceGitActivity(ROOT, {
    deps: baseDeps({
      listActiveDelegations: () => [
        { id: 'd1', workspaceFolder: ROOT },
        { id: 'd2', workspaceFolder: ROOT, status: 'running' },
        { id: 'd3', workspaceFolder: WORKTREE },
      ],
      isDelegationSlotOccupied: (row) => row.id === 'd1',
      isActiveDelegationStatus: (status) => status === 'running',
    }),
  });
  assert.equal(activity.busy, true);
  assert.equal(activity.runningDelegations, 2);
});

test('active watcher cycles in the workspace count as running', () => {
  const activity = collectWorkspaceGitActivity(ROOT, {
    deps: baseDeps({
      loadWorkspaceWatchers: () => [{ workspaceFolder: ROOT }, { workspaceFolder: WORKTREE }],
      getWorkspaceWatcherActiveCycles: (row) => (
        row.workspaceFolder === ROOT ? [{ cycleId: 'c1' }, { cycleId: 'c2' }] : []
      ),
    }),
  });
  assert.equal(activity.busy, true);
  assert.equal(activity.watcherCycles, 2);
});

test('a failing registry read degrades to a weaker guard instead of throwing', () => {
  const activity = collectWorkspaceGitActivity(ROOT, {
    deps: baseDeps({
      loadChats: () => {
        throw new Error('registry unavailable');
      },
      listActiveDelegations: () => {
        throw new Error('registry unavailable');
      },
      loadWorkspaceWatchers: () => {
        throw new Error('registry unavailable');
      },
    }),
  });
  assert.equal(activity.busy, false);
});

test('an empty repo root short-circuits to not busy', () => {
  const activity = collectWorkspaceGitActivity('', { deps: baseDeps() });
  assert.equal(activity.busy, false);
});
