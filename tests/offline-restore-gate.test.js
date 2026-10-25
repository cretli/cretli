import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkExternalRestoreGeneration, createRestoreGate } from '../lib/backup/offline/restore-gate.js';
import { writeControlState } from '../lib/backup/offline/control-dir.js';
import { createChatHistoryAdapter } from '../lib/persist/chat-history-adapter.js';
import { appendChatHistoryEvents, deleteChatHistory, setChatHistoryAdapterForTests } from '../lib/persist/chat-history-service.js';

test('restore gate distinguishes legacy, missing, stale and current generations', () => {
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-restore-gate-'));
  const gate = createRestoreGate(controlDir);
  assert.equal(checkExternalRestoreGeneration(gate, undefined), null);
  writeControlState(controlDir, { datasetGeneration: 'restore-1', paused: false, fence: 1 });
  assert.equal(checkExternalRestoreGeneration(gate, undefined).body.code, 'generation_missing');
  assert.equal(checkExternalRestoreGeneration(gate, 'old').body.code, 'generation_stale');
  assert.equal(checkExternalRestoreGeneration(gate, 'restore-1'), null);
});

test('internal history service append/delete remains generation-independent', async () => {
  const calls = [];
  const backend = Object.fromEntries([
    ['loadChatHistory', async () => null], ['appendChatHistoryEvents', async (...args) => { calls.push(['append', args]); return { ok: true }; }],
    ['appendChatNotice', async () => ({ ok: true })], ['getChatHistorySince', async () => ({ ok: true })],
    ['getChatHistoryEvent', async () => ({ ok: true })], ['getChatHistoryPage', async () => ({ ok: true })],
    ['copyChatHistory', async () => ({ ok: true })], ['copyChatHistoryUntil', async () => ({ ok: true })],
    ['deleteChatHistory', async (...args) => { calls.push(['delete', args]); return { ok: true }; }],
    ['listChatHistoryHeadSeqs', async () => []], ['getChatHistoryUsage', async () => ({})],
  ]);
  setChatHistoryAdapterForTests(createChatHistoryAdapter({ backend, kind: 'legacy' }));
  try {
    await appendChatHistoryEvents('chat-1', 'session-1', [], {});
    await deleteChatHistory('chat-1');
    assert.deepEqual(calls.map(([kind]) => kind), ['append', 'delete']);
  } finally {
    setChatHistoryAdapterForTests(null);
  }
});

test('frontend sends restoreGeneration and refreshes once after stale rejection', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  let settingsCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('/api/settings')) {
      settingsCalls += 1;
      return { status: 200, ok: true, json: async () => ({ ok: true, restoreGeneration: settingsCalls === 1 ? 'restore-1' : 'restore-2' }) };
    }
    if (requests.filter((entry) => entry.url.includes('/history')).length === 1) {
      return { status: 409, ok: false, json: async () => ({ ok: false, code: 'generation_stale' }) };
    }
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  try {
    const api = await import('../app_front/core/api/index.js');
    await api.getSettings();
    const result = await api.postChatHistory('chat-1', 'session-1', [], {});
    assert.equal(result.ok, true);
    assert.equal(settingsCalls, 2, 'one refresh after the stale response');
    const historyRequests = requests.filter((entry) => entry.url.includes('/history'));
    assert.equal(JSON.parse(historyRequests[0].init.body).restoreGeneration, 'restore-1');
    assert.equal(JSON.parse(historyRequests[1].init.body).restoreGeneration, 'restore-2');
    await api.deleteChat('chat-1');
    const deleteRequest = requests.at(-1);
    assert.match(deleteRequest.url, /restoreGeneration=restore-2/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
