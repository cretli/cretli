import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { loadTodosData } from '../lib/persist/todos-persist.js';
import { readChatPlanFile } from '../lib/chat-plan-persist.js';
import {
  applyHarnessOutboundPrompt,
  HARNESS_PLAN_MODE_HINT,
} from '../lib/sdk/harness-plan-prompt.js';
import {
  bindHarnessPlanSync,
  captureHarnessPlanFromSdkEvent,
  noteHarnessWsPayloadForPlanSync,
  readTodoSyncDataDir,
  resetHarnessPlanCapture,
} from '../lib/sdk/harness-plan-sync.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-harness-plan-'));

assert.equal(readTodoSyncDataDir({ todoSyncDataDir: ' /tmp/data ' }), '/tmp/data');
assert.equal(readTodoSyncDataDir({}), '');
const emptyBindRoom = {};
bindHarnessPlanSync(emptyBindRoom, { workspaceDirForAgent: () => '' });
assert.equal(emptyBindRoom._todoSyncDataDir, undefined);

assert.match(HARNESS_PLAN_MODE_HINT, /Cretli persists your plan/);
assert.match(HARNESS_PLAN_MODE_HINT, /question-UI approval/);
assert.equal(
  applyHarnessOutboundPrompt('hello', { mode: 'plan', transport: 'opencode' }).startsWith(HARNESS_PLAN_MODE_HINT),
  true
);
assert.equal(
  applyHarnessOutboundPrompt('hello', {
    mode: 'plan',
    transport: 'opencode',
    skipPlanHint: true,
  }),
  'hello'
);
assert.equal(
  applyHarnessOutboundPrompt('hello', { mode: 'plan', transport: 'qwen' }),
  'hello'
);

const captureRoom = {};
resetHarnessPlanCapture(captureRoom);
captureHarnessPlanFromSdkEvent(captureRoom, {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: '# Step 1' }] },
});
captureHarnessPlanFromSdkEvent(captureRoom, {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: '# Step 1\n# Step 2' }] },
});
assert.equal(captureRoom._currentRunAssistantText, '# Step 1\n# Step 2');

const dataDir = path.join(tmpRoot, 'data');
const project = path.join(tmpRoot, 'proj');
mkdirSync(dataDir, { recursive: true });
mkdirSync(project, { recursive: true });
const room = {
  chatId: 'chat-opencode-plan',
  chatTitle: 'GLM plan',
  cwd: project,
  sdkMode: 'plan',
};
bindHarnessPlanSync(room, { todoSyncDataDir: dataDir });
noteHarnessWsPayloadForPlanSync(room, { type: 'sdkPromptStarted' });
noteHarnessWsPayloadForPlanSync(room, {
  type: 'sdkEvent',
  event: {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '# Persist me\n\nDo the work.' }],
    },
  },
});
noteHarnessWsPayloadForPlanSync(room, { type: 'sdkRunFinished', status: 'completed' });
const actualFile = readChatPlanFile({ cwd: project, chatId: 'chat-opencode-plan' });
assert.match(actualFile, /Persist me/);
const actualTodos = loadTodosData(dataDir, project).items;
assert.equal(actualTodos.length, 1);
assert.match(String(actualTodos[0].plan?.markdown || ''), /Persist me/);

rmSync(tmpRoot, { recursive: true, force: true });
console.log('harness-plan-sync.test.js OK');
