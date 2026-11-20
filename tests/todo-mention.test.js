import assert from 'node:assert/strict';
import {
  appendTodoRef,
  extractTodoRefsFromMessage,
  buildTodoMentionRows,
  filterTodoMentionItems,
  parseTodoMention,
  removeTodoMention,
  resolveTodoContinueBlock,
  todoStatusLabelKey,
} from '../app_front/features/chat/todoMention.js';

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

const TODO_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

runCase('parseTodoMention: token at caret', () => {
  const text = 'zrob @todo';
  assert.deepEqual(parseTodoMention(text, text.length), {
    query: '',
    start: 5,
    end: text.length,
  });
});

runCase('parseTodoMention: query filters the title', () => {
  const text = 'zrob @todo login';
  assert.deepEqual(parseTodoMention(text, text.length), {
    query: 'login',
    start: 5,
    end: text.length,
  });
});

runCase('parseTodoMention: ignores a token away from the caret', () => {
  const text = '@todo login\nnext line';
  assert.equal(parseTodoMention(text, text.length), null);
});

runCase('parseTodoMention: does not match a longer word', () => {
  const text = '@todolist';
  assert.equal(parseTodoMention(text, text.length), null);
});

runCase('removeTodoMention: drops the token and keeps surrounding words', () => {
  const text = 'hello @todo login please';
  const mention = parseTodoMention(text, 'hello @todo login'.length);
  const actual = removeTodoMention(text, mention);
  assert.equal(actual.text, 'hello please');
  assert.equal(actual.caret, 'hello '.length);
});

runCase('appendTodoRef: adds one pointer line', () => {
  const once = appendTodoRef('popraw pasek', TODO_ID);
  assert.equal(once, `popraw pasek\ncretli-ref todo=${TODO_ID}`);
  assert.equal(appendTodoRef(once, TODO_ID), once);
  assert.equal(appendTodoRef('  ', TODO_ID), `cretli-ref todo=${TODO_ID}`);
  assert.equal(appendTodoRef('tekst', 'short'), 'tekst');
});

runCase('extractTodoRefsFromMessage: separates a glued pointer', () => {
  const glued = extractTodoRefsFromMessage(`Kontynuuj to zadanie.cretli-ref todo=${TODO_ID}`);
  assert.deepEqual(glued.todoIds, [TODO_ID]);
  assert.equal(glued.text, 'Kontynuuj to zadanie.');
  const lined = extractTodoRefsFromMessage(`notatka\ncretli-ref todo=${TODO_ID}`);
  assert.equal(lined.text, 'notatka');
  assert.deepEqual(lined.todoIds, [TODO_ID]);
});

runCase('filterTodoMentionItems: status and title', () => {
  const items = [
    { id: '1', title: 'Login form', status: 'ready' },
    { id: '2', title: 'Old login', status: 'done' },
    { id: '3', title: 'Notes', status: 'doing' },
  ];
  const active = filterTodoMentionItems(items, { query: 'login', statuses: ['ready', 'doing'] });
  assert.deepEqual(active.map((item) => item.id), ['1']);
  const all = filterTodoMentionItems(items, { query: '', statuses: null });
  assert.equal(all.length, 3);
});

runCase('buildTodoMentionRows: indents children and keeps a done parent', () => {
  const items = [
    { id: 'parent', title: 'Ship picker', status: 'done', parentId: '' },
    { id: 'child', title: 'Indent rows', status: 'ready', parentId: 'parent' },
    { id: 'other', title: 'Unrelated', status: 'idea', parentId: '' },
    { id: 'finished', title: 'Already shipped', status: 'done', parentId: '' },
  ];
  const openRows = buildTodoMentionRows(items, { statuses: ['idea', 'ready', 'doing'] });
  assert.deepEqual(openRows.map((row) => [row.item.id, row.level]), [
    ['parent', 0],
    ['child', 1],
    ['other', 0],
  ]);
  const titled = buildTodoMentionRows(items, { query: 'indent' });
  assert.deepEqual(titled.map((row) => row.item.id), ['parent', 'child']);
});

runCase('resolveTodoContinueBlock: busy chat and its subchat hold the todo', () => {
  const chats = [
    { id: 'parent', title: 'Plan', todoId: 'todo-1' },
    { id: 'child', title: 'Implement', forkParentChatId: 'parent' },
    { id: 'other', title: 'Side', todoId: 'todo-1' },
  ];
  const busyChild = resolveTodoContinueBlock({
    todoId: 'todo-1',
    currentChatId: 'other',
    chats,
    isBusy: (chat) => chat.id === 'child',
  });
  assert.equal(busyChild?.chatId, 'child');
  const idle = resolveTodoContinueBlock({
    todoId: 'todo-1',
    currentChatId: 'other',
    chats,
    isBusy: () => false,
  });
  assert.equal(idle, null);
  const sameChat = resolveTodoContinueBlock({
    todoId: 'todo-1',
    currentChatId: 'parent',
    chats,
    isBusy: (chat) => chat.id === 'parent',
  });
  assert.equal(sameChat, null);
});

runCase('todoStatusLabelKey: known statuses only', () => {
  assert.equal(todoStatusLabelKey('doing'), 'todo.statusDoing');
  assert.equal(todoStatusLabelKey('nope'), '');
});

if (failed > 0) {
  console.error(`${failed} failed`);
  process.exit(1);
}
