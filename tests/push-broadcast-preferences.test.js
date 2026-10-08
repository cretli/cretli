/**
 * Per-endpoint event filter and per-endpoint NotificationOptions in
 * lib/push.js `broadcastPush`. Temp data dir + monkeypatched web-push sender.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-push-broadcast-prefs-'));
process.env.CRETLI_DATA_DIR = dataDir;
const subsFile = path.join(dataDir, 'push-subscriptions.json');

const webPush = (await import('web-push')).default;
const sentCalls = [];
webPush.sendNotification = async (sub, payload, options) => {
  sentCalls.push({ endpoint: sub.endpoint, parsed: JSON.parse(payload), options });
};

const {
  addSubscription,
  broadcastPush,
  resolvePushPreferenceEvent,
} = await import('../lib/push.js');

const A = 'https://push.example/a';
const B = 'https://push.example/b';
const C = 'https://push.example/c';

function readSubs() {
  try {
    return JSON.parse(readFileSync(subsFile, 'utf8'));
  } catch {
    return [];
  }
}

// --- payload -> preference event mapping -----------------------------------
assert.equal(resolvePushPreferenceEvent({ data: { type: 'agent-finished', status: 'error' } }), 'finished');
assert.equal(
  resolvePushPreferenceEvent({ data: { type: 'agent-finished', status: 'plan_guard_cancelled' } }),
  'finished'
);
assert.equal(
  resolvePushPreferenceEvent({ data: { type: 'agent-needs-input', kind: 'question' } }),
  'question'
);
assert.equal(
  resolvePushPreferenceEvent({ data: { type: 'agent-needs-input', kind: 'permission' } }),
  'permission'
);
assert.equal(resolvePushPreferenceEvent({ data: { type: 'agent-needs-input' } }), null);
assert.equal(resolvePushPreferenceEvent({ data: { type: 'chat-created', chatId: 'c1' } }), 'newChat');
assert.equal(resolvePushPreferenceEvent({ data: { type: 'chat-history' } }), null);
assert.equal(resolvePushPreferenceEvent({}), null);

// --- filter: A opts out of finished, B stays default ------------------------
addSubscription({ endpoint: A, keys: { p256dh: 'a', auth: 'a' } }, { events: { finished: false } });
addSubscription({ endpoint: B, keys: { p256dh: 'b', auth: 'b' } });

sentCalls.length = 0;
{
  const result = await broadcastPush({
    title: 'done',
    body: 'b',
    data: { type: 'agent-finished', chatId: 'c1', eventId: 'run-1', at: 1 },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sentCalls.length, 1, 'only the opted-in endpoint is contacted');
  assert.equal(sentCalls[0].endpoint, B);
  assert.equal(readSubs().length, 2, 'a skipped endpoint keeps its subscription');
  assert.equal(sentCalls[0].parsed.data.eventId, 'run-1', 'eventId survives into the JSON');
}

// --- the same endpoint still receives a question (filter is per event) ------
sentCalls.length = 0;
{
  const result = await broadcastPush({
    title: 'q',
    data: { type: 'agent-needs-input', kind: 'question', chatId: 'c1', eventId: 'req-1', at: 2 },
  });
  assert.deepEqual(result, { sent: 2, failed: 0 });
  assert.deepEqual(sentCalls.map((call) => call.endpoint).sort(), [A, B].sort());
  for (const call of sentCalls) assert.equal(call.parsed.data.eventId, 'req-1');
}

// --- permission is an independent switch ------------------------------------
addSubscription({ endpoint: A, keys: { p256dh: 'a', auth: 'a' } }, { events: { permission: false } });
sentCalls.length = 0;
{
  const result = await broadcastPush({
    title: 'p',
    data: { type: 'agent-needs-input', kind: 'permission', chatId: 'c1' },
  });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sentCalls[0].endpoint, B);
}

// --- unknown payload types ignore preferences entirely ----------------------
addSubscription({ endpoint: A, keys: { p256dh: 'a', auth: 'a' } }, { enabled: false });
sentCalls.length = 0;
{
  const result = await broadcastPush({
    title: 'history',
    data: { type: 'chat-history', chatId: 'c1' },
  });
  assert.deepEqual(result, { sent: 2, failed: 0 }, 'chat-history is not subject to the filter');
}

// --- enabled:false skips only known events ----------------------------------
sentCalls.length = 0;
{
  const result = await broadcastPush({ title: 'done2', data: { type: 'agent-finished', chatId: 'c1' } });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal(sentCalls[0].endpoint, B);
}

// --- per-endpoint NotificationOptions ---------------------------------------
// A has pushVibrate off; C keeps the default.
addSubscription({ endpoint: C, keys: { p256dh: 'c', auth: 'c' } });
addSubscription(
  { endpoint: A, keys: { p256dh: 'a2', auth: 'a2' } },
  { enabled: true, pushVibrate: 'off' }
);
sentCalls.length = 0;
{
  const result = await broadcastPush({
    title: 'v',
    options: { TTL: 7 },
    data: { type: 'chat-history' },
  });
  assert.deepEqual(result, { sent: 3, failed: 0 });
  const a = sentCalls.find((call) => call.endpoint === A);
  const c = sentCalls.find((call) => call.endpoint === C);
  assert.deepEqual(a.parsed.vibrate, [], 'vibration off => explicit empty marker');
  assert.deepEqual(c.parsed.vibrate, [80, 40, 80], 'default keeps [80,40,80]');
  // HTTP options stay HTTP options and never leak into the notification JSON.
  assert.equal('options' in a.parsed, false);
  assert.equal(a.options.TTL, 7);
}

// --- silent => no vibrate in the JSON ---------------------------------------
sentCalls.length = 0;
{
  const result = await broadcastPush({ title: 's', silent: true, data: { type: 'chat-history' } });
  assert.deepEqual(result, { sent: 3, failed: 0 });
  for (const call of sentCalls) {
    assert.equal(call.parsed.silent, true);
    assert.equal('vibrate' in call.parsed, false, 'silent must not carry vibrate');
  }
}

// --- server broadcast must not consult device quiet hours -------------------
const pushSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'push.js'), 'utf8');
assert.equal(/quiet/i.test(pushSource), false, 'broadcastPush must not filter on quiet hours');
assert.equal(/push-quiet-hours/i.test(pushSource), false);

rmSync(dataDir, { recursive: true, force: true });
console.log('push-broadcast-preferences.test.js: ok');
