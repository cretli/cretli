import assert from 'node:assert/strict';
import {
  beginSdkOpenTerminalHydration,
  clearSdkOpenTerminalHydrating,
  finishSdkHistoryHydration,
  isSdkOpenTerminalHydrating,
} from '../app_front/features/chat/sdkEventReplayGuard.js';

const chat = {};

beginSdkOpenTerminalHydration(chat);
assert.equal(chat._sdkHistoryHydrating, true);
assert.equal(isSdkOpenTerminalHydrating(chat), true);

clearSdkOpenTerminalHydrating(chat);
assert.equal(isSdkOpenTerminalHydrating(chat), false);
assert.equal(chat._sdkHistoryHydrating, true, 'Open-terminal flag must not end SDK hydration');

finishSdkHistoryHydration(chat, []);
assert.equal(chat._sdkHistoryHydrating, false);

console.log('All sdk-open-terminal-hydration tests passed.');
