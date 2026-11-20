/**
 * New-chat Create button: a pending readiness check must not delay a plain chat (the server
 * verifies readiness at create time), while forks and known problems still block it.
 */
import assert from 'node:assert/strict';

class FakeSelect {
  constructor() { this.options = []; this.value = 'claude'; }
}
globalThis.HTMLSelectElement = FakeSelect;
const harnessSelect = new FakeSelect();
const elements = {
  'chat-new-harness-select': harnessSelect,
  'chat-new-model-select': { value: 'opus' },
  'chat-new-create': { disabled: false, setAttribute() {} },
  'chat-new-sdk-hint': { hidden: true, textContent: '', dataset: {} },
};
globalThis.document = {
  createTreeWalker: () => ({}), documentElement: { lang: 'en' }, body: { classList: { contains: () => false } },
  getElementById: (id) => elements[id] || null,
};

const state = await import('../app_front/features/chat/services/newChatHarnessState.js');
const { chatRuntime } = await import('../app_front/features/chat/state/chatRuntimeState.js');
const { newChatModalState } = await import('../app_front/features/chat/state/newChatModalState.js');
const { chatHost } = await import('../app_front/features/chat/services/chatHost.js');
const { t } = await import('../app_front/i18n/index.js');

chatHost.chatPresets = { getPresets: () => [] };
let models = [{ value: 'opus', label: 'Opus' }];
chatRuntime.chatModelSelectApi = { getModelOptionsForHarness: () => models };
const createBtn = elements['chat-new-create'];
const hint = elements['chat-new-sdk-hint'];
const tracker = state.newChatHarnessStatusTracker;
const lockout = { harness: 'claude', model: 'opus', code: 'usage_limit', resetAt: new Date(Date.now() + 3600e3).toISOString() };

function reset() {
  models = [{ value: 'opus', label: 'Opus' }];
  newChatModalState.forkSourceChatId = null;
  newChatModalState.chatCreateInFlight = false;
  newChatModalState.newChatUsageCheckPending = false;
  state.setNewChatUsageLockoutsForTest([]);
  state.setNewChatHarnessReadyCache('claude', null);
  tracker.clearInFlight('claude');
  tracker.selectHarness('claude');
}

reset();
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, false, 'unknown readiness with a pending check allows Create');
assert.equal(hint.textContent, '', 'a pending check shows no waiting text');

reset();
newChatModalState.newChatUsageCheckPending = true;
state.setNewChatHarnessReadyCache('claude', true);
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, false, 'a usage refresh never blocks Create');
assert.equal(hint.textContent, t('chat.newReady'));

reset();
models = [];
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, false, 'a catalog still loading does not block Create');

reset();
newChatModalState.forkSourceChatId = 'parent';
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, true, 'a fork has no server gate and waits for the check');
assert.equal(hint.textContent, t('chat.newChecking'));

reset();
state.setNewChatUsageLockoutsForTest([lockout]);
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, true, 'a known limit blocks Create');

reset();
state.setNewChatHarnessReadyCache('claude', false);
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, true, 'a known not-ready harness blocks Create');

reset();
tracker.markSelectionSettled('claude');
state.syncNewChatHarnessUi('claude');
assert.equal(createBtn.disabled, true, 'an unknown result after the check settled blocks Create');
assert.equal(hint.textContent, t('chat.newAvailabilityUnknown'));

console.log('new-chat-optimistic-create: ok');
