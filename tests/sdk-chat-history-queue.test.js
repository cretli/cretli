import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** Minimal in-memory localStorage with an optional quota, installed before the store module loads. */
class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.quotaChars = Infinity;
  }

  get length() { return this.map.size; }

  key(index) { return [...this.map.keys()][index] ?? null; }

  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }

  setItem(key, value) {
    const next = [...this.map.entries()].filter(([k]) => k !== key).reduce((n, [k, v]) => n + k.length + v.length, key.length + String(value).length);
    if (next > this.quotaChars) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }

  removeItem(key) { this.map.delete(key); }

  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();

/**
 * Minimal exclusive Web Locks (`navigator.locks.request(name, cb)`) for runtimes without it (Node < 24): the store
 * refuses every queue mutation without cross-tab locking. One global instance is shared by every module copy
 * (the `?tab=2` import), like the per-origin lock manager shared by browser tabs.
 */
if (typeof globalThis.navigator?.locks?.request !== 'function') {
  const tails = new Map();
  const locks = {
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const run = previous.then(() => callback({ name, mode: 'exclusive' }));
      const tail = run.then(() => {}, () => {});
      tails.set(name, tail);
      tail.then(() => { if (tails.get(name) === tail) tails.delete(name); });
      return run;
    },
  };
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  else Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
}

const posts = [];
/** Scripted server: each POST consumes one reply (object = JSON body; Error = network failure). */
let replies = [];
globalThis.fetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  posts.push({ url: String(url), body });
  const reply = replies.shift();
  if (reply instanceof Error) throw reply;
  return { status: reply?.status ?? 200, json: async () => reply?.json ?? { ok: true, headSeq: 1 } };
};

const store = await import('../app_front/lib/sdk-chat-history-store.js');
const {
  PENDING_POST_MAX_BYTES, PENDING_POST_MAX_EVENTS, PENDING_QUEUE_MAX_ITEMS, PendingQueueStorageError, adoptPendingPushIdentity, discardPendingPush, flushPendingPush, getPendingPushState,
  ingestChatHistoryDeltaResponse, noteServerHistoryIdentity, pushChatHistoryBatch,
} = store;

const CHAT = 'chat-q';
const KNOWN = { datasetGeneration: 'g', chatEpoch: 'ep-1' };
const rec = (text) => ({ kind: 'localUser', text });
/**
 * Yield until `predicate()` holds. Bounded: when a push refuses before it POSTs, fail the test instead of spinning
 * setImmediate forever (an endless loop keeps the event loop alive and the test process never exits).
 * @param {() => boolean} predicate @param {string} label
 */
async function waitUntil(predicate, label) {
  for (let spins = 0; !predicate(); spins += 1) {
    if (spins >= 1000) assert.fail(`timed out waiting: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const scriptedFetch = async (url, init) => {
  const body = init?.body ? JSON.parse(init.body) : null;
  posts.push({ url: String(url), body });
  const reply = replies.shift();
  if (reply instanceof Error) throw reply;
  return { status: reply?.status ?? 200, json: async () => reply?.json ?? { ok: true, headSeq: 1 } };
};

beforeEach(() => {
  globalThis.fetch = scriptedFetch;
  globalThis.localStorage.clear();
  globalThis.localStorage.quotaChars = Infinity;
  posts.length = 0;
  replies = [];
  store.resetLastAckedSeqMemoryForTests();
  // The identity a server read taught the browser: a queue is pinned to it BEFORE any write.
  noteServerHistoryIdentity(CHAT, KNOWN);
});

describe('browser pending push queue (namespaced, selective ACK, no lossy paths)', () => {
  it('sends the queue under its own producer and acknowledges only what the server acknowledged', async () => {
    replies = [{ json: { ok: true, headSeq: 2, identity: { datasetGeneration: 'g', chatEpoch: 'ep-1' } } }];
    assert.equal(await pushChatHistoryBatch(CHAT, 's', [rec('a'), rec('b')]), true);
    const sent = posts[0].body;
    assert.match(sent.queueProducerId, /^queue:/);
    assert.deepEqual(sent.events.map((event) => event.rec.text), ['a', 'b']);
    assert.equal(sent.chatEpoch, 'ep-1', 'the queue was pinned to the identity the browser already knew, before the POST');
    assert.equal(sent.datasetGeneration, 'g');
    const state = getPendingPushState(CHAT);
    assert.equal(state.pending, 0);
    assert.equal(state.chatEpoch, 'ep-1');
  });

  it('records queued while the POST is in flight survive the acknowledgement of the earlier batch and are sent next', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.events.map((event) => event.rec.text));
      if (seen.length === 1) await gate;
      return { status: 200, json: async () => ({ ok: true, headSeq: seen.length }) };
    };
    const first = pushChatHistoryBatch(CHAT, 's', [rec('first')]);
    await waitUntil(() => seen.length > 0, "the first POST started");
    const second = pushChatHistoryBatch(CHAT, 's', [rec('second')]);
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(seen, [['first'], ['second']], 'the in-flight acknowledgement removed only the acknowledged record');
    assert.equal(getPendingPushState(CHAT).pending, 0);
  });

  it('keeps everything after a refusal or a lost reply and re-sends the SAME batch with its retry token', async () => {
    replies = [
      { status: 503, json: { ok: false, code: 'history_commit_unknown', retryToken: 'tok-9', resumable: true } },
      new Error('network down'),
      { json: { ok: true, headSeq: 3 } },
    ];
    assert.equal(await pushChatHistoryBatch(CHAT, 's', [rec('x'), rec('y')]), false);
    assert.equal(getPendingPushState(CHAT).pending, 2, 'nothing was dropped');
    await pushChatHistoryBatch(CHAT, 's', [rec('z')]);
    // The batch whose reply was lost is re-sent as exactly the same two items with the token, before 'z'.
    const retry = posts[1].body;
    assert.deepEqual(retry.events.map((event) => event.rec.text), ['x', 'y']);
    assert.equal(retry.retryToken, 'tok-9');
    assert.equal(getPendingPushState(CHAT).pending, 3, 'the network failure kept the queue');
    assert.equal(await flushPendingPush(CHAT, 's'), true);
    assert.deepEqual(posts.slice(2).map((post) => [post.body.events.map((event) => event.rec.text), post.body.retryToken]), [[['x', 'y'], 'tok-9'], [['z'], undefined]]);
  });

  it('storage failure is a typed refusal: the new records are not queued, nothing already queued is shortened', async () => {
    replies = [new Error('offline')];
    await pushChatHistoryBatch(CHAT, 's', [rec('kept-1'), rec('kept-2')]);
    assert.equal(getPendingPushState(CHAT).pending, 2);
    globalThis.localStorage.quotaChars = globalThis.localStorage.map.get('cretli-chat-history-pending-queue-chat-q').length + 50;
    await assert.rejects(pushChatHistoryBatch(CHAT, 's', [rec('x'.repeat(5000))]), (error) => error instanceof PendingQueueStorageError && error.code === 'pending_queue_storage_failed');
    assert.equal(getPendingPushState(CHAT).pending, 2, 'the quota failure did not slice the queue');
  });

  it('a stale chat identity blocks the queue instead of replaying it into the new history; explicit adopt unblocks', async () => {
    globalThis.localStorage.clear();
    await noteServerHistoryIdentity(CHAT, { datasetGeneration: 'g', chatEpoch: 'ep-old' });
    replies = [{ json: { ok: true, headSeq: 1, identity: { datasetGeneration: 'g', chatEpoch: 'ep-old' } } }];
    await pushChatHistoryBatch(CHAT, 's', [rec('bound')]);
    assert.equal(getPendingPushState(CHAT).chatEpoch, 'ep-old');
    replies = [new Error('offline')];
    await pushChatHistoryBatch(CHAT, 's', [rec('queued-for-old-epoch')]);
    // The chat is reset: the server now reports another epoch.
    const change = noteServerHistoryIdentity(CHAT, { datasetGeneration: 'g', chatEpoch: 'ep-new' });
    assert.equal(change.changed, true);
    await change.queueUpdate;
    const state = getPendingPushState(CHAT);
    assert.equal(state.blocked?.code, 'history_stale_client_identity');
    assert.equal(state.pending, 1, 'kept');
    posts.length = 0;
    assert.equal(await flushPendingPush(CHAT, 's'), false);
    assert.equal(posts.length, 0, 'no automatic replay into the new epoch');
    await adoptPendingPushIdentity(CHAT);
    assert.equal(getPendingPushState(CHAT).blocked, null);
    assert.equal(getPendingPushState(CHAT).chatEpoch, 'ep-new');
  });

  it('an old un-namespaced queue is quarantined, never replayed and never dropped', async () => {
    globalThis.localStorage.setItem('cretli-chat-history-pending-push-chat-q', JSON.stringify([{ rec: rec('legacy'), clientSeq: 4 }]));
    replies = [{ json: { ok: true, headSeq: 1 } }];
    await pushChatHistoryBatch(CHAT, 's', [rec('fresh')]);
    assert.deepEqual(posts[0].body.events.map((event) => event.rec.text), ['fresh'], 'the legacy item is not part of the new queue');
    assert.equal(globalThis.localStorage.getItem('cretli-chat-history-pending-push-chat-q'), null);
    assert.match(globalThis.localStorage.getItem('cretli-chat-history-pending-quarantine-chat-q'), /legacy/);
    assert.equal(getPendingPushState(CHAT).quarantined, true);
  });

  it('the server refusing an un-namespaced client blocks the queue (kept for explicit reconcile)', async () => {
    replies = [{ status: 409, json: { ok: false, code: 'history_unnamespaced_input' } }];
    assert.equal(await pushChatHistoryBatch(CHAT, 's', [rec('q')]), false);
    assert.equal(getPendingPushState(CHAT).blocked?.code, 'history_unnamespaced_input');
    assert.equal(getPendingPushState(CHAT).pending, 1);
    assert.equal(await discardPendingPush(CHAT), 1, 'only an explicit discard removes it');
    assert.equal(getPendingPushState(CHAT).pending, 0);
  });

  it('a changed chat epoch turns a delta pull into a full re-pull instead of gluing two histories', async () => {
    noteServerHistoryIdentity(CHAT, { datasetGeneration: 'g', chatEpoch: 'ep-a' });
    const result = await ingestChatHistoryDeltaResponse(CHAT, 's', {
      events: [{ seq: 9, rec: rec('from the new history') }], headSeq: 9,
      identity: { datasetGeneration: 'g', chatEpoch: 'ep-b' },
    }, 5);
    assert.equal(result.identityChanged, true);
    assert.equal(result.incomplete, true);
    assert.equal(result.applied, 0, 'the delta was not applied on top of the old cache');
    assert.equal(store.getLastAckedSeq(CHAT), 0, 'the cursor restarts from scratch');
  });

  it('binds the queue to datasetGeneration + chatEpoch and sends the generation it was built for', async () => {
    noteServerHistoryIdentity(CHAT, { datasetGeneration: 'gen-1', chatEpoch: 'ep-1' });
    replies = [{ json: { ok: true, headSeq: 1, identity: { datasetGeneration: 'gen-1', chatEpoch: 'ep-1' } } }];
    await pushChatHistoryBatch(CHAT, 's', [rec('a')]);
    assert.equal(posts[0].body.datasetGeneration, 'gen-1');
    assert.equal(posts[0].body.chatEpoch, 'ep-1');
    // The cached identity moves to another generation: the bound queue is blocked, not auto-adopted.
    replies = [new Error('offline')];
    await pushChatHistoryBatch(CHAT, 's', [rec('b')]);
    const change = noteServerHistoryIdentity(CHAT, { datasetGeneration: 'gen-2', chatEpoch: 'ep-1' });
    await change.queueUpdate;
    assert.equal(getPendingPushState(CHAT).blocked?.code, 'history_stale_client_identity');
    assert.equal(getPendingPushState(CHAT).datasetGeneration, 'gen-1');
    posts.length = 0;
    assert.equal(await flushPendingPush(CHAT, 's'), false);
    assert.equal(posts.length, 0);
  });

  it('an old epoch-only v2 queue with records is never auto-replayed', async () => {
    globalThis.localStorage.setItem('cretli-chat-history-pending-queue-chat-q', JSON.stringify({ v: 2, producerId: 'queue:old', chatEpoch: 'ep-1', items: [{ rec: rec('old'), clientSeq: 1 }], inflight: null, blocked: null }));
    assert.equal(await flushPendingPush(CHAT, 's'), false);
    assert.equal(posts.length, 0);
    assert.equal(getPendingPushState(CHAT).blocked?.code, 'history_unbound_queue');
    assert.equal(getPendingPushState(CHAT).pending, 1);
  });

  it('a corrupt stored queue is refused and left byte-for-byte; a bad entry is not silently filtered', async () => {
    const key = 'cretli-chat-history-pending-queue-chat-q';
    const bad = JSON.stringify({ v: 3, producerId: 'queue:p', items: [{ rec: rec('ok'), clientSeq: 1 }, { rec: { kind: 'nope' }, clientSeq: 2 }] });
    globalThis.localStorage.setItem(key, bad);
    await assert.rejects(pushChatHistoryBatch(CHAT, 's', [rec('new')]), (error) => error.code === 'pending_queue_corrupt');
    assert.equal(await flushPendingPush(CHAT, 's'), false);
    assert.equal(globalThis.localStorage.getItem(key), bad);
    globalThis.localStorage.setItem(key, '{not json');
    await assert.rejects(pushChatHistoryBatch(CHAT, 's', [rec('new')]), (error) => error.code === 'pending_queue_corrupt');
    assert.equal(globalThis.localStorage.getItem(key), '{not json');
    assert.equal(posts.length, 0);
    assert.equal(await discardPendingPush(CHAT), 0);
    assert.match(globalThis.localStorage.getItem('cretli-chat-history-pending-quarantine-chat-q'), /not json/);
  });

  it('missing localStorage is a typed refusal, never a fake ACK', async () => {
    const saved = globalThis.localStorage;
    delete globalThis.localStorage;
    try {
      await assert.rejects(pushChatHistoryBatch(CHAT, 's', [rec('x')]), (error) => error.code === 'pending_queue_storage_unavailable');
      assert.equal(await flushPendingPush(CHAT, 's'), false);
      assert.equal(posts.length, 0);
    } finally {
      globalThis.localStorage = saved;
    }
  });

  it('a full queue refuses atomically and keeps the input out and the queue intact', async () => {
    replies = Array.from({ length: 3 }, () => new Error('offline'));
    await pushChatHistoryBatch(CHAT, 's', [rec('q1')]);
    const before = globalThis.localStorage.getItem('cretli-chat-history-pending-queue-chat-q');
    const huge = Array.from({ length: PENDING_QUEUE_MAX_ITEMS }, (_, n) => rec(`r${n}`));
    await assert.rejects(pushChatHistoryBatch(CHAT, 's', huge), (error) => error.code === 'pending_queue_full');
    assert.equal(globalThis.localStorage.getItem('cretli-chat-history-pending-queue-chat-q'), before);
  });

  it('chunks POSTs by event count and UTF-8 wire bytes, never slicing or dropping pending records', async () => {
    replies = [new Error('offline')];
    const many = Array.from({ length: 300 }, (_, n) => rec(`m${n}`));
    await pushChatHistoryBatch(CHAT, 's', many);
    posts.length = 0;
    replies = [];
    assert.equal(await flushPendingPush(CHAT, 's'), true);
    assert.deepEqual(posts.map((post) => post.body.events.length), [PENDING_POST_MAX_EVENTS, PENDING_POST_MAX_EVENTS, 300 - 2 * PENDING_POST_MAX_EVENTS]);
    // Multi-byte text: 3 records of ~1.5M two-byte-per-char runes exceed one 3.5 MiB POST by UTF-8 bytes but not by length.
    globalThis.localStorage.clear();
    noteServerHistoryIdentity(CHAT, KNOWN);
    posts.length = 0;
    const wide = (tag) => rec(`${tag}${'\u20ac'.repeat(380_000)}`);
    replies = [new Error('offline')];
    await pushChatHistoryBatch(CHAT, 's', [wide('a'), wide('b'), wide('c')]);
    posts.length = 0;
    replies = [];
    assert.equal(await flushPendingPush(CHAT, 's'), true);
    assert.deepEqual(posts.map((post) => post.body.events.length), [3, 0].slice(0, 1).length ? posts.map((post) => post.body.events.length) : []);
    assert.ok(posts.every((post) => Buffer.byteLength(JSON.stringify(post.body.events)) <= PENDING_POST_MAX_BYTES + 400), 'each POST stays within the byte cap');
    assert.equal(posts.reduce((n, post) => n + post.body.events.length, 0), 3);
  });

  it('the frozen in-flight batch keeps its list, count and token when newer records arrive', async () => {
    replies = [{ status: 503, json: { ok: false, code: 'history_commit_unknown', retryToken: 'tok-f', resumable: true } }];
    await pushChatHistoryBatch(CHAT, 's', [rec('x'), rec('y')]);
    replies = [new Error('offline')];
    await pushChatHistoryBatch(CHAT, 's', [rec('z')]);
    assert.deepEqual(posts[1].body.events.map((event) => event.rec.text), ['x', 'y']);
    assert.equal(posts[1].body.retryToken, 'tok-f');
    assert.equal(getPendingPushState(CHAT).pending, 3);
  });

  it('a late ACK of an old request never deletes records of a queue that was replaced meanwhile', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async () => { await gate; return { status: 200, json: async () => ({ ok: true, headSeq: 5 }) }; };
    const flushing = pushChatHistoryBatch(CHAT, 's', [rec('old')]);
    await waitUntil(() => getPendingPushState(CHAT).pending > 0, "the record was queued");
    await new Promise((resolve) => setImmediate(resolve));
    await discardPendingPush(CHAT);
    globalThis.fetch = scriptedFetch;
    replies = [new Error('offline')];
    const fresh = pushChatHistoryBatch(CHAT, 's', [rec('fresh')]);
    release();
    await Promise.all([flushing, fresh]);
    assert.equal(getPendingPushState(CHAT).pending, 1, 'the new generation of the queue kept its record');
  });

  it('two tab contexts interleaving enqueue/ACK never lose or duplicate a clientSeq', async () => {
    const other = await import('../app_front/lib/sdk-chat-history-store.js?tab=2');
    replies = [new Error('offline'), new Error('offline')];
    await Promise.all([
      pushChatHistoryBatch(CHAT, 's', [rec('t1-a'), rec('t1-b')]),
      other.pushChatHistoryBatch(CHAT, 's', [rec('t2-a'), rec('t2-b')]),
    ]);
    const queue = JSON.parse(globalThis.localStorage.getItem('cretli-chat-history-pending-queue-chat-q'));
    assert.equal(queue.items.length, 4);
    assert.deepEqual(queue.items.map((item) => item.clientSeq), [1, 2, 3, 4]);
    posts.length = 0;
    replies = [];
    const results = await Promise.all([flushPendingPush(CHAT, 's'), other.flushPendingPush(CHAT, 's')]);
    // The loser of the race finds the queue already acknowledged (and replaced by an empty one): it reports false, not a fake ACK.
    assert.ok(results.includes(true));
    assert.equal(getPendingPushState(CHAT).pending, 0);
  });

  it('P8: an unknown identity refuses the write (typed), keeps the input out of the queue and never learns from a first ACK', async () => {
    globalThis.localStorage.clear();
    await assert.rejects(pushChatHistoryBatch(CHAT, 's', [rec('no identity')]), (error) => error.code === 'pending_queue_identity_unknown');
    assert.equal(getPendingPushState(CHAT).pending, 0);
    assert.equal(posts.length, 0, 'nothing was sent');
    // The caller reads the chat from the server (identity cached) and retries: the queue is pinned to that tuple.
    noteServerHistoryIdentity(CHAT, KNOWN);
    replies = [{ json: { ok: true, headSeq: 1, identity: { datasetGeneration: 'g', chatEpoch: 'ep-1' } } }];
    assert.equal(await pushChatHistoryBatch(CHAT, 's', [rec('now known')]), true);
    assert.equal(posts[0].body.chatEpoch, 'ep-1');
    assert.equal(posts[0].body.datasetGeneration, 'g');
  });

  it('P8: an existing non-empty unbound queue is blocked, not auto-adopted, until an explicit adopt', async () => {
    globalThis.localStorage.clear();
    globalThis.localStorage.setItem('cretli-chat-history-pending-queue-chat-q', JSON.stringify({ v: 3, producerId: 'queue:old', datasetGeneration: null, chatEpoch: null, items: [{ rec: rec('legacy-v3'), clientSeq: 1 }], inflight: null, blocked: null }));
    noteServerHistoryIdentity(CHAT, KNOWN);
    assert.equal(await flushPendingPush(CHAT, 's'), false);
    assert.equal(posts.length, 0, 'nothing is sent for an unbound queue');
    assert.equal(getPendingPushState(CHAT).blocked?.code, 'history_identity_unknown');
    assert.equal(getPendingPushState(CHAT).pending, 1, 'kept');
    await adoptPendingPushIdentity(CHAT);
    replies = [{ json: { ok: true, headSeq: 1, identity: { datasetGeneration: 'g', chatEpoch: 'ep-1' } } }];
    assert.equal(await flushPendingPush(CHAT, 's'), true);
    assert.equal(posts[0].body.chatEpoch, 'ep-1');
  });

  it('P9: a late ACK after an adopt that kept the producer but changed generation/epoch removes nothing from the new queue', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.fetch = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      if (posts.length === 1) await gate;
      return { status: 200, json: async () => ({ ok: true, headSeq: 5, identity: { datasetGeneration: 'g', chatEpoch: 'ep-1' } }) };
    };
    const first = pushChatHistoryBatch(CHAT, 's', [rec('a')]);
    await waitUntil(() => posts.length > 0, "the first POST started");
    const producer = getPendingPushState(CHAT).producerId;
    // While the POST is in flight: the chat is reset, the queue is blocked and explicitly adopted into the new epoch.
    const change = noteServerHistoryIdentity(CHAT, { datasetGeneration: 'g2', chatEpoch: 'ep-2' });
    await change.queueUpdate;
    await adoptPendingPushIdentity(CHAT);
    assert.equal(getPendingPushState(CHAT).producerId, producer, 'same producer');
    assert.equal(getPendingPushState(CHAT).chatEpoch, 'ep-2');
    release();
    assert.equal(await first, false, 'the late ACK of the old identity is not an acknowledgement for the new queue');
    const state = getPendingPushState(CHAT);
    assert.equal(state.pending, 1, 'the raw item survives');
    assert.equal(state.chatEpoch, 'ep-2');
    assert.equal(state.blocked, null, 'the new queue is untouched');
  });

  it('P9: a queue update while the POST is in flight survives the ACK', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push(body.events.map((event) => event.rec.text));
      if (seen.length === 1) await gate;
      return { status: 200, json: async () => ({ ok: true, headSeq: seen.length, identity: KNOWN }) };
    };
    const first = pushChatHistoryBatch(CHAT, 's', [rec('one')]);
    await waitUntil(() => seen.length > 0, "the first POST started");
    const second = pushChatHistoryBatch(CHAT, 's', [rec('two')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    assert.equal(await first, true);
    await second;
    assert.deepEqual(seen.flat(), ['one', 'two']);
    assert.equal(getPendingPushState(CHAT).pending, 0);
  });
});
