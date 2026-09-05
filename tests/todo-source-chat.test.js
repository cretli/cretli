import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { writeChatPlanFile } from '../lib/chat-plan-persist.js';
import {
  enrichTodoItemsWithSourceChat,
  hydrateTodoPlanMarkdown,
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

process.exit(failed ? 1 : 0);
