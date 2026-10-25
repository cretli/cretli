import assert from 'node:assert/strict';
import {
  appendFreezeLogEntry,
  clearPersistedFreezeLogs,
  FREEZE_LOG_BUFFER_LS_KEY,
  getOrCreateFreezeSessionId,
  readPreviousSessionFreezeEntries,
  rotateFreezeSessionId,
} from '../app_front/lib/freezeLogPersist.js';

const storage = new Map();

globalThis.localStorage = {
  getItem(key) {
    return storage.has(key) ? storage.get(key) : null;
  },
  setItem(key, value) {
    storage.set(key, String(value));
  },
  removeItem(key) {
    storage.delete(key);
  },
};

storage.clear();
const sessionA = getOrCreateFreezeSessionId();
appendFreezeLogEntry({
  ts: Date.now(),
  timeStr: '10:00:00.000',
  tag: 'ui-freeze-perf',
  text: 'main thread stall {"driftMs":900}',
});
appendFreezeLogEntry({
  ts: Date.now(),
  timeStr: '10:00:01.000',
  tag: 'chat-ws',
  text: 'socket opened',
});

rotateFreezeSessionId();
const sessionB = getOrCreateFreezeSessionId();
assert.notEqual(sessionA, sessionB);

const restored = readPreviousSessionFreezeEntries(sessionB);
assert.equal(restored.length, 2);

clearPersistedFreezeLogs();
assert.equal(storage.has(FREEZE_LOG_BUFFER_LS_KEY), false);

appendFreezeLogEntry({
  ts: Date.now(),
  timeStr: '10:00:02.000',
  tag: 'chat-sync',
  text: 'resume catch-up complete',
});
assert.equal(storage.has(FREEZE_LOG_BUFFER_LS_KEY), true);

console.log('freeze-log-persist.test.js: ok');
