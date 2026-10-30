/**
 * Model picker memoization: `buildCombinedModelPickerOptions` (through `syncSdkModeBarPicker`)
 * must return the same references while its inputs are unchanged, rebuild exactly when one
 * input of the matrix changes, and never assign fresh objects to the toolbar bar otherwise.
 */
import assert from 'node:assert/strict';

class FakeSelect {
  constructor() { this.options = []; this.value = 'sdk'; }
}
globalThis.HTMLSelectElement = FakeSelect;
const harnessSelect = new FakeSelect();
const documentElement = { lang: 'en' };
globalThis.document = {
  createTreeWalker: () => ({}), documentElement, body: { classList: { contains: () => false } },
  getElementById: (id) => (id === 'chat-new-harness-select' ? harnessSelect : null),
};

const state = await import('../app_front/features/chat/services/newChatHarnessState.js');
const { chatRuntime } = await import('../app_front/features/chat/state/chatRuntimeState.js');
const { newChatModalState } = await import('../app_front/features/chat/state/newChatModalState.js');
const { chatHost } = await import('../app_front/features/chat/services/chatHost.js');
const { buildNewChatModelOptions, encodeNewChatModelChoice, decodeNewChatModelChoice } = await import('../app_front/features/chat/newChatModelOptions.js');
const { t } = await import('../app_front/i18n/index.js');
const { resolveHarnessUiMeta } = await import('../app_front/core/harness/harnessUiRegistry.js');

const opt = (id, label = id) => ({ value: id, textContent: label, dataset: { baseLabel: label } });
let catalogs;
let disabled;
let presets;
let lockouts;
let errors;

/** Reset every input of the matrix to a known baseline. */
function reset() {
  state.localChatHarnessIds.clear();
  harnessSelect.options = [opt('sdk', 'Cursor'), opt('qwen', 'Qwen')];
  catalogs = {
    sdk: [{ value: 'auto', label: 'Auto' }, { value: 'composer-2', label: 'Composer 2' }],
    qwen: [{ value: 'qwen3-coder', label: 'Qwen3 Coder' }],
  };
  disabled = new Set();
  presets = [];
  lockouts = [];
  documentElement.lang = 'en';
  newChatModalState.newChatUsageCheckPending = false;
  state.setNewChatUsageLockoutsForTest(lockouts);
  state.setNewChatHarnessReadyCache('sdk', true);
  state.setNewChatHarnessReadyCache('qwen', true);
  state.newChatModelCatalogChecked.add('sdk');
  state.newChatModelCatalogChecked.add('qwen');
  state.applyNewChatHarnessStatus('qwen', true, '');
  state.resetCombinedModelPickerMemo();
}
chatRuntime.chatModelSelectApi = {
  getModelOptionsForHarness: (id) => catalogs[id] || [],
  isModelEnabled: (id, value) => !disabled.has(`${id}:${value}`),
};
chatHost.chatPresets = { getPresets: () => presets };

function makeBar() { return { harness: 'sdk' }; }

/** Reference build without memo, from the same inputs, via the plain option builder. */
function expectedOptions() {
  const harnesses = harnessSelect.options.map((o) => ({
    id: o.value, label: o.dataset.baseLabel,
    models: state.localChatHarnessIds.has(o.value)
      ? [{ value: 'auto', label: t('chat.newPluginDefault') }]
      : (catalogs[o.value] || []).map((m) => ({ ...m, settingsDisabled: disabled.has(`${o.value}:${m.value}`) })),
    ready: state.localChatHarnessIds.has(o.value) ? true : state.readHarnessReady(o.value),
    checking: !!state.newChatHarnessStatusTracker.getInFlight(o.value)
      || (!state.localChatHarnessIds.has(o.value) && !state.newChatModelCatalogChecked.has(o.value) && state.readHarnessReady(o.value) === null),
    error: errors[o.value] || t(resolveHarnessUiMeta(o.value).newChatErrorKey),
  }));
  return { harnesses, built: buildNewChatModelOptions(harnesses, lockouts, t, {
    limitsPending: newChatModalState.newChatUsageCheckPending, locale: documentElement.lang || undefined }) };
}

function strip(rows) {
  // Error strings differ per harness meta; compare the sortable/displayed fields only.
  return rows.map((r) => ({ value: r.value, label: r.label, disabled: r.disabled, status: r.status,
    description: r.description, group: r.group, favorite: r.favorite, favoriteable: r.favoriteable }));
}

function referenceRows() {
  const { built } = expectedOptions();
  const fav = new Set(presets.map((p) => encodeNewChatModelChoice(p.harness, p.model)));
  return built.map((row) => ({ ...row, favorite: fav.has(row.value),
    favoriteable: !!decodeNewChatModelChoice(row.value)?.model
      && !state.localChatHarnessIds.has(decodeNewChatModelChoice(row.value).harness) }));
}

/** Matrix: each row mutates exactly one input. */
const matrix = [
  ['harness list', () => { harnessSelect.options = [opt('sdk', 'Cursor'), opt('qwen', 'Qwen'), opt('codex', 'Codex')]; catalogs.codex = [{ value: 'gpt-5', label: 'GPT 5' }]; state.setNewChatHarnessReadyCache('codex', true); state.newChatModelCatalogChecked.add('codex'); }],
  ['harness label', () => { harnessSelect.options[1] = opt('qwen', 'Qwen Renamed'); }],
  ['model catalog', () => { catalogs.sdk = [...catalogs.sdk, { value: 'composer-3', label: 'Composer 3' }]; }],
  ['model enabled flag', () => { disabled.add('sdk:composer-2'); }],
  ['readiness', () => { state.setNewChatHarnessReadyCache('qwen', false); }],
  ['in-flight status check', () => { state.newChatHarnessStatusTracker.setInFlight('qwen', new Promise(() => {})); }],
  ['catalog checked', () => { state.setNewChatHarnessReadyCache('qwen', null); state.newChatModelCatalogChecked.delete('qwen'); }],
  ['harness error', () => { state.applyNewChatHarnessStatus('qwen', false, 'qwen broke'); errors.qwen = 'qwen broke'; }],
  ['usage lockouts', () => { lockouts = [{ harness: 'sdk', model: '', resetAt: new Date(Date.now() + 3600e3).toISOString() }]; state.setNewChatUsageLockoutsForTest(lockouts); }],
  ['limitsPending', () => { newChatModalState.newChatUsageCheckPending = true; }],
  ['locale', () => { documentElement.lang = 'pl'; }],
  // The sdk catalog equals the plugin default, so `favoriteable` flips. The serialized harness data
  // also changes shape (local rows carry no `settingsDisabled`), so this input cannot be isolated fully.
  ['local chat harness membership', () => { state.localChatHarnessIds.add('sdk'); },
    () => { catalogs.sdk = [{ value: 'auto', label: t('chat.newPluginDefault') }]; }],
  ['presets', () => { presets = [{ harness: 'sdk', model: 'composer-2' }]; }],
];

for (const [name, mutate, prepare] of matrix) {
  reset();
  errors = {};
  prepare?.();
  const bar = makeBar();
  state.syncSdkModeBarPicker(bar, null);
  const first = bar.pickerOptions;
  assert.ok(Array.isArray(first) && first.length > 0, `${name}: baseline options built`);
  assert.deepEqual(strip(first), strip(referenceRows()), `${name}: baseline equals unmemoized build`);

  state.syncSdkModeBarPicker(bar, null);
  assert.equal(bar.pickerOptions, first, `${name}: unchanged inputs keep the reference`);

  mutate();
  state.syncSdkModeBarPicker(bar, null);
  assert.notEqual(bar.pickerOptions, first, `${name}: changing only this input yields a new reference`);
  if (name === 'local chat harness membership') {
    assert.ok(first.some((r) => r.favoriteable) && bar.pickerOptions.every((r) => !r.favoriteable || !r.value.startsWith('["sdk"')),
      'membership change must flip favoriteable for the sdk rows');
  }
  const expected = referenceRows();
  assert.deepEqual(
    strip(bar.pickerOptions).map((r) => [r.value, r.label, r.disabled, r.status, r.favorite, r.favoriteable]),
    strip(expected).map((r) => [r.value, r.label, r.disabled, r.status, r.favorite, r.favoriteable]),
    `${name}: content equals unmemoized build`,
  );
  const after = bar.pickerOptions;
  state.syncSdkModeBarPicker(bar, null);
  assert.equal(bar.pickerOptions, after, `${name}: stable again after the change`);
  // Leave shared module state clean for the next row.
  state.newChatHarnessStatusTracker.clearInFlight?.('qwen');
}

// Second sync with an identical result assigns nothing new to the bar.
reset();
errors = {};
{
  const assigned = [];
  const target = { harness: 'sdk' };
  const bar = new Proxy(target, {
    set(obj, prop, value) { assigned.push(prop); obj[prop] = value; return true; },
  });
  state.syncSdkModeBarPicker(bar, null);
  const { pickerOptions, pickerLabels, pickerHarnessLabels } = target;
  assert.ok(pickerOptions && pickerLabels && pickerHarnessLabels);
  assigned.length = 0;
  state.syncSdkModeBarPicker(bar, null);
  assert.equal(target.pickerOptions, pickerOptions);
  assert.equal(target.pickerLabels, pickerLabels);
  assert.equal(target.pickerHarnessLabels, pickerHarnessLabels);
  assert.deepEqual(assigned.filter((p) => ['pickerOptions', 'pickerLabels', 'pickerHarnessLabels'].includes(p)), [],
    'second sync must not reassign picker objects');
}
console.log('new-chat-picker-memo.test.js ok');
