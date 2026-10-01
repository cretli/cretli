import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { writeChatPlanFile } from '../lib/chat-plan-persist.js';
import {
  buildTodoChatIndex,
  enrichTodoItemsWithSourceChat,
  hydrateTodoPlanMarkdown,
  resolveTodoChats,
  resolveTodoSourceChat,
  resolveTodoSourceChatId,
} from '../lib/todo-source-chat.js';

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

runCase('resolveTodoSourceChatId: prefers chatId', () => {
  const actualId = resolveTodoSourceChatId({
    chatId: 'chat-direct',
    plan: { sourceChatId: 'chat-plan' },
    linkedChatIds: ['chat-linked'],
  });
  assert.equal(actualId, 'chat-direct');
});

runCase('resolveTodoSourceChatId: falls back to plan then linked', () => {
  assert.equal(
    resolveTodoSourceChatId({ plan: { sourceChatId: 'chat-plan' }, linkedChatIds: ['chat-linked'] }),
    'chat-plan'
  );
  assert.equal(resolveTodoSourceChatId({ linkedChatIds: ['chat-linked'] }), 'chat-linked');
  assert.equal(resolveTodoSourceChatId({}), '');
});

runCase('resolveTodoSourceChat: uses chat title and stored harness', () => {
  const inputChats = [{ id: 'chat-1', title: 'Toolbar', agentTransport: 'opencode' }];
  const actualSource = resolveTodoSourceChat(
    { chatId: 'chat-1', sourceHarness: 'sdk' },
    inputChats
  );
  assert.deepEqual(actualSource, {
    id: 'chat-1',
    title: 'Toolbar',
    agentTransport: 'opencode',
  });
});

runCase('resolveTodoSourceChat: stored harness when chat is missing', () => {
  const actualSource = resolveTodoSourceChat({
    plan: { sourceChatId: 'chat-gone' },
    sourceHarness: 'openrouter',
  });
  assert.deepEqual(actualSource, {
    id: 'chat-gone',
    title: '',
    agentTransport: 'openrouter',
  });
});

runCase('enrichTodoItemsWithSourceChat: adds sourceChat and sanitizes changelog', () => {
  const inputItems = [
    {
      id: 'todo-1',
      chatId: 'chat-1',
      sourceHarness: 'opencode',
      changelog: [
        { kind: 'implement', text: 'Led the agent.\n{"title": "Updated todo card"}' },
      ],
    },
    { id: 'todo-2', title: 'Manual' },
  ];
  const inputChats = [{ id: 'chat-1', title: 'Todo polish', agentTransport: 'opencode' }];
  const actualItems = enrichTodoItemsWithSourceChat(inputItems, inputChats);
  assert.deepEqual(actualItems[0].sourceChat, {
    id: 'chat-1',
    title: 'Todo polish',
    agentTransport: 'opencode',
  });
  assert.equal(actualItems[0].changelog[0].text.includes('{"title"'), false);
  assert.match(actualItems[0].changelog[0].text, /Led the agent/);
  assert.equal(actualItems[1].sourceChat, undefined);
});

runCase('enrichTodoItemsWithSourceChat: drops changelog that is only title JSON', () => {
  const actualItems = enrichTodoItemsWithSourceChat([
    {
      id: 'todo-json',
      changelog: [{ kind: 'implement', text: 'title": "Markdown preview and Todo collapsing"}' }],
    },
  ]);
  assert.deepEqual(actualItems[0].changelog, []);
});

runCase('hydrateTodoPlanMarkdown: prefers workspace file over stored excerpt', () => {
  const inputCwd = mkdtempSync(path.join(os.tmpdir(), 'cr-todo-hydrate-'));
  try {
    writeChatPlanFile({
      cwd: inputCwd,
      chatId: 'chat-hydrate',
      title: 'Plan mode',
      markdown: '- agent attribution plus concrete fixes.\n- ship the remaining plan items.',
    });
    const actualItem = hydrateTodoPlanMarkdown(
      {
        chatId: 'chat-hydrate',
        plan: { markdown: 'agent attribution plus concrete fixes.' },
      },
      inputCwd
    );
    assert.match(String(actualItem.plan?.markdown || ''), /^# Plan mode/);
    assert.match(String(actualItem.plan?.markdown || ''), /agent attribution/);
    assert.equal(String(actualItem.plan?.markdown || '').includes('cretli-chat-plan'), false);
  } finally {
    rmSync(inputCwd, { recursive: true, force: true });
  }
});

runCase('resolveTodoChats: joins every source and merges roles per chat', () => {
  const index = buildTodoChatIndex([
    { id: 'c-creator', title: 'Creator', agentTransport: 'opencode', updatedAt: '2026-01-01T00:00:00.000Z', workspaceFolder: '/ws/a' },
    { id: 'c-planner', title: 'Planner', agentTransport: 'sdk', updatedAt: '2026-01-02T00:00:00.000Z', workspaceFolder: '/ws/a' },
    { id: 'c-exec', title: 'Exec', agentTransport: 'sdk', updatedAt: '2026-01-03T00:00:00.000Z', workspaceFolder: '/ws/a' },
    { id: 'c-orch', title: 'Orch', agentTransport: 'sdk', updatedAt: '2025-12-31T00:00:00.000Z', workspaceFolder: '/ws/a' },
    { id: 'c-delegate', title: 'Delegate', agentTransport: 'opencode', updatedAt: '2026-01-04T00:00:00.000Z', workspaceFolder: '/ws/a', todoId: 'todo-1', delegationId: 'del-1' },
  ], { workspaceFolder: '/ws/a' });
  const chats = resolveTodoChats({
    id: 'todo-1',
    createdByChatId: 'c-creator',
    plan: { sourceChatId: 'c-planner' },
    chatId: 'c-exec',
    orchestratorChatId: 'c-orch',
    linkedChatIds: ['c-exec'],
    changelog: [{ kind: 'note', text: 'status: idea→doing', chatId: 'c-creator', at: '2026-01-05T00:00:00.000Z' }],
  }, index);
  assert.deepEqual(chats.map((row) => row.id), ['c-creator', 'c-delegate', 'c-exec', 'c-planner', 'c-orch']);
  const byId = new Map(chats.map((row) => [row.id, row]));
  assert.deepEqual(byId.get('c-creator').roles.sort(), ['creator', 'linked']);
  assert.equal(byId.get('c-creator').lastAt, '2026-01-05T00:00:00.000Z');
  assert.deepEqual(byId.get('c-delegate').roles.sort(), ['delegate', 'linked']);
  assert.deepEqual(byId.get('c-exec').roles.sort(), ['executor', 'linked']);
  assert.deepEqual(byId.get('c-planner').roles, ['planner']);
  assert.deepEqual(byId.get('c-orch').roles, ['orchestrator']);
  assert.equal(byId.get('c-creator').harness, 'opencode');
  assert.equal(byId.get('c-creator').deleted, false);
});

runCase('resolveTodoChats: missing chat is deleted with no title', () => {
  const chats = resolveTodoChats({
    id: 'todo-2',
    createdByChatId: 'chat-gone',
    linkedChatIds: ['chat-gone'],
  }, buildTodoChatIndex([]));
  assert.deepEqual(chats, [{
    id: 'chat-gone',
    title: '',
    harness: '',
    roles: ['creator', 'linked'],
    lastAt: '',
    deleted: true,
  }]);
});

runCase('resolveTodoChats: index filters chats to the workspace', () => {
  const index = buildTodoChatIndex([
    { id: 'c-local', title: 'Local', agentTransport: 'sdk', updatedAt: '2026-01-01T00:00:00.000Z', workspaceFolder: '/ws/a' },
    { id: 'c-foreign', title: 'Foreign', agentTransport: 'sdk', updatedAt: '2026-01-02T00:00:00.000Z', workspaceFolder: '/ws/b' },
  ], { workspaceFolder: '/ws/a' });
  const chats = resolveTodoChats({ id: 'todo-3', linkedChatIds: ['c-local', 'c-foreign'] }, index);
  const byId = new Map(chats.map((row) => [row.id, row]));
  assert.equal(byId.get('c-local').deleted, false);
  assert.equal(byId.get('c-foreign').deleted, true);
});

runCase('enrichTodoItemsWithSourceChat: exposes chats[] next to sourceChat', () => {
  const inputChats = [{ id: 'chat-1', title: 'Toolbar', agentTransport: 'opencode', updatedAt: '2026-01-01T00:00:00.000Z' }];
  const items = enrichTodoItemsWithSourceChat([{ id: 'todo-9', chatId: 'chat-1' }], inputChats);
  assert.equal(items[0].sourceChat.id, 'chat-1');
  assert.deepEqual(items[0].chats, [{
    id: 'chat-1',
    title: 'Toolbar',
    harness: 'opencode',
    roles: ['executor'],
    lastAt: '2026-01-01T00:00:00.000Z',
    deleted: false,
  }]);
});

process.exit(failed ? 1 : 0);
