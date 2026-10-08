/**
 * public/sw-in-app-signal.js (loaded via node:vm like a service worker) plus
 * the public/sw.js wiring that delegates a background signal to a visible page
 * and only silences the notification after the page confirms it handled it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public', 'sw-in-app-signal.js'), 'utf8');
const context = { self: {}, URL };
vm.createContext(context);
vm.runInContext(source, context);
const signal = context.self.cretliInAppSignal;
assert.ok(signal, 'sw-in-app-signal.js must expose cretliInAppSignal');

/** Cross-realm arrays/objects need a structural (JSON) comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- eventId / event type ----------------------------------------------------
assert.equal(signal.readSignalEventId({ data: { eventId: '  run-7  ' } }), 'run-7');
assert.equal(signal.readSignalEventId({ data: {} }), '');
assert.equal(signal.readSignalEventId({}), '');

assert.equal(signal.resolveSignalEventType({ data: { type: 'agent-finished' } }), 'finished');
assert.equal(
  signal.resolveSignalEventType({ data: { type: 'agent-needs-input', kind: 'question' } }),
  'question'
);
assert.equal(
  signal.resolveSignalEventType({ data: { type: 'agent-needs-input', kind: 'permission' } }),
  'permission'
);
assert.equal(signal.resolveSignalEventType({ data: { type: 'opencode_permission' } }), 'permission');
assert.equal(signal.resolveSignalEventType({ data: { type: 'chat-created' } }), 'newChat');
assert.equal(signal.resolveSignalEventType({ data: { type: 'unknown' } }), '');

// --- app-window URL filter ---------------------------------------------------
assert.equal(signal.isAppClientUrl('https://x.test/'), true);
assert.equal(signal.isAppClientUrl('https://x.test/chat/abc'), true);
assert.equal(signal.isAppClientUrl('https://x.test/login'), false);
assert.equal(signal.isAppClientUrl('https://x.test/login?next=/'), false);
assert.equal(signal.isAppClientUrl('https://x.test/offline.html'), false);
assert.equal(signal.isAppClientUrl(''), true, 'unknown url is treated as app');

// --- delegating to a visible app window --------------------------------------
const visible = signal.resolveClientSignal({
  payload: { data: { type: 'agent-finished', eventId: 'run-1', chatId: 'c1' } },
  clients: [
    { url: 'https://x.test/', visibilityState: 'hidden', focused: false },
    { url: 'https://x.test/chat/c1', visibilityState: 'visible', focused: true },
  ],
});
assert.equal(visible.post, true);
assert.equal(visible.clientIndex, 1);
assert.equal(visible.eventType, 'finished');
// Vibration suppression is decided later, by the page's handled reply.
assert.equal(visible.suppressVibrate, false);

const focusedOnly = signal.resolveClientSignal({
  payload: { data: { type: 'agent-finished', eventId: 'run-1' } },
  clients: [{ url: 'https://x.test/', visibilityState: 'hidden', focused: true }],
});
assert.equal(focusedOnly.post, true, 'a focused (but not reported visible) window still owns the signal');

const background = signal.resolveClientSignal({
  payload: { data: { type: 'agent-finished', eventId: 'run-2' } },
  clients: [{ url: 'https://x.test/', visibilityState: 'hidden', focused: false }],
});
assert.equal(background.post, false);
assert.equal(background.reason, 'no-visible-client');

// A visible login/offline page must not swallow the notification vibration.
const loginOnly = signal.resolveClientSignal({
  payload: { data: { type: 'agent-finished', eventId: 'run-3' } },
  clients: [{ url: 'https://x.test/login', visibilityState: 'visible', focused: true }],
});
assert.equal(loginOnly.post, false);
assert.equal(loginOnly.reason, 'no-visible-client');

const noEvent = signal.resolveClientSignal({
  payload: { data: { type: 'agent-finished' } },
  clients: [{ url: 'https://x.test/', visibilityState: 'visible', focused: true }],
});
assert.equal(noEvent.post, false);
assert.equal(noEvent.reason, 'no-signal-event');

// --- client message ----------------------------------------------------------
assert.deepEqual(
  plain(signal.buildClientMessage({ data: { type: 'agent-finished', eventId: 'run-9', chatId: 'c9' } })),
  { type: 'cretli-in-app-signal', eventId: 'run-9', eventType: 'finished', chatId: 'c9' }
);

// --- public/sw.js wiring -----------------------------------------------------
const swSource = readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
assert.match(swSource, /importScripts\('\/sw-in-app-signal\.js'\)/);
assert.match(swSource, /self\.cretliInAppSignal/);
assert.match(swSource, /signalPolicy\.resolveClientSignal/);
// The client URL must reach the filter, otherwise a visible /login or
// /offline.html window would be picked and suppress the OS vibration.
assert.match(swSource, /url: client\.url/);
assert.match(swSource, /function requestClientSignalHandled/);
assert.match(swSource, /new MessageChannel\(\)/);
assert.match(swSource, /requestClientSignalHandled\(\s*client,/);
assert.match(swSource, /clientSignal\.suppressVibrate/);
assert.match(swSource, /options\.silent = true/);

console.log('sw-in-app-signal tests passed');
