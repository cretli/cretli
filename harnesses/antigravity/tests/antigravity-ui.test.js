import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runRichViewScenario } from '../../../tests/helpers/rich-view-chromium.js';

test('model settings share grouped rows, search, favorites and preserve unsaved selections (Chromium)', { timeout: 120000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const base = new URL('/', viewUrl);
    document.getElementById('mount').innerHTML = `
      <input id="antigravity-models-search"><input id="antigravity-models-sort">
      <div id="antigravity-models-list"></div><p id="antigravity-models-summary"></p>
      <button id="antigravity-models-toggle-all"></button><button id="antigravity-models-clear"></button>`;
    const panel = await import(new URL('harnesses/antigravity/model-settings.js', base));
    const rows = [
      { value: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', group: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', group: 'Gemini 3.8 Flash' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Claude Sonnet 4.6' },
    ];
    panel.setModelCatalog(rows, rows.map((row) => row.value));
    panel.initModelPanel();
    panel.initModelPanel();
    panel.renderModelPanel();
    const groups = [...document.querySelectorAll('.chat-model-settings-group-title')].map((node) => node.textContent);
    const providers = [...document.querySelectorAll('.chat-model-settings-provider-name')].map((node) => node.textContent);
    const favorites = document.querySelectorAll('.model-favorite-toggle').length;
    document.querySelector('.model-favorite-toggle').click();
    const activeFavorites = document.querySelectorAll('.model-favorite-toggle.is-active').length;
    const first = document.querySelector('#antigravity-models-list input[value="gemini-3.8-flash-high"]');
    first.click();
    const afterEdit = panel.getSelectedModels();
    const search = document.getElementById('antigravity-models-search');
    search.value = 'Claude';
    search.dispatchEvent(new Event('input'));
    const filteredRows = document.querySelectorAll('#antigravity-models-list input').length;
    panel.setModelCatalog(rows, rows.map((row) => row.value));
    const afterRefresh = panel.getSelectedModels();
    document.getElementById('antigravity-models-clear').click();
    const afterClear = panel.getSelectedModels();
    document.getElementById('antigravity-models-toggle-all').click();
    return { groups, providers, favorites, activeFavorites, filteredRows, afterEdit, afterRefresh, afterClear, afterAll: panel.getSelectedModels() };
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result.groups.sort(), ['Claude Sonnet 4.6', 'Gemini 3.8 Flash']);
  assert.deepEqual(result.providers.sort(), ['Anthropic', 'Google']);
  assert.equal(result.favorites, 3);
  assert.equal(result.activeFavorites, 1);
  assert.equal(result.filteredRows, 1);
  assert.equal(result.afterEdit.length, 2);
  assert.deepEqual(result.afterRefresh, result.afterEdit);
  assert.deepEqual(result.afterClear, []);
  assert.equal(result.afterAll.length, 3);
});

test('Antigravity prompt start consumes the optimistic echo once, including after history replay (Chromium)', { timeout: 120000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const { handleSdkPromptLifecycleMessage } = await import(new URL('app_front/features/chat/transport/sdkPromptLifecycle.js', new URL('/', viewUrl)));
    const mount = document.getElementById('mount');
    const chat = { id: 'antigravity-echo', agentTransport: 'antigravity', _sdkLastLocalUserEcho: 'hej' };
    const view = createSdkRichView(chat, mount, { appendPlain() {} });
    view.appendUserPrompt('hej');
    const userEvent = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hej' }] } };
    handleSdkPromptLifecycleMessage(chat, { type: 'sdkPromptStarted', text: 'hej', fromQueue: false, remaining: 0 }, {
      setAgentState() {}, logSdkVerbose() {}, consumeOptimisticSdkPrompt: (_chat, text) => text === 'hej',
      consumeOptimisticSdkQueuedPrompt: () => false, appendSdkUserPromptLine: (_chat, text) => { chat._sdkLastLocalUserEcho = text; view.appendUserPrompt(text); },
    });
    view.applyEvent(userEvent);
    const liveCount = [...mount.querySelectorAll('cr-sdk-block')].filter((node) => node.variant === 'user').length;
    await view.replayHistoryRecords([
      { kind: 'localUser', text: 'hej', historySeq: 1 },
      { kind: 'sdk', event: userEvent, historySeq: 2 },
    ], { instant: true, source: 'test' });
    const replayCount = [...mount.querySelectorAll('cr-sdk-block')].filter((node) => node.variant === 'user').length;
    view.destroy();
    return { liveCount, replayCount };
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result, { liveCount: 1, replayCount: 1 });
});
