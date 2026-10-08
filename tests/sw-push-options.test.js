/**
 * public/sw-push-options.js (loaded via node:vm like a service worker) plus the
 * public/sw.js wiring assertions.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public', 'sw-push-options.js'), 'utf8');
const context = { self: {} };
vm.createContext(context);
vm.runInContext(source, context);
const options = context.self.cretliPushOptions;
assert.ok(options, 'sw-push-options.js must expose cretliPushOptions');

/** Cross-realm arrays need a structural (JSON) comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// --- legacy payload without new fields: exactly the old pattern -------------
{
  const legacy = { title: 'Cretli', data: { type: 'agent-finished', chatId: 'c1' } };
  assert.deepEqual(plain(options.resolvePushVibrate(legacy)), [80, 40, 80]);
  assert.equal(options.resolvePushSilent(legacy), false);
  assert.equal(options.hasPushEventId(legacy), false);
  assert.equal(options.resolvePushRenotify(legacy, []), true);
  assert.equal(options.shouldPersistPushPayload(legacy), true);
}

// --- explicit empty marker and custom patterns ------------------------------
assert.deepEqual(plain(options.resolvePushVibrate({ vibrate: [] })), []);
assert.deepEqual(plain(options.resolvePushVibrate({ vibrate: [1, 2, 3] })), [1, 2, 3]);

// --- silent => no vibration --------------------------------------------------
assert.equal(options.resolvePushSilent({ silent: true }), true);
assert.deepEqual(plain(options.resolvePushVibrate({ silent: true, vibrate: [1] })), []);
assert.equal(options.resolvePushSilent({ silent: false }), false);

// --- renotify only for a NEW eventId -----------------------------------------
const payload = { data: { eventId: 'run-1' } };
assert.equal(options.resolvePushRenotify(payload, []), true);
assert.equal(options.resolvePushRenotify(payload, [{ data: { eventId: 'run-0' } }]), true);
assert.equal(options.resolvePushRenotify(payload, [{ data: { eventId: 'run-1' } }]), false);
assert.equal(
  options.resolvePushRenotify(payload, [{ data: {} }, { data: { eventId: 'run-1' } }]),
  false
);
// No eventId => legacy always-renotify.
assert.equal(options.resolvePushRenotify({ data: {} }, [{ data: { eventId: 'x' } }]), true);
assert.equal(options.resolvePushRenotify({}, [{ data: { eventId: 'x' } }]), true);
assert.equal(options.readPushEventId({ data: { eventId: '  run-7  ' } }), 'run-7');

// --- push-test never persists ------------------------------------------------
assert.equal(options.shouldPersistPushPayload({ data: { type: 'push-test' } }), false);
assert.equal(options.isPushTestPayload({ data: { type: 'push-test' } }), true);
assert.equal(options.shouldPersistPushPayload({ data: { type: 'agent-finished' } }), true);
assert.equal(options.shouldPersistPushPayload({}), true);
assert.equal(options.shouldPersistPushPayload(null), true);

// --- sw.js wiring + cache bump ----------------------------------------------
const swSource = readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
assert.match(swSource, /importScripts\('\/sw-push-options\.js'\)/);
assert.match(swSource, /CACHE_NAME = 'cretli-v29'/);
assert.match(swSource, /shouldPersistPushPayload\(payload\)/);
assert.match(swSource, /resolvePushRenotify\(payload, existing\)/);
assert.match(swSource, /getNotifications\(\{ tag \}\)/);
assert.match(swSource, /options\.silent = true/);
assert.match(swSource, /options\.vibrate = vibrate/);

console.log('sw-push-options.test.js: ok');
