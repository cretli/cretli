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

// --- durable seen-event ids: duplicate detection -----------------------------
assert.equal(options.isDuplicatePushEventId([], 'run-1'), false);
assert.equal(options.isDuplicatePushEventId(['run-1'], 'run-1'), true);
assert.equal(options.isDuplicatePushEventId([{ eventId: 'run-1', receivedAt: 1 }], 'run-1'), true);
assert.equal(options.isDuplicatePushEventId(['  run-1  '], ' run-1 '), true);
assert.equal(options.isDuplicatePushEventId(['run-1'], 'run-2'), false);
assert.equal(options.isDuplicatePushEventId(['run-1'], ''), false, 'no eventId is never a duplicate');
assert.equal(options.isDuplicatePushEventId(null, 'run-1'), false);
assert.equal(options.isDuplicatePushEventId([{ eventId: 'run-1' }], ''), false);

// --- durable seen-event ids: pruning, TTL and cap ----------------------------
const NOW = Date.parse('2026-06-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
{
  // Expired entries are dropped, fresh ones survive.
  const pruned = plain(options.prunePushEventIds(
    [
      { eventId: 'old', receivedAt: NOW - 31 * DAY },
      { eventId: 'fresh', receivedAt: NOW - HOUR },
    ],
    NOW,
  ));
  assert.deepEqual(pruned.map((entry) => entry.eventId), ['fresh']);

  // Junk, duplicates and missing timestamps are normalised. A bare string is
  // treated as received now; a duplicate id keeps the newest timestamp.
  const normalised = plain(options.prunePushEventIds(
    [null, '', 'bare', { eventId: 'bare', receivedAt: NOW - HOUR }, { eventId: 'x', receivedAt: NOW }],
    NOW,
  ));
  assert.deepEqual(normalised.map((entry) => entry.eventId), ['bare', 'x']);
  assert.equal(normalised[0].receivedAt, NOW, 'the newest timestamp wins for a duplicate id');
  assert.equal(normalised[1].receivedAt, NOW);

  // Newest-first cap; an old retry cannot evict a fresh occurrence.
  const capped = plain(options.prunePushEventIds(
    [
      { eventId: 'a', receivedAt: NOW - 2 * HOUR },
      { eventId: 'b', receivedAt: NOW - HOUR },
      { eventId: 'c', receivedAt: NOW },
    ],
    NOW,
    { maxEntries: 2 },
  ));
  assert.deepEqual(capped.map((entry) => entry.eventId), ['c', 'b']);

  // Recording is idempotent and appends a new occurrence.
  const recorded = plain(options.recordPushEventId([], 'run-9', NOW));
  assert.deepEqual(recorded, [{ eventId: 'run-9', receivedAt: NOW }]);
  assert.deepEqual(plain(options.recordPushEventId(recorded, 'run-9', NOW + HOUR)), recorded);
  assert.deepEqual(
    plain(options.recordPushEventId(recorded, 'run-10', NOW + HOUR)).map((entry) => entry.eventId),
    ['run-10', 'run-9'],
  );
  assert.deepEqual(plain(options.recordPushEventId(recorded, '', NOW + HOUR)), recorded, 'empty id is a no-op');
}

// --- sw.js wiring + cache bump ----------------------------------------------
const swSource = readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
assert.match(swSource, /importScripts\('\/sw-push-options\.js'\)/);
assert.match(swSource, /CACHE_NAME = 'cretli-v31'/);
assert.match(swSource, /shouldPersistPushPayload\(payload\)/);
assert.match(swSource, /resolvePushRenotify\(payload, existing\)/);
assert.match(swSource, /getNotifications\(\{ tag \}\)/);
assert.match(swSource, /options\.silent = true/);
assert.match(swSource, /options\.vibrate = vibrate/);
assert.match(swSource, /claimPushEventId\(optionsPolicy\.readPushEventId\(payload\)\)/);
assert.match(swSource, /if \(claim\.duplicate\) return;/);
assert.match(swSource, /cretli-push-seen/);
// The durable claim must be ONE readwrite transaction: a separate read
// transaction followed by a separate write transaction loses/duplicates ids
// when two push handlers overlap.
assert.match(swSource, /claimStoredPushEventId/);
assert.match(swSource, /transaction\(PUSH_SEEN_STORE_NAME, 'readwrite'\)/);
assert.doesNotMatch(swSource, /transaction\(PUSH_SEEN_STORE_NAME, 'readonly'\)/);
assert.match(swSource, /tx\.oncomplete = \(\) => settle\(resolve, claim\)/);

const SEEN_DB_NAME = 'cretli-push-seen';
const SEEN_STORE_NAME = 'kv';
const SEEN_KEY = 'received-event-ids';

/**
 * Minimal in-memory IndexedDB implementing exactly the subset public/sw.js uses.
 *
 * The point is to exercise the PRODUCTION claim adapter (`claimStoredPushEventId`)
 * instead of a doctored injectable store: it serializes overlapping `readwrite`
 * transactions on the same object store like a real IndexedDB, records the
 * transaction modes it was asked for, and can fail a request to exercise the
 * fail-open path.
 *
 * @param {{ failGet?: boolean, failPut?: boolean }} [options]
 */
function createFakeIndexedDb(options = {}) {
  const databases = new Map();
  const tails = new Map();
  const transactionLog = [];
  const failures = { get: !!options.failGet, put: !!options.failPut };

  function getDatabase(name) {
    let database = databases.get(name);
    if (!database) {
      database = { name, stores: new Map(), upgraded: false };
      databases.set(name, database);
    }
    return database;
  }

  // Mirrors IndexedDB's rule that readwrite transactions with overlapping
  // scopes never run concurrently: the whole transaction holds the store's
  // queue until it commits or aborts.
  function runExclusive(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    tails.set(key, run.then(() => undefined, () => undefined));
    return run;
  }

  function createTransaction(database, storeName, mode) {
    const store = database.stores.get(storeName);
    const operations = [];
    let started = false;
    let finished = false;
    let aborted = false;
    const tx = {
      mode,
      error: null,
      oncomplete: null,
      onerror: null,
      onabort: null,
      objectStore(requestedStore) {
        if (requestedStore !== storeName) {
          throw new Error(`transaction scope mismatch: ${requestedStore}`);
        }
        return {
          get(key) {
            return enqueue({ type: 'get', key });
          },
          put(value, key) {
            return enqueue({ type: 'put', value, key });
          },
        };
      },
      abort() {
        aborted = true;
      },
    };

    function enqueue(operation) {
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      operation.request = request;
      operations.push(operation);
      start();
      return request;
    }

    function start() {
      if (started) return;
      started = true;
      runExclusive(`${database.name}::${storeName}`, execute);
    }

    function complete() {
      if (finished) return;
      finished = true;
      if (typeof tx.oncomplete === 'function') tx.oncomplete();
    }

    function abort() {
      if (finished) return;
      finished = true;
      if (typeof tx.onerror === 'function') tx.onerror();
      if (typeof tx.onabort === 'function') tx.onabort();
    }

    async function execute() {
      while (!finished) {
        if (aborted) {
          abort();
          return;
        }
        if (operations.length === 0) {
          // IndexedDB auto-commits once no request is pending when the event
          // loop turns; wait a macrotask so a success handler can still enqueue.
          await new Promise((next) => setTimeout(next, 0));
          if (operations.length === 0) {
            complete();
            return;
          }
          continue;
        }
        const operation = operations.shift();
        try {
          if (operation.type === 'get') {
            if (failures.get) throw new Error('fake-indexeddb-get-failed');
            operation.request.result = store.get(operation.key);
          } else {
            if (failures.put) throw new Error('fake-indexeddb-put-failed');
            store.set(operation.key, operation.value);
            operation.request.result = operation.key;
          }
        } catch (error) {
          operation.request.error = error;
          tx.error = error;
          if (typeof operation.request.onerror === 'function') operation.request.onerror();
          abort();
          return;
        }
        if (typeof operation.request.onsuccess === 'function') operation.request.onsuccess();
      }
    }

    return tx;
  }

  function open(name) {
    const request = {
      result: undefined,
      error: null,
      onsuccess: null,
      onupgradeneeded: null,
      onerror: null,
    };
    setTimeout(() => {
      try {
        const database = getDatabase(name);
        const db = {
          objectStoreNames: { contains: (storeName) => database.stores.has(storeName) },
          createObjectStore(storeName) {
            if (!database.stores.has(storeName)) database.stores.set(storeName, new Map());
            return {};
          },
          transaction(storeName, mode) {
            if (!database.stores.has(storeName)) {
              throw new Error(`NotFoundError: no store ${storeName}`);
            }
            transactionLog.push({ database: name, store: storeName, mode });
            return createTransaction(database, storeName, mode);
          },
          close() {},
        };
        request.result = db;
        if (!database.upgraded) {
          database.upgraded = true;
          if (typeof request.onupgradeneeded === 'function') request.onupgradeneeded();
        }
        if (typeof request.onsuccess === 'function') request.onsuccess();
      } catch (error) {
        request.error = error;
        if (typeof request.onerror === 'function') request.onerror();
      }
    }, 0);
    return request;
  }

  return {
    indexedDB: { open },
    transactionLog,
    failures,
    readSeenEntries() {
      const database = databases.get(SEEN_DB_NAME);
      const store = database && database.stores.get(SEEN_STORE_NAME);
      const value = store && store.get(SEEN_KEY);
      return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
    },
  };
}

/**
 * Runs the real push handler from public/sw.js in a fresh sandbox. A new
 * harness on the same fake IndexedDB simulates a worker restart.
 *
 * @param {{ seenStore?: object, indexedDB?: object }} [globals]
 */
function createPushHarness(globals = {}) {
  const context = {
    self: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  assert.ok(context.self.cretliPushOptions, 'options helpers load before sw.js');
  if (globals.seenStore) context.self.cretliPushSeenStore = globals.seenStore;
  if (globals.indexedDB) context.self.indexedDB = globals.indexedDB;

  const shown = [];
  let pushHandler = null;
  context.self.registration = {
    getNotifications: async () => [],
    showNotification: async (title, options) => {
      shown.push({ title, options });
    },
  };
  context.self.clients = { matchAll: async () => [] };
  context.self.addEventListener = (type, handler) => {
    if (type === 'push') pushHandler = handler;
  };
  vm.runInContext(swSource, context);
  assert.equal(typeof pushHandler, 'function', 'sw.js registers a push handler');

  const dispatchPush = (payload) => {
    const waiting = [];
    pushHandler({
      data: { json: () => payload, text: () => JSON.stringify(payload) },
      waitUntil: (promise) => waiting.push(promise),
    });
    return Promise.all(waiting);
  };

  return { dispatchPush, shown };
}

const crossingPayload = (eventId) => ({
  title: 'Cretli',
  tag: 'cretli-balance',
  body: 'Balance is running low',
  data: { eventId, type: 'balance-alert' },
});

// --- dispatch: a dismissed, re-received occurrence must not alert again ------
// The injectable store must expose an atomic `claim`; this scenario simulates a
// retry after the first notification was dismissed (getNotifications() returns
// []) and the server-side progress write failed (same eventId arrives again).
{
  const entries = [];
  let tail = Promise.resolve();
  const seenStore = {
    claim(eventId, now, policy) {
      const runClaim = () => {
        const pruned = policy.prunePushEventIds(entries, now, {});
        if (policy.isDuplicatePushEventId(pruned, eventId)) {
          return { duplicate: true, tracked: true };
        }
        const next = policy.recordPushEventId(pruned, eventId, now, {});
        entries.length = 0;
        entries.push(...next);
        return { duplicate: false, tracked: true };
      };
      const next = tail.then(runClaim, runClaim);
      tail = next.then(() => undefined, () => undefined);
      return next;
    },
  };
  const { dispatchPush, shown } = createPushHarness({ seenStore });

  await dispatchPush(crossingPayload('balance-alert:2026-06-30T11:00:00.000Z'));
  assert.equal(shown.length, 1, 'a first occurrence alerts');
  assert.equal(shown[0].options.renotify, true);

  // The notification was dismissed and the server retried the same crossing.
  await dispatchPush(crossingPayload('balance-alert:2026-06-30T11:00:00.000Z'));
  assert.equal(shown.length, 1, 'an already received eventId is not shown again after dismissal');

  // A new crossing (different crossedAt => different eventId) still alerts.
  await dispatchPush(crossingPayload('balance-alert:2026-06-30T12:00:00.000Z'));
  assert.equal(shown.length, 2, 'a new crossing eventId still alerts');

  // Payloads without an eventId keep the legacy renotify behaviour.
  await dispatchPush({ title: 'Cretli', body: 'legacy', tag: 'cretli' });
  assert.equal(shown.length, 3, 'a payload without eventId is never suppressed');
}

// --- production adapter: overlapping same-id deliveries ---------------------
// Two push handlers run without awaiting one another. The read+check+write is
// one serialized readwrite transaction, so only the first handler may show.
{
  const fakeDb = createFakeIndexedDb();
  const { dispatchPush, shown } = createPushHarness({ indexedDB: fakeDb.indexedDB });
  const crossing = crossingPayload('run-same');
  await Promise.all([dispatchPush(crossing), dispatchPush(crossing)]);
  assert.equal(shown.length, 1, 'concurrent same-id deliveries show exactly one notification');
  assert.deepEqual(
    fakeDb.readSeenEntries().map((entry) => entry.eventId),
    ['run-same'],
    'the occurrence id is stored exactly once',
  );
  assert.equal(
    fakeDb.transactionLog.length,
    2,
    'each overlapping delivery opens exactly one transaction',
  );
  assert.deepEqual(
    [...new Set(fakeDb.transactionLog.map((entry) => entry.mode))],
    ['readwrite'],
    'the claim is a readwrite transaction, never a separate read then write',
  );
  await dispatchPush(crossing);
  assert.equal(shown.length, 1, 'a later retry of the same id is still suppressed');
}

// --- production adapter: overlapping different-id deliveries ----------------
// A lost update would keep only the last id, so a retry of the first one would
// alert again.
{
  const fakeDb = createFakeIndexedDb();
  const { dispatchPush, shown } = createPushHarness({ indexedDB: fakeDb.indexedDB });
  const first = crossingPayload('run-a');
  const second = crossingPayload('run-b');
  await Promise.all([dispatchPush(first), dispatchPush(second)]);
  assert.equal(shown.length, 2, 'both first deliveries are shown');
  assert.deepEqual(
    fakeDb.readSeenEntries().map((entry) => entry.eventId).sort(),
    ['run-a', 'run-b'],
    'neither concurrent claim loses the other id',
  );
  await Promise.all([dispatchPush(first), dispatchPush(second)]);
  assert.equal(shown.length, 2, 'retries of either id are suppressed');
}

// --- production adapter: a failed write fails open -------------------------
{
  const fakeDb = createFakeIndexedDb({ failPut: true });
  const { dispatchPush, shown } = createPushHarness({ indexedDB: fakeDb.indexedDB });
  const crossing = crossingPayload('run-abort');
  await dispatchPush(crossing);
  assert.equal(shown.length, 1, 'an aborted claim still shows the real notification');
  assert.deepEqual(fakeDb.readSeenEntries(), [], 'an aborted claim persists nothing');
  fakeDb.failures.put = false;
  await dispatchPush(crossing);
  assert.equal(shown.length, 2, 'the retry is shown because the failed claim was not required');
  await dispatchPush(crossing);
  assert.equal(shown.length, 2, 'once the store works again the retry is claimed');
}

// --- production adapter: a failed read also fails open ----------------------
{
  const fakeDb = createFakeIndexedDb({ failGet: true });
  const { dispatchPush, shown } = createPushHarness({ indexedDB: fakeDb.indexedDB });
  await dispatchPush(crossingPayload('run-read-fail'));
  assert.equal(shown.length, 1, 'a failed read still shows the real notification');
  assert.deepEqual(fakeDb.readSeenEntries(), [], 'a failed read writes nothing');
}

// --- production adapter: durability across a simulated worker recreation ----
{
  const fakeDb = createFakeIndexedDb();
  const crossing = crossingPayload('run-durable');
  const beforeRestart = createPushHarness({ indexedDB: fakeDb.indexedDB });
  await beforeRestart.dispatchPush(crossing);
  assert.equal(beforeRestart.shown.length, 1, 'the occurrence alerts before the restart');
  // A new context re-runs sw.js and re-opens the same durable database.
  const afterRestart = createPushHarness({ indexedDB: fakeDb.indexedDB });
  await afterRestart.dispatchPush(crossing);
  assert.equal(afterRestart.shown.length, 0, 'a dismissed occurrence is not re-alerted after a restart');
}

console.log('sw-push-options.test.js: ok');
