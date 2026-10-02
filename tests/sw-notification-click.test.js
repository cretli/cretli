import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// sw.js is registered as a classic worker, so the shared policy is a plain
// classic script. Load it the way importScripts would.
const filePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/sw-notification-click.js'
);
const source = readFileSync(filePath, 'utf8');
const context = { self: {}, URL };
vm.createContext(context);
vm.runInContext(source, context);
const policy = context.self.cretliNotificationClickPolicy;
assert.ok(policy, 'sw-notification-click.js must expose the policy on self');
const { canHandleOpenChatMessage, readChatIdFromUrl, resolveNotificationClickAction } = policy;

// Decision objects are created in the vm realm, so compare them structurally
// through JSON to avoid cross-realm prototype mismatches.
function expectDecision(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

const ORIGIN = 'https://cretli.example';
const APP_URL = `${ORIGIN}/?source=pwa&panel=chat&chat=abc`;
const CHAT_URL = `${ORIGIN}/?source=pwa&panel=chat&chat=abc`;

assert.equal(canHandleOpenChatMessage(APP_URL, ORIGIN), true);
assert.equal(canHandleOpenChatMessage(`${ORIGIN}/login`, ORIGIN), false);
assert.equal(canHandleOpenChatMessage(`${ORIGIN}/login?next=%2F`, ORIGIN), false);
assert.equal(canHandleOpenChatMessage(`${ORIGIN}/login.html`, ORIGIN), false);
assert.equal(canHandleOpenChatMessage(`${ORIGIN}/offline.html`, ORIGIN), false);
assert.equal(canHandleOpenChatMessage('https://other.example/', ORIGIN), false);
assert.equal(canHandleOpenChatMessage('', ORIGIN), false);
assert.equal(canHandleOpenChatMessage('not a url', ORIGIN), false);

assert.equal(readChatIdFromUrl('/?source=pwa&panel=chat&chat=abc', ORIGIN), 'abc');
assert.equal(readChatIdFromUrl(`${ORIGIN}/?panel=chat&chat=a%20b`, ORIGIN), 'a b');
assert.equal(readChatIdFromUrl('/?source=pwa&panel=chat', ORIGIN), '');
assert.equal(readChatIdFromUrl('', ORIGIN), '');
assert.equal(readChatIdFromUrl('not a url', ORIGIN), '');

expectDecision(
  resolveNotificationClickAction({
    clients: [],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }),
  { action: 'openWindow', clientIndex: -1, url: CHAT_URL, chatId: 'abc', reason: 'no-client' }
);

expectDecision(
  resolveNotificationClickAction({
    clients: [{ url: APP_URL, canFocus: true, canPostMessage: true, canNavigate: true }],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }),
  {
    action: 'postMessage',
    clientIndex: 0,
    url: CHAT_URL,
    chatId: 'abc',
    reason: 'app-client',
  }
);

expectDecision(
  resolveNotificationClickAction({
    clients: [
      { url: `${ORIGIN}/login`, canFocus: true, canPostMessage: true, canNavigate: true },
      { url: APP_URL, canFocus: true, canPostMessage: true, canNavigate: true },
    ],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }),
  {
    action: 'postMessage',
    clientIndex: 1,
    url: CHAT_URL,
    chatId: 'abc',
    reason: 'app-client',
  },
  'Skip the login page and pick the app window'
);

assert.equal(
  resolveNotificationClickAction({
    clients: [{ url: `${ORIGIN}/login`, canFocus: true, canPostMessage: true, canNavigate: true }],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }).action,
  'navigate',
  'A same-origin non-app window falls back to navigate'
);

assert.equal(
  resolveNotificationClickAction({
    clients: [{ url: APP_URL, canFocus: true, canPostMessage: false, canNavigate: true }],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }).action,
  'navigate',
  'A window without postMessage cannot be switched in place'
);

assert.equal(
  resolveNotificationClickAction({
    clients: [{ url: 'https://other.example/', canFocus: true, canPostMessage: true }],
    targetUrl: CHAT_URL,
    chatId: 'abc',
    origin: ORIGIN,
  }).action,
  'openWindow',
  'A window on another origin is not reused'
);

assert.equal(
  resolveNotificationClickAction({ clients: [], targetUrl: CHAT_URL, chatId: 'abc' }).action,
  'openWindow',
  'Missing origin still resolves without throwing'
);

console.log('All sw-notification-click tests passed.');
