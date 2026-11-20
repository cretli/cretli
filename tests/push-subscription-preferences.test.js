/**
 * Integration tests for per-endpoint preferences stored beside the web-push
 * subscription (lib/push.js). Uses a temp CRETLI_DATA_DIR and a monkeypatched
 * `web-push` sender — never touches the real data/ directory.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// DATA_DIR is resolved once at import time (lib/runtime-paths.js), so point it
// at a scratch directory BEFORE any module that touches it is imported.
const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-push-prefs-'));
process.env.CRETLI_DATA_DIR = dataDir;
const subsFile = path.join(dataDir, 'push-subscriptions.json');

const webPush = (await import('web-push')).default;
/** @type {{ sub: object, payload: string, options: object }[]} */
const sentCalls = [];
/** @type {Map<string, number>} */
const failures = new Map();
webPush.sendNotification = async (sub, payload, options) => {
  sentCalls.push({ sub, payload, options });
  const code = failures.get(sub.endpoint);
  if (code) {
    const err = new Error('push rejected');
    err.statusCode = code;
    throw err;
  }
};

const push = await import('../lib/push.js');
const { addSubscription, removeSubscription, broadcastPush } = push;

/**
 * @returns {any[]}
 */
function readSubs() {
  try {
    return JSON.parse(readFileSync(subsFile, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * @param {string} endpoint
 * @returns {any | undefined}
 */
function findSub(endpoint) {
  return readSubs().find((s) => s?.endpoint === endpoint);
}

const EP1 = 'https://push.example/one';
const EP2 = 'https://push.example/two';

// --- upsert stores preferences BESIDE the subscription, not inside keys --------
addSubscription(
  { endpoint: EP1, keys: { p256dh: 'p1', auth: 'a1' } },
  {
    pushVibrate: 'long',
    inAppVibrate: true,
    events: { finished: false, question: true, permission: true },
  }
);
addSubscription({ endpoint: EP2, keys: { p256dh: 'p2', auth: 'a2' } }, { pushVibrate: 'short' });

{
  const one = findSub(EP1);
  assert.equal(one.preferences.pushVibrate, 'long');
  assert.equal(one.preferences.inAppVibrate, true);
  assert.equal(one.preferences.events.finished, false);
  assert.equal(one.preferences.enabled, true);
  assert.equal(one.keys.preferences, undefined, 'preferences must not be nested in keys');
  assert.equal(findSub(EP2).preferences.pushVibrate, 'short');
  assert.equal(findSub(EP2).preferences.inAppVibrate, false);
  // Two endpoints are independent.
  assert.notEqual(findSub(EP1).preferences, findSub(EP2).preferences);
}

// --- re-POST without preferences preserves stored ones ------------------------
addSubscription({ endpoint: EP1, keys: { p256dh: 'p1b', auth: 'a1b' } });
{
  const one = findSub(EP1);
  assert.equal(one.keys.p256dh, 'p1b', 'subscription fields are updated');
  assert.equal(one.preferences.pushVibrate, 'long', 're-POST kept pushVibrate');
  assert.equal(one.preferences.inAppVibrate, true, 're-POST kept inAppVibrate');
  assert.equal(one.preferences.events.finished, false, 're-POST kept events');
  assert.equal(findSub(EP2).preferences.pushVibrate, 'short', 'other endpoint untouched');
}

// --- re-POST with a partial patch merges --------------------------------------
addSubscription({ endpoint: EP1, keys: { p256dh: 'p1c', auth: 'a1c' } }, { pushVibrate: 'off' });
{
  const one = findSub(EP1);
  assert.equal(one.preferences.pushVibrate, 'off');
  assert.equal(one.preferences.inAppVibrate, true, 'omitted fields preserved');
  assert.equal(one.preferences.events.finished, false, 'omitted events preserved');
  assert.equal(findSub(EP2).preferences.pushVibrate, 'short', 'second endpoint isolated');
}

// --- 410 removes ONLY the failing endpoint, preserving the alive preferences ---
failures.set(EP1, 410);
sentCalls.length = 0;
{
  const result = await broadcastPush({ title: 'T', body: 'B', options: { TTL: 10 } });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  const after = readSubs();
  assert.equal(after.length, 1);
  assert.equal(after[0].endpoint, EP2);
  assert.equal(after[0].preferences.pushVibrate, 'short', 'alive endpoint keeps its prefs');
  // sendNotification receives ONLY the stripped web-push subscription.
  assert.equal(sentCalls.length, 2);
  for (const call of sentCalls) {
    assert.equal('preferences' in call.sub, false);
    assert.deepEqual(Object.keys(call.sub).sort(), ['endpoint', 'keys']);
  }
  assert.equal(sentCalls[0].options.TTL, 10);
  assert.equal(sentCalls[0].options.urgency, 'high');
}
failures.delete(EP1);

// --- 404 likewise removes only the failing endpoint ---------------------------
removeSubscription(EP2);
assert.deepEqual(readSubs(), []);
const EP3 = 'https://push.example/three';
const EP4 = 'https://push.example/four';
addSubscription({ endpoint: EP3, keys: { p256dh: 'p3', auth: 'a3' } }, { pushVibrate: 'long' });
addSubscription({ endpoint: EP4, keys: { p256dh: 'p4', auth: 'a4' } }, { pushVibrate: 'short' });
failures.set(EP3, 404);
sentCalls.length = 0;
{
  const result = await broadcastPush({ title: 'x' });
  assert.deepEqual(result, { sent: 1, failed: 1 });
  const after = readSubs();
  assert.equal(after.length, 1);
  assert.equal(after[0].endpoint, EP4);
  assert.equal(after[0].preferences.pushVibrate, 'short');
}
failures.delete(EP3);

// --- a non-404/410 failure keeps the subscription -----------------------------
removeSubscription(EP4);
const EP5 = 'https://push.example/five';
addSubscription({ endpoint: EP5, keys: { p256dh: 'p5', auth: 'a5' } }, { pushVibrate: 'long' });
failures.set(EP5, 500);
{
  const result = await broadcastPush({ title: 'y' });
  assert.deepEqual(result, { sent: 0, failed: 1 });
  assert.equal(findSub(EP5).preferences.pushVibrate, 'long', 'non-expired failure is kept');
}
failures.delete(EP5);

// --- removeSubscription removes only the matching endpoint --------------------
removeSubscription(EP5);
assert.deepEqual(readSubs(), []);
removeSubscription('https://push.example/does-not-exist'); // no throw
assert.deepEqual(readSubs(), []);

// --- backward compatibility: legacy record without preferences ----------------
writeFileSync(
  subsFile,
  JSON.stringify([{ endpoint: 'https://push.example/legacy', keys: { p256dh: 'lp', auth: 'la' } }])
);
sentCalls.length = 0;
{
  const result = await broadcastPush({ title: 'legacy' });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.equal('preferences' in sentCalls[0].sub, false);
  // A legacy record without preferences is left untouched (no crash, no rewrite
  // into the wrong shape); it may be normalized by a later re-POST.
  const after = readSubs();
  assert.equal(after.length, 1);
  assert.equal(after[0].endpoint, 'https://push.example/legacy');
  assert.equal('preferences' in after[0], false);
}

rmSync(dataDir, { recursive: true, force: true });
console.log('push-subscription-preferences.test.js: ok');
