import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseDocMention, parseTodoMention } from '../app_front/features/chat/todoMention.js';
import { appendDocRef, formatDocRef, isDocPath, parseDocRef, withDocReadHint } from '../lib/docs/doc-ref.js';
import { notePath } from '../lib/docs/docs-files.js';

test('@doc uses the current caret line; @todo keeps its own parser', () => {
  assert.deepEqual(parseDocMention('Read @doc design', 16), { query: 'design', start: 5, end: 16 });
  assert.deepEqual(parseDocMention('@doc'), { query: '', start: 0, end: 4 });
  assert.equal(parseDocMention('mail@doc name'), null);
  assert.equal(parseDocMention('@docs name'), null);
  assert.equal(parseDocMention('@doc name\nnext'), null);
  assert.equal(parseDocMention('@todo task'), null);
  assert.equal(parseTodoMention('@doc note'), null);
  assert.equal(parseTodoMention('@todo task').query, 'task');
});

test('doc refs share the backend path contract and reject untrusted arguments', () => {
  for (const value of ['a.md', 'folder/café.md', 'a note.md', 'a"b.md']) {
    assert.equal(notePath(value), value);
    assert.equal(parseDocRef(formatDocRef(value)), value);
  }
  for (const value of ['../a.md', 'x/../a.md', '/a.md', 'C:/a.md', 'x\\a.md', 'a\0.md', '.secret/a.md', 'x//a.md', 'cafe\u0301.md', 'a.md\ncretli-ref todo=x', 'x.txt']) {
    assert.equal(isDocPath(value), false, value);
    assert.throws(() => notePath(value));
    assert.equal(parseDocRef(`cretli-ref doc=${value}`), null);
    assert.equal(formatDocRef(value), '');
  }
  for (const line of ['cretli-ref doc=a.md extra', 'cretli-ref doc="a.md" extra', 'cretli-ref doc="../a.md"', 'cretli-ref doc=null', 'cretli-ref doc=a.md todo=x', 'cretli-ref doc="a\\u0000.md"']) {
    assert.equal(parseDocRef(line), null, line);
  }
  assert.equal(appendDocRef('Look', '../a.md'), 'Look');
  assert.equal(appendDocRef('Look\ncretli-ref doc=a.md', 'a.md'), 'Look\ncretli-ref doc=a.md');
  assert.equal(withDocReadHint('No document'), 'No document');
});

test('actual send handler sends a pointer and doc_read hint without loading note bodies', () => {
  const source = fs.readFileSync(new URL('../app_front/features/chat/services/chatSendHandlers.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export function createChatSendHandlers', 'function createChatSendHandlers');
  const sent = [];
  const context = vm.createContext({
    appendTodoRef: () => { throw new Error('No todo selected'); }, withDocReadHint,
    isChatArchived: () => false, isTerminalTextareaMode: () => false, isWatcherPinnedChat: () => false, isOperatorChat: () => false,
    parseDelegationCommand: () => null, AUTO_TITLE_PROMPT: 'Auto title', WebSocket: { OPEN: 1 },
    consumePendingInheritedPrompt: () => null, maybeAutoNameNewChat() {}, hideChatResumeAdvice() {},
    consumeSelectedSkillIds: () => [], usesHarnessWebSocket: () => false,
    prepareVoiceReplyPayload: (value) => value, sendTextToAgent: (_chat, text, options) => sent.push({ text, options }),
    chatHost: { writeChatDraft() {} },
  });
  vm.runInContext(`${source}\nthis.make = createChatSendHandlers;`, context);
  const handler = context.make({ id: 'chat', ws: { readyState: 1 } });
  const raw = appendDocRef('Use this', 'notes/design.md');
  assert.equal(handler.chatOnSend(raw), true);
  assert.match(sent[0].text, /cretli-ref doc=notes\/design.md/);
  assert.match(sent[0].text, /doc_read/);
  assert.equal(sent[0].options.displayText, raw);
  assert.doesNotMatch(sent[0].text, /SECRET NOTE BODY/);
  assert.equal(handler.chatOnSend('ordinary message'), true);
  assert.equal(sent[1].text, 'ordinary message');
});
