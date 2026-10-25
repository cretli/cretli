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
  ensureLinkedTodoForPlan,
  extractLatestAssistantTextFromHistoryStore,
  persistTodoImplementationSummary,
  persistTodoPlan,
  readCurrentRunAssistantText,
  readCurrentRunPlanMarkdown,
  syncTodoAfterSdkRunFinished,
} from '../lib/todo-plan-sync.js';

let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log('OK:', name);
  } catch (err) {
    failed += 1;
    console.error('FAIL:', name);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-plan-'));

await runCase('readCurrentRunPlanMarkdown: prefers CreatePlan buffer over short closer', async () => {
  const actualMarkdown = await readCurrentRunPlanMarkdown({
    chatId: 'missing-history-chat',
    _currentRunAssistantText: 'and the scope of OSS fixes.',
    _currentRunPlanMarkdown: '# System analysis\n\n## Verdict\n\nSuitable for OSS.',
  });
  assert.match(actualMarkdown, /## Verdict/);
  assert.equal(actualMarkdown.includes('the scope of OSS fixes'), false);
});

await runCase('readCurrentRunAssistantText prefers room buffer', async () => {
  const actualText = await readCurrentRunAssistantText({
    chatId: 'missing-history-chat',
    _currentRunAssistantText: 'Live plan text',
  });
  assert.equal(actualText, 'Live plan text');
});

await runCase('persistTodoPlan: strips title JSON and stores excerpt changelog', () => {
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

await runCase('persistTodoPlan: stores markdown and changelog', () => {
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

await runCase('persistTodoPlan: approved plan sets doing', () => {
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

await runCase('persistTodoImplementationSummary: appends implement changelog', () => {
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

await runCase('syncTodoAfterSdkRunFinished: no-op without linked chat', async () => {
  const synced = await syncTodoAfterSdkRunFinished({
    dataDir: '/tmp/unused',
    chatId: '',
    status: 'finished',
    sdkMode: 'plan',
    room: { cwd: '/tmp', _currentRunAssistantText: 'Plan' },
  });
  assert.equal(synced, false);
});

await runCase('syncTodoAfterSdkRunFinished: prefers workspace plan file over short assistant text', async () => {
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
  const actualSynced = await syncTodoAfterSdkRunFinished({
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

await runCase('syncTodoAfterSdkRunFinished: prefers longer assistant text over tiny plan file', async () => {
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
  const actualSynced = await syncTodoAfterSdkRunFinished({
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

await runCase('syncTodoAfterSdkRunFinished: writes workspace plan and creates todo', async () => {
  const dataDir = path.join(tmpRoot, 'plan-auto');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-auto-proj');
  mkdirSync(project, { recursive: true });
  const actualSynced = await syncTodoAfterSdkRunFinished({
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

await runCase('syncTodoAfterSdkRunFinished: ask mode does not persist a plan', async () => {
  const dataDir = path.join(tmpRoot, 'ask-no-plan');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'ask-no-plan-proj');
  mkdirSync(project, { recursive: true });
  const actualSynced = await syncTodoAfterSdkRunFinished({
    dataDir,
    chatId: 'chat-ask-no-plan',
    status: 'completed',
    sdkMode: 'ask',
    room: {
      cwd: project,
      chatId: 'chat-ask-no-plan',
      chatTitle: 'Ask run',
      _currentRunAssistantText: '# Should not become a plan',
    },
  });
  assert.equal(actualSynced, false);
  assert.equal(loadTodosData(dataDir, project).items.length, 0);
});

await runCase('updateTodo: plan merge keeps previous markdown', () => {
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

await runCase('updateTodo: approving a done container keeps it done, markdown edit clears approval', () => {
  const dataDir = path.join(tmpRoot, 'plan-done-root');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'plan-done-root-proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Root' });
  const rootId = loadTodosData(dataDir, project).items[0].id;
  addTodo(dataDir, project, { title: 'Child', parentId: rootId });
  const childId = loadTodosData(dataDir, project).items.find((row) => row.title === 'Child').id;
  updateTodo(dataDir, project, childId, { status: 'done' });
  // The container status is derived from its children, so the root is done.
  assert.equal(loadTodosData(dataDir, project).items.find((row) => row.id === rootId).status, 'done');
  updateTodo(dataDir, project, rootId, { plan: { markdown: '# Root plan v1' } });
  const approvedAt = new Date().toISOString();
  updateTodo(dataDir, project, rootId, { plan: { approvedAt } });
  const approved = loadTodosData(dataDir, project).items.find((row) => row.id === rootId);
  // Approval is sticky on a done node: the plan write must not reopen the status.
  assert.equal(approved.plan.approvedAt, approvedAt);
  assert.equal(approved.status, 'done');
  // A later markdown edit is a new plan revision: approval is dropped, status stays.
  updateTodo(dataDir, project, rootId, { plan: { markdown: '# Root plan v2' } });
  const edited = loadTodosData(dataDir, project).items.find((row) => row.id === rootId);
  assert.equal(String(edited.plan.markdown).includes('v2'), true);
  assert.equal(edited.plan.approvedAt, undefined);
  assert.equal(edited.status, 'done');
});

await runCase('ensureLinkedTodoForPlan: returns the todo created by addTodo', () => {
  const dataDir = path.join(tmpRoot, 'ensure1');
  mkdirSync(dataDir, { recursive: true });
  const project = path.join(tmpRoot, 'ensure1proj');
  mkdirSync(project, { recursive: true });
  addTodo(dataDir, project, { title: 'Pre-existing item' });
  const todoId = ensureLinkedTodoForPlan({
    dataDir,
    cwd: project,
    chatId: 'chat-ensure-1',
    title: 'Fresh plan todo',
  });
  assert.ok(todoId);
  const items = loadTodosData(dataDir, project).items;
  assert.equal(items.length, 2);
  const created = items.find((row) => row.id === todoId);
  assert.equal(created.title, 'Fresh plan todo');
  assert.equal(created.status, 'ready');
  // The id must come from the addTodo return value, not items[0] guessing.
  const preExisting = items.find((row) => row.title === 'Pre-existing item');
  assert.notEqual(todoId, preExisting.id);
});

await runCase('extractLatestAssistantTextFromHistoryStore reads last assistant turn', () => {
  const text = extractLatestAssistantTextFromHistoryStore({
    events: [
      {
        seq: 1,
        rec: {
          kind: 'sdk',
          event: { type: 'assistant', message: { content: [{ type: 'text', text: 'First reply' }] } },
        },
      },
      { seq: 2, rec: { kind: 'localUser' } },
      {
        seq: 3,
        rec: {
          kind: 'sdk',
          event: { type: 'assistant', message: { content: [{ type: 'text', text: 'Final answer' }] } },
        },
      },
    ],
  });
  assert.equal(text, 'Final answer');
});

try {
  rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // ignore
}

process.exit(failed ? 1 : 0);
