import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { addTodo, updateTodo } from '../lib/persist/todos-persist.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { createDelegationRecord, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import {
  registerWorkspaceWatcherAutopilotRunner,
  scheduleWorkspaceWatcherAutopilot,
  stopWorkspaceWatcherAutopilotSchedule,
  workspaceWatcherAutopilotPendingDebounceCount,
} from '../lib/workspace-watcher-event-schedule.js';
import { registerWorkspaceWatcherPresenceNudge, setAgentPresenceDirtyHandler, markAgentPresenceDirty } from '../lib/agent-presence-hooks.js';
import { scheduleWorkspaceWatcherAutopilotFromChatIds } from '../lib/workspace-watcher-nudge.js';

const folder = ISOLATED_DATA_DIR;
const runs = [];
let notifyRun = null;
registerWorkspaceWatcherAutopilotRunner(async (input) => {
  runs.push(input);
  notifyRun?.();
});
function nextRun() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('watcher event did not reach its runner')), 4000);
    notifyRun = () => { clearTimeout(timeout); notifyRun = null; resolve(); };
  });
}
const flushImports = () => new Promise((resolve) => setTimeout(resolve, 30));

try {
  let fired = nextRun();
  const todo = addTodo(ISOLATED_DATA_DIR, folder, { title: 'Event todo', status: 'ready' }).item;
  await fired;
  assert.equal(runs.length, 1, 'creating a ready todo triggers the runner');
  assert.equal(runs[0].workspaceFolder, folder);

  updateTodo(ISOLATED_DATA_DIR, folder, todo.id, { title: 'Metadata only' });
  await flushImports();
  assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 0, 'metadata writes do not create tick loops');

  fired = nextRun();
  updateTodo(ISOLATED_DATA_DIR, folder, todo.id, { status: 'doing' });
  await fired;
  assert.equal(runs.length, 2, 'status changes trigger the runner');

  fired = nextRun();
  updateTodo(ISOLATED_DATA_DIR, folder, todo.id, { plan: { markdown: 'Draft', approvedAt: new Date().toISOString() } });
  await fired;
  assert.equal(runs.length, 3, 'human approval triggers the runner');

  const parent = addChat('event-parent', 'Parent', null, folder, 'auto', { agentTransport: 'mock' });
  const child = addChat('event-child', 'Child', null, folder, 'auto', { agentTransport: 'mock' });
  const delegation = createDelegationRecord({ parentChatId: parent.id, childChatId: child.id, workspaceFolder: folder, status: 'running' });
  fired = nextRun();
  updateDelegationRecord(delegation.id, { status: 'completed' });
  await fired;
  assert.equal(runs.length, 4, 'persisted terminal delegation triggers the runner');

  let presenceUpdates = 0;
  setAgentPresenceDirtyHandler(() => { presenceUpdates += 1; });
  registerWorkspaceWatcherPresenceNudge((ids) => scheduleWorkspaceWatcherAutopilotFromChatIds(ids, ISOLATED_DATA_DIR));
  fired = nextRun();
  markAgentPresenceDirty([child.id]);
  markAgentPresenceDirty([child.id]);
  assert.equal(presenceUpdates, 2, 'the existing presence observer is preserved');
  assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 1, 'chat events coalesce per workspace');
  await fired;
  assert.equal(runs.length, 5, 'chat presence triggers one debounced run');

  scheduleWorkspaceWatcherAutopilot({ workspaceFolder: folder, debounceMs: 10 });
  stopWorkspaceWatcherAutopilotSchedule();
  await flushImports();
  assert.equal(runs.length, 5, 'shutdown cancels pending nudges');
  scheduleWorkspaceWatcherAutopilot({ workspaceFolder: folder });
  assert.equal(workspaceWatcherAutopilotPendingDebounceCount(), 0, 'no runner means no queued work');
  console.log('workspace watcher events: all passed');
} finally {
  stopWorkspaceWatcherAutopilotSchedule();
  registerWorkspaceWatcherPresenceNudge(null);
  setAgentPresenceDirtyHandler(null);
  removeIsolatedDataDir();
}
