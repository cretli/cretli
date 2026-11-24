import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadFunctions(file, names, dependencies) {
  const source = readFileSync(new URL(`../app_front/features/chat/services/${file}`, import.meta.url), 'utf8');
  const context = vm.createContext(dependencies);
  for (const name of names) {
    const start = source.indexOf(`export function ${name}(`);
    const tail = source.slice(start);
    const end = tail.indexOf('\nexport ', 1);
    vm.runInContext((end < 0 ? tail : tail.slice(0, end)).replace(/^export /, ''), context);
  }
  return context;
}

test('A to B to A saves the outgoing viewport before hiding and rejects a stale show callback', () => {
  const scheduled = [];
  const restored = [];
  const positions = { a: 120, b: 480 };
  const runtime = { activeChatId: 'a', chatDiagnosticsApi: { stopChatContextUsageSync() {}, startChatContextUsageSync() {} } };
  const chats = ['a', 'b'].map((id) => ({ id, _sdkHistoryHydrating: true, _sdkRichView: {
    getViewportSnapshot: () => ({ following: id === 'b', scrollTop: positions[id] }),
    restoreViewportSnapshot: (snapshot) => restored.push({ id, ...snapshot }),
  } }));
  const noop = () => {};
  const deps = {
    chats, chatRuntime: runtime,
    reportViewContextResourceConflict: () => ({ ok: true }),
    retainMountedChatPanes: () => { positions[runtime.activeChatId] = 0; },
    chatHost: { recordChatLastUsed: noop, recordChatActivity: noop, openTerminal: noop,
      chatController: { selectChat: (id) => { runtime.activeChatId = id; } } },
    setTimeout: (callback) => scheduled.push(callback),
    syncSdkHistoryOnResume: () => Promise.resolve(),
  };
  for (const name of ['setEmbedNoChatState', 'notifySidebarSelectionOnly', 'scheduleChatListStateRefresh',
    'markChatOpened', 'scheduleChatSendBarReserveSync', 'alignActiveWorkspaceWithChat', 'syncChatTodoChip',
    'checkChatResumeAdvice', 'requestWidgetChatBinding', 'syncWidgetPinUrlUi', 'syncArchiveMenuUi',
    'syncChatSdkModeUi', 'renderChatTerminalState', 'applyPinnedChatModeUi', 'syncArchivedChatSendUi']) deps[name] = noop;
  const ctx = loadFunctions('chatSelection.js', ['performSelectChatBody'], deps);
  ctx.performSelectChatBody('b');
  ctx.performSelectChatBody('a');
  for (const callback of scheduled) callback();
  assert.deepEqual(restored.map(({ id, following, scrollTop }) => ({ id, following, scrollTop })), [
    { id: 'a', following: false, scrollTop: 120 },
  ]);
  assert.equal(chats[1]._chatViewportSnapshot.scrollTop, 480);
});

test('resume convergence reads the real viewport API, including a saved hidden position', () => {
  const ctx = loadFunctions('chatHistorySync.js', ['resolveChatDraftAndScroll'], {
    document: { getElementById: () => ({ value: 'my draft' }) },
  });
  const result = ctx.resolveChatDraftAndScroll({ _sdkRichView: { getViewportSnapshot: () => ({ following: false, scrollTop: 321 }) } });
  assert.equal(result.draftText, 'my draft');
  assert.equal(result.scrollTop, 321);
});

test('server prompt and queue echoes respect reading while optimistic send explicitly follows', () => {
  const calls = [];
  const chat = { _sdkRichView: {
    appendUserPrompt: (text, opts) => calls.push({ kind: 'user', text, force: opts.forceScroll }),
    appendQueuedPrompt: (text, _pos, opts) => calls.push({ kind: 'queue', text, force: opts.forceScroll }),
  } };
  const ctx = loadFunctions('sdkHistoryQueue.js', ['appendSdkUserPromptLine', 'appendSdkQueuedPromptLine', 'appendOptimisticSdkPrompt'], {
    resolveInheritedPromptEcho: (text) => text, inheritedPromptLabels: () => ({}),
    getChatSpeaker: () => ({ resetAnswer() {} }), chatHost: { processAgentOutput() {} },
    t: () => 'queued', allowSdkLiveEventsDuringHydration() {},
    ensureSdkOptimisticPromptState: (target) => { target._sdkOptimisticSentNow ||= []; target._sdkOptimisticSentQueued ||= []; },
  });
  ctx.appendSdkUserPromptLine(chat, 'remote');
  ctx.appendSdkQueuedPromptLine(chat, 'remote queue', 1);
  ctx.appendOptimisticSdkPrompt(chat, 'own send');
  chat._sdkServerBusy = true;
  ctx.appendOptimisticSdkPrompt(chat, 'own queued send');
  assert.deepEqual(calls, [
    { kind: 'user', text: 'remote', force: false },
    { kind: 'queue', text: 'remote queue', force: false },
    { kind: 'user', text: 'own send', force: true },
    { kind: 'queue', text: 'own queued send', force: true },
  ]);
});
