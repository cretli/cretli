import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatListSyncClient, pruneArchivedWithoutLiveDescendants } from '../app_front/features/chat/chatListSyncClient.js';

const dto = (id, title = id) => ({ id, title });

/** Scripted fake server: a position, a row map and pluggable answers. */
function makeServer(initial = ['a', 'b', 'c']) {
  const server = {
    epoch: 'e1',
    seq: 1,
    rows: new Map(initial.map((id) => [id, dto(id)])),
    log: [],
    syncAnswers: [],
    pageAnswers: [],
    syncCalls: 0,
    pageCalls: 0,
    sync: async (since) => {
      server.syncCalls += 1;
      server.log.push(['sync', since]);
      const scripted = server.syncAnswers.shift();
      if (scripted) {
        if (scripted instanceof Error) throw scripted;
        return typeof scripted === 'function' ? scripted(since) : scripted;
      }
      const [epoch, seq] = since.split('.');
      if (epoch !== server.epoch) return { mode: 'resync', reason: 'epoch', epoch: server.epoch, seq: server.seq };
      if (Number(seq) === server.seq) return { mode: 'noop', epoch: server.epoch, seq: server.seq };
      return { mode: 'delta', epoch: server.epoch, since: Number(seq), seq: server.seq, upserts: [...server.rows.values()], removed: [] };
    },
    page: async ({ cursor }) => {
      server.pageCalls += 1;
      const scripted = server.pageAnswers.shift();
      if (scripted) {
        if (scripted instanceof Error) throw scripted;
        return scripted;
      }
      const all = [...server.rows.values()];
      const start = cursor ? Number(cursor) : 0;
      const chunk = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : null;
      return { ok: true, sync: `${server.epoch}.${server.seq}`, chats: chunk, nextCursor: next };
    },
  };
  return server;
}

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function makeClient(server, extra = {}) {
  const timers = [];
  const changes = [];
  const client = createChatListSyncClient({
    fetchSync: server.sync,
    fetchPage: server.page,
    onChange: (info) => changes.push(info.reason),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
    ...extra,
  });
  return { client, timers, changes };
}

test('first sync resyncs through bounded pages and stamps the position of the first page', async () => {
  const server = makeServer(['a', 'b', 'c', 'd', 'e']);
  const { client, changes } = makeClient(server);
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(client.getPosition(), { epoch: 'e1', seq: 1 });
  assert.equal(server.pageCalls, 3);
  assert.deepEqual(changes, ['resync']);
});

test('delta applies upserts/removals; duplicate and older responses are dropped (stale)', async () => {
  const server = makeServer();
  const { client } = makeClient(server);
  await client.requestSync();
  const delta = { mode: 'delta', epoch: 'e1', since: 1, seq: 2, upserts: [dto('b', 'B2'), dto('z')], removed: ['a'] };
  server.syncAnswers.push(delta);
  await client.requestSync();
  assert.equal(client.getRows().get('b').title, 'B2');
  assert.equal(client.getRows().has('a'), false);
  assert.equal(client.getPosition().seq, 2);
  // the same response delivered again (retry/duplicate) changes nothing
  server.syncAnswers.push(delta);
  await client.requestSync();
  assert.equal(client.getStats().staleDropped, 1);
  assert.equal(client.getRows().size, 3);
  // an older response arriving late (reorder) is dropped and does not roll the position back
  server.syncAnswers.push({ mode: 'delta', epoch: 'e1', since: 0, seq: 1, upserts: [dto('b', 'OLD')], removed: [] });
  await client.requestSync();
  assert.equal(client.getRows().get('b').title, 'B2');
  assert.equal(client.getPosition().seq, 2);
});

test('reorder: a response covering a wider window than the position still applies idempotently', async () => {
  const server = makeServer();
  const { client } = makeClient(server);
  await client.requestSync();
  server.syncAnswers.push({ mode: 'delta', epoch: 'e1', since: 1, seq: 3, upserts: [dto('c', 'C3')], removed: [] });
  await client.requestSync();
  server.syncAnswers.push({ mode: 'delta', epoch: 'e1', since: 1, seq: 4, upserts: [dto('c', 'C4'), dto('d')], removed: [] });
  await client.requestSync();
  assert.equal(client.getRows().get('c').title, 'C4');
  assert.equal(client.getPosition().seq, 4);
});

test('gap (delta starts after our position) and server resync both fall back to a page walk', async () => {
  const server = makeServer();
  const { client } = makeClient(server);
  await client.requestSync();
  const pagesBefore = server.pageCalls;
  server.syncAnswers.push({ mode: 'delta', epoch: 'e1', since: 7, seq: 9, upserts: [], removed: [] });
  server.seq = 9;
  server.rows.set('n', dto('n'));
  await client.requestSync();
  assert.ok(server.pageCalls > pagesBefore);
  assert.equal(client.getStats().gaps, 1);
  assert.equal(client.getRows().has('n'), true);
  assert.equal(client.getPosition().seq, 9);
  server.syncAnswers.push({ mode: 'resync', reason: 'too-large', epoch: 'e1', seq: 9 });
  const walks = server.pageCalls;
  await client.requestSync();
  assert.ok(server.pageCalls > walks);
});

test('server restart (new epoch) forces a full resync and replaces the rows', async () => {
  const server = makeServer();
  const { client } = makeClient(server);
  await client.requestSync();
  server.epoch = 'e2';
  server.seq = 1;
  server.rows = new Map([['x', dto('x')]]);
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['x']);
  assert.deepEqual(client.getPosition(), { epoch: 'e2', seq: 1 });
});

test('resync restarts on 409 (stale cursor) and swaps rows atomically only when complete', async () => {
  const server = makeServer(['a', 'b', 'c', 'd']);
  const { client } = makeClient(server);
  server.pageAnswers.push({ ok: true, sync: 'e1.1', chats: [dto('a'), dto('b')], nextCursor: '2' }, httpError(409));
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['a', 'b', 'c', 'd'], 'no half-applied first walk');
  assert.equal(server.pageCalls, 4);
});

test('retry: transient errors back off exponentially and succeed; 4xx is terminal and keeps rows', async () => {
  const server = makeServer();
  const { client, timers } = makeClient(server);
  await client.requestSync();
  server.syncAnswers.push(httpError(503), httpError(503));
  await client.requestSync();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  timers.shift().fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers[0].ms, 1000);
  server.rows.set('late', dto('late'));
  server.seq = 2;
  timers.shift().fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(client.getRows().has('late'), true);
  assert.equal(client.getError(), null);
  server.syncAnswers.push(httpError(403));
  await client.requestSync();
  assert.equal(client.getError().status, 403);
  assert.equal(timers.length, 0, 'no retry for a 4xx');
  assert.ok(client.getRows().size >= 3, 'rows are kept after a terminal error');
});

test('burst: 100 triggers during one in-flight request cause one request plus one follow-up, no page walk', async () => {
  const server = makeServer();
  const { client } = makeClient(server);
  await client.requestSync();
  const syncBefore = server.syncCalls;
  const pagesBefore = server.pageCalls;
  let release;
  server.syncAnswers.push(() => new Promise((resolve) => { release = () => resolve({ mode: 'noop', epoch: 'e1', seq: 1 }); }));
  const first = client.requestSync();
  for (let i = 0; i < 100; i += 1) client.requestSync();
  await new Promise((r) => setImmediate(r));
  release();
  await first;
  assert.equal(server.syncCalls - syncBefore, 2, 'one in flight + exactly one coalesced follow-up');
  assert.equal(server.pageCalls, pagesBefore, 'a burst never refetches the list');
});

test('offline: triggers queue as one pending sync, run once on reconnect', async () => {
  const server = makeServer();
  let online = false;
  const { client } = makeClient(server, { isOnline: () => online });
  for (let i = 0; i < 20; i += 1) client.requestSync();
  assert.equal(server.syncCalls + server.pageCalls, 0);
  online = true;
  client.setOnline(true);
  client.setOnline(true);
  await new Promise((r) => setImmediate(r));
  await client.requestSync();
  assert.equal(server.pageCalls, 2, 'one walk of the 3-row list');
  assert.equal(client.getRows().size, 3);
});

test('restore: a persisted snapshot resumes with a delta instead of a page walk', async () => {
  const server = makeServer();
  server.seq = 4;
  server.rows.set('b', dto('b', 'B-new'));
  let saved = null;
  const persist = {
    load: async () => ({ position: { epoch: 'e1', seq: 3 }, scopeKey: '', rows: [dto('a'), dto('b'), dto('c')] }),
    save: async (snapshot) => { saved = snapshot; },
  };
  const { client } = makeClient(server, { persist });
  assert.equal(await client.restore(), true);
  assert.equal(client.getRows().size, 3);
  server.syncAnswers.push({ mode: 'delta', epoch: 'e1', since: 3, seq: 4, upserts: [dto('b', 'B-new')], removed: [] });
  await client.requestSync();
  assert.equal(server.pageCalls, 0);
  assert.equal(client.getRows().get('b').title, 'B-new');
  assert.equal(saved.position.seq, 4);
});

test('multi-tab: a peer announcement triggers a sync only when this tab is behind', async () => {
  const server = makeServer();
  const channel = { messages: [], postMessage(message) { this.messages.push(message); }, onmessage: null };
  const { client } = makeClient(server, { channel });
  await client.requestSync();
  assert.deepEqual(channel.messages.at(-1), { type: 'list-applied', epoch: 'e1', seq: 1, scopeKey: '' });
  const syncBefore = server.syncCalls;
  channel.onmessage({ data: { type: 'list-applied', epoch: 'e1', seq: 1 } });
  channel.onmessage({ data: { type: 'unrelated' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(server.syncCalls, syncBefore, 'peer at the same position -> no request');
  server.seq = 2;
  for (let i = 0; i < 10; i += 1) channel.onmessage({ data: { type: 'list-applied', epoch: 'e1', seq: 2 } });
  await new Promise((r) => setImmediate(r));
  await client.requestSync();
  assert.ok(server.syncCalls - syncBefore <= 3, 'ten announcements coalesce (in flight + one follow-up + the explicit call)');
  assert.ok(server.syncCalls - syncBefore >= 1);
  assert.equal(client.getPosition().seq, 2);
});

test('scope change drops rows + position and forces a full resync (token does not encode scope)', async () => {
  const server = makeServer(['a', 'b']);
  let scope = 'ws:one';
  const { client, changes } = makeClient(server, { getScopeKey: () => scope });
  await client.requestSync();
  assert.equal(client.getScopeKey(), 'ws:one');
  const pagesBefore = server.pageCalls;
  // The same server position now belongs to another scope: a delta would keep foreign rows.
  server.rows = new Map([['x', dto('x')]]);
  scope = 'ws:two';
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['x']);
  assert.ok(server.pageCalls > pagesBefore, 'page walk, not a delta');
  assert.equal(client.getScopeKey(), 'ws:two');
  assert.equal(client.getStats().scopeResets, 1);
  assert.ok(changes.includes('scope'));
});

test('scope change while a request is in flight discards that answer', async () => {
  const server = makeServer(['a']);
  let scope = 'ws:one';
  const { client } = makeClient(server, { getScopeKey: () => scope });
  await client.requestSync();
  server.seq = 2;
  server.syncAnswers.push(async () => {
    scope = 'ws:two';
    server.rows = new Map([['y', dto('y')]]);
    return { mode: 'delta', epoch: 'e1', since: 1, seq: 2, upserts: [dto('stale-foreign')], removed: [] };
  });
  await client.requestSync();
  assert.equal(client.getRows().has('stale-foreign'), false);
  assert.deepEqual([...client.getRows().keys()], ['y']);
  assert.equal(client.getScopeKey(), 'ws:two');
});

test('restore refuses a snapshot saved under another scope', async () => {
  const server = makeServer();
  const persist = {
    load: async () => ({ position: { epoch: 'e1', seq: 1 }, scopeKey: 'ws:old', rows: [dto('old')] }),
    save: async () => {},
  };
  const { client } = makeClient(server, { persist, getScopeKey: () => 'ws:new' });
  assert.equal(await client.restore(), false);
  assert.equal(client.getRows().size, 0);
  assert.equal(client.getPosition(), null);
  await client.requestSync();
  assert.equal(server.pageCalls > 0, true, 'first sync is a full walk');
  const legacy = { load: async () => ({ position: { epoch: 'e1', seq: 1 }, rows: [dto('old')] }), save: async () => {} };
  const { client: legacyClient } = makeClient(server, { persist: legacy, getScopeKey: () => 'ws:new' });
  assert.equal(await legacyClient.restore(), false, 'snapshot without a scope key is not trusted for a scoped client');
});

test('saved snapshots carry the scope key; peer announcements of another scope are ignored', async () => {
  const server = makeServer();
  let saved = null;
  const channel = { messages: [], postMessage(message) { this.messages.push(message); }, onmessage: null };
  const { client } = makeClient(server, { persist: { load: async () => null, save: async (snap) => { saved = snap; } }, channel, getScopeKey: () => 'ws:one' });
  await client.requestSync();
  assert.equal(saved.scopeKey, 'ws:one');
  assert.equal(channel.messages.at(-1).scopeKey, 'ws:one');
  const before = server.syncCalls;
  channel.onmessage({ data: { type: 'list-applied', epoch: 'e1', seq: 99, scopeKey: 'ws:other' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(server.syncCalls, before);
});

test('delta keeps archived=tree parity: archived rows without a live descendant are pruned', async () => {
  const live = (id, forkParentChatId) => ({ id, forkParentChatId });
  const arch = (id, forkParentChatId) => ({ id, forkParentChatId, archivedAt: '2026-01-01T00:00:00Z' });
  const server = makeServer(['p', 'c']);
  server.rows = new Map([
    ['gp', arch('gp')], ['p', arch('p', 'gp')], ['c', live('c', 'p')], ['solo', live('solo')],
  ]);
  const { client } = makeClient(server);
  await client.requestSync();
  assert.equal(client.getRows().size, 4);
  // c gets archived with its whole chain: nothing live remains under gp/p, and the archived solo is touched too.
  server.syncAnswers.push({
    mode: 'delta', epoch: 'e1', since: 1, seq: 2,
    upserts: [arch('c', 'p'), arch('solo')], removed: [],
  });
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], [], 'identical to what archived=tree would return');
  assert.equal(client.getStats().pruned, 4);
});

test('pruneArchivedWithoutLiveDescendants keeps ancestor chains of live rows and handles cycles', () => {
  const arch = (id, p) => ({ id, forkParentChatId: p, archivedAt: 'x' });
  const rows = new Map([
    ['a', arch('a', 'b')], ['b', arch('b', 'a')], ['live', { id: 'live', forkParentChatId: 'a' }], ['orphan', arch('orphan', 'missing')],
  ]);
  assert.equal(pruneArchivedWithoutLiveDescendants(rows), 1);
  assert.deepEqual([...rows.keys()].sort(), ['a', 'b', 'live']);
});

test('dispose stops retry timers and the channel listener and discards in-flight answers', async () => {
  const server = makeServer();
  const cleared = [];
  const channel = { postMessage() {}, onmessage: null };
  let release;
  const { client, timers } = makeClient(server, { channel, clearTimeoutFn: (id) => cleared.push(id) });
  server.pageAnswers.push(httpError(503));
  await client.requestSync();
  assert.equal(timers.length, 1, 'retry scheduled');
  client.dispose();
  assert.deepEqual(cleared, [1]);
  assert.equal(channel.onmessage, null);
  const calls = server.pageCalls + server.syncCalls;
  await client.requestSync();
  assert.equal(server.pageCalls + server.syncCalls, calls, 'no requests after dispose');
  // in-flight discard
  const server2 = makeServer();
  const changes = [];
  const gate = new Promise((resolve) => { release = resolve; });
  const client2 = createChatListSyncClient({
    fetchSync: server2.sync,
    fetchPage: async (q) => { await gate; return server2.page(q); },
    onChange: (info) => changes.push(info.reason),
  });
  const pending = client2.requestSync();
  client2.dispose();
  release();
  await pending;
  assert.deepEqual(changes, []);
  assert.equal(client2.getRows().size, 0);
});

test('scope change during the FIRST resync page walk discards staged pages and resyncs under the new scope', async () => {
  const server = makeServer(['a', 'b', 'c', 'd']);
  let scope = 'ws:one';
  let flipped = false;
  const { client } = makeClient(server, {
    getScopeKey: () => scope,
    fetchPage: async (q) => {
      const answer = await server.page(q);
      if (!flipped) { flipped = true; scope = 'ws:two'; server.rows = new Map([['y', dto('y')]]); }
      return answer;
    },
  });
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['y']);
  assert.equal(client.getScopeKey(), 'ws:two');
});

test('scope change mid page walk of a later resync never mixes old-scope pages into the new rows', async () => {
  const server = makeServer(['a', 'b', 'c', 'd']);
  let scope = 'ws:one';
  let flipped = false;
  let armed = false;
  const { client } = makeClient(server, {
    getScopeKey: () => scope,
    fetchPage: async (q) => {
      const answer = await server.page(q);
      if (armed && !flipped) { flipped = true; scope = 'ws:two'; server.rows = new Map([['z', dto('z')]]); }
      return answer;
    },
  });
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['a', 'b', 'c', 'd']);
  server.epoch = 'e2';
  armed = true;
  await client.requestSync();
  assert.deepEqual([...client.getRows().keys()], ['z']);
  assert.equal(client.getScopeKey(), 'ws:two');
});

test('a retryable failure of an in-flight request after dispose() arms no timer and changes nothing', async () => {
  const server = makeServer();
  const changes = [];
  const timers = [];
  let fail;
  const gate = new Promise((_, reject) => { fail = reject; });
  const client = createChatListSyncClient({
    fetchSync: server.sync,
    fetchPage: async () => gate,
    onChange: (info) => changes.push(info.reason),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutFn: () => {},
  });
  const pending = client.requestSync();
  client.dispose();
  fail(httpError(503));
  await pending;
  assert.equal(timers.length, 0, 'no retry timer after dispose');
  assert.deepEqual(changes, []);
  assert.equal(client.getRows().size, 0);
  assert.equal(client.getPosition(), null);
});
