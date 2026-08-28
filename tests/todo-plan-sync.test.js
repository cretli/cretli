import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  addTodo,
  loadTodosData,
  updateTodo,
} from '../lib/persist/todos-persist.js';
import { readChatPlanFile, writeChatPlanFile } from '../lib/chat-plan-persist.js';
import {
  persistTodoImplementationSummary,
  persistTodoPlan,
  readCurrentRunAssistantText,
  readCurrentRunPlanMarkdown,
  syncTodoAfterSdkRunFinished,
} from '../lib/todo-plan-sync.js';

let failed = 0;

function runCase(name, fn) {
  try {
    fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-plan-'));

runCase('readCurrentRunPlanMarkdown: prefers CreatePlan buffer over short closer', () => {
  const actualMarkdown = readCurrentRunPlanMarkdown({
    chatId: 'missing-history-chat',
    _currentRunAssistantText: 'and the scope of OSS fixes.',
    _currentRunPlanMarkdown: '# System analysis\n\n## Verdict\n\nSuitable for OSS.',
  });
  assert.match(actualMarkdown, /## Verdict/);
  assert.equal(actualMarkdown.includes('the scope of OSS fixes'), false);
});

runCase('readCurrentRunAssistantText prefers room buffer', () => {
  const actualText = readCurrentRunAssistantText({
    chatId: 'missing-history-chat',
    _currentRunAssistantText: 'Live plan text',
  });
  assert.equal(actualText, 'Live plan text');
});

runCase('persistTodoPlan: strips title JSON and stores excerpt changelog', () => {
  const dataDir = path.join(tmpRoot, 'plan-sanitize');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-sanitize-proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Sanitize' });
  const id = loadTodosData(dataDir, project).items[0].id;
  persistTodoPlan({
    dataDir,
    cwd: project,
    todoId: id,
    chatId: 'chat-sanitize',
    planMarkdown: '# Fix status save\n\nUse detail.status.\n{"title": "Fixed todo status"}',
    sourceHarness: 'opencode',
    promoteStatus: true,
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.sourceHarness, 'opencode');
  assert.equal(String(item.plan.markdown).includes('{"title"'), false);
  assert.equal(item.changelog[0].text.includes('{"title"'), false);
  assert.match(item.changelog[0].text, /Fix status save/);
});

runCase('persistTodoPlan: stores markdown and changelog', () => {
  const dataDir = path.join(tmpRoot, 'plan1');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan1proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Task' });
  const id = loadTodosData(dataDir, project).items[0].id;
  persistTodoPlan({
    dataDir,
    cwd: project,
    todoId: id,
    chatId: 'chat-1',
    planMarkdown: '# Plan\nStep 1',
    promoteStatus: true,
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.plan.markdown, '# Plan\nStep 1');
  assert.equal(item.changelog.length, 1);
  assert.equal(item.changelog[0].kind, 'plan');
  assert.deepEqual(item.linkedChatIds, ['chat-1']);
  assert.equal(item.status, 'ready');
});

runCase('persistTodoPlan: approved plan sets doing', () => {
  const dataDir = path.join(tmpRoot, 'plan2');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan2proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Idea task', status: 'idea' });
  const id = loadTodosData(dataDir, project).items[0].id;
  persistTodoPlan({
    dataDir,
    cwd: project,
    todoId: id,
    chatId: 'chat-2',
    planMarkdown: 'Detailed plan',
    approvedAt: new Date().toISOString(),
    promoteStatus: true,
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.status, 'doing');
  assert.ok(item.plan.approvedAt);
});

runCase('persistTodoImplementationSummary: appends implement changelog', () => {
  const dataDir = path.join(tmpRoot, 'plan3');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan3proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Build', status: 'doing' });
  const id = loadTodosData(dataDir, project).items[0].id;
  persistTodoImplementationSummary({
    dataDir,
    cwd: project,
    todoId: id,
    chatId: 'chat-3',
    summaryText: 'Updated server routes and todo card UI.',
    markDone: true,
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.status, 'done');
  assert.equal(item.changelog[0].kind, 'implement');
});

runCase('syncTodoAfterSdkRunFinished: no-op without linked chat', () => {
  const synced = syncTodoAfterSdkRunFinished({
    dataDir: '/tmp/unused',
    chatId: '',
    status: 'finished',
    sdkMode: 'plan',
    room: { cwd: '/tmp', _currentRunAssistantText: 'Plan' },
  });
  assert.equal(synced, false);
});

runCase('syncTodoAfterSdkRunFinished: prefers workspace plan file over short assistant text', () => {
  const dataDir = path.join(tmpRoot, 'plan-prefer-file');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-prefer-file-proj');
  mkdirSync(project, { recursive: true });
  const filePlan = `# Workspace plan file\n\n${'step '.repeat(40)}`;
  writeChatPlanFile({
    cwd: project,
    chatId: 'chat-prefer-file',
    title: 'Workspace plan',
    markdown: filePlan,
  });
  const actualSynced = syncTodoAfterSdkRunFinished({
    dataDir,
    chatId: 'chat-prefer-file',
    status: 'completed',
    sdkMode: 'plan',
    room: {
      cwd: project,
      chatId: 'chat-prefer-file',
      chatTitle: 'Workspace plan',
      _currentRunAssistantText: 'short live note',
    },
  });
  assert.equal(actualSynced, true);
  const actualTodos = loadTodosData(dataDir, project).items;
  assert.equal(actualTodos.length, 1);
  assert.match(String(actualTodos[0].plan?.markdown || ''), /Workspace plan file/);
  assert.equal(String(actualTodos[0].plan?.markdown || '').includes('short live note'), false);
});

runCase('syncTodoAfterSdkRunFinished: prefers longer assistant text over tiny plan file', () => {
  const dataDir = path.join(tmpRoot, 'plan-prefer-asst');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-prefer-asst-proj');
  mkdirSync(project, { recursive: true });
  writeChatPlanFile({
    cwd: project,
    chatId: 'chat-prefer-asst',
    title: 'Tiny',
    markdown: 'tiny',
  });
  const assistantPlan = `# Assistant plan\n\n${'detail '.repeat(40)}`;
  const actualSynced = syncTodoAfterSdkRunFinished({
    dataDir,
    chatId: 'chat-prefer-asst',
    status: 'completed',
    sdkMode: 'plan',
    room: {
      cwd: project,
      chatId: 'chat-prefer-asst',
      chatTitle: 'Assistant plan',
      _currentRunAssistantText: assistantPlan,
    },
  });
  assert.equal(actualSynced, true);
  const actualTodos = loadTodosData(dataDir, project).items;
  assert.match(String(actualTodos[0].plan?.markdown || ''), /Assistant plan/);
  assert.equal(String(actualTodos[0].plan?.markdown || '').includes('tiny'), false);
});

runCase('syncTodoAfterSdkRunFinished: writes workspace plan and creates todo', () => {
  const dataDir = path.join(tmpRoot, 'plan-auto');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-auto-proj');
  mkdirSync(project, { recursive: true });
  const actualSynced = syncTodoAfterSdkRunFinished({
    dataDir,
    chatId: 'chat-plan-auto',
    status: 'completed',
    sdkMode: 'plan',
    room: {
      cwd: project,
      chatId: 'chat-plan-auto',
      chatTitle: 'Toolbar',
      _currentRunAssistantText: '# Align bar heights',
    },
  });
  assert.equal(actualSynced, true);
  const actualPlanFile = readChatPlanFile({ cwd: project, chatId: 'chat-plan-auto' });
  assert.match(actualPlanFile, /Align bar heights/);
  const actualTodos = loadTodosData(dataDir, project).items;
  assert.equal(actualTodos.length, 1);
  assert.match(String(actualTodos[0].plan?.markdown || ''), /Align bar heights/);
});

runCase('updateTodo: plan merge keeps previous markdown', () => {
  const dataDir = path.join(tmpRoot, 'plan4');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan4proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Merge' });
  const id = loadTodosData(dataDir, project).items[0].id;
  updateTodo(dataDir, project, id, {
    plan: { markdown: 'Original plan' },
  });
  updateTodo(dataDir, project, id, {
    plan: { approvedAt: new Date().toISOString() },
  });
  const item = loadTodosData(dataDir, project).items[0];
  assert.equal(item.plan.markdown, 'Original plan');
  assert.ok(item.plan.approvedAt);
});

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // ignore
}

process.exit(failed ? 1 : 0);
