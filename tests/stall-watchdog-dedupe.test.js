import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProfile, computeSignature } from '../lib/server-health/cpu-profile-summary.js';
import { createStallWatchdog } from '../lib/server-health/stall-watchdog.js';
import { createServerStallWatchdog, deferStaleStallTodos, AUTO_DEFER_REASON } from '../lib/server-health/server-stall-watchdog.js';
import { planStallDedupe, summarizePlan, applyStallDedupe } from '../scripts/stall-todos-dedupe.mjs';

const repoRoot = '/srv/app';
const url = (file) => `file://${repoRoot}/${file}`;
const node = (id, functionName, file, children = []) => ({ id, callFrame: { functionName, url: file ? url(file) : '', lineNumber: id }, children });

/** archiveFamilyMembers -> updateChat -> <leaf in chats-persist>; the leaf differs per profile. */
function profile(leafName, caller = 'archiveFamilyMembers', deltaUs = 1000) {
  const nodes = [
    node(1, '(root)', '', [2]),
    node(2, caller, 'lib/chat-archive.js', [3]),
    node(3, 'updateChat', 'lib/persist/chats-persist.js', [4]),
    node(4, leafName, 'lib/persist/chats-persist.js'),
  ];
  return { nodes, samples: [4, 4, 4, 3], timeDeltas: [deltaUs, deltaUs, deltaUs, deltaUs] };
}

test('different hot leaves under one lib/ caller share one signature', () => {
  const sigs = ['copyChatOnWrite', 'serializedRow', 'getOwnPropertyDescriptor']
    .map((leaf) => computeSignature(summarizeProfile(profile(leaf), { repoRoot })));
  assert.equal(new Set(sigs).size, 1);
  const summary = summarizeProfile(profile('copyChatOnWrite'), { repoRoot });
  assert.equal(summary.causes[0].functionName, 'archiveFamilyMembers');
  assert.equal(summary.causes[0].inclusiveMs, 4);
  assert.notEqual(computeSignature(summarizeProfile(profile('copyChatOnWrite', 'otherCaller'), { repoRoot })), sigs[0]);
});

test('repeated stalls with different self-time leaves create one todo and append occurrences', async () => {
  const created = [];
  const occurrences = [];
  const todos = [];
  const wd = createStallWatchdog({
    repoRoot,
    createTodo: async (input) => { created.push(input); todos.push({ id: `t${todos.length}`, body: input.body }); },
    findTodoBySignature: async (sig) => todos.find((t) => t.body.includes(`stall-signature: ${sig}`)) || null,
    onDuplicate: async (todo) => { occurrences.push(todo.id); },
    // A fresh registry per report would be the restart case: dedupe must still hold via the open todo.
    now: () => new Date('2026-11-04T10:00:00Z'),
  });
  for (const leaf of ['copyChatOnWrite', 'serializedRow', 'get', 'writeJsonAtomic']) {
    const summary = summarizeProfile(profile(leaf), { repoRoot });
    await wd.handleReport({ type: 'stall', reason: 'heartbeat', stalledForMs: 6000, summary, profileMs: 2000 });
  }
  assert.equal(created.length, 1);
  assert.match(created[0].title, /archiveFamilyMembers/);
  assert.equal(wd.getState().deduped, 3);
});

test('a restart (empty registry) appends to the open todo instead of creating a new one', async () => {
  const todos = [];
  const occurrences = [];
  const make = () => createStallWatchdog({
    repoRoot,
    createTodo: async (input) => { todos.push({ id: 't1', body: input.body }); },
    findTodoBySignature: async (sig) => todos.find((t) => t.body.includes(`stall-signature: ${sig}`)) || null,
    onDuplicate: async (todo) => { occurrences.push(todo.id); },
  });
  const report = { type: 'stall', reason: 'heartbeat', stalledForMs: 6000, summary: summarizeProfile(profile('serializedRow'), { repoRoot }) };
  assert.equal((await make().handleReport(report)).outcome, 'created');
  assert.equal((await make().handleReport(report)).outcome, 'deduped');
  assert.equal(todos.length, 1);
  assert.deepEqual(occurrences, ['t1']);
});

test('daily cap limits new todos across distinct causes and resets next day', async () => {
  let day = '2026-11-04T10:00:00Z';
  const created = [];
  const wd = createStallWatchdog({
    repoRoot,
    maxNewTodosPerDay: 2,
    createTodo: async (input) => { created.push(input); },
    now: () => new Date(day),
  });
  const report = (caller) => ({ type: 'stall', reason: 'heartbeat', stalledForMs: 6000, summary: summarizeProfile(profile('x', caller), { repoRoot }) });
  assert.equal((await wd.handleReport(report('a'))).outcome, 'created');
  assert.equal((await wd.handleReport(report('b'))).outcome, 'created');
  assert.equal((await wd.handleReport(report('c'))).outcome, 'capped');
  assert.equal(created.length, 2);
  assert.equal(wd.getState().capped, 1);
  day = '2026-11-05T10:00:00Z';
  // A capped cause is not recorded as seen, so it may open a todo on a later day.
  assert.equal((await wd.handleReport(report('c'))).outcome, 'created');
  assert.equal(created.length, 3);
});

// --- Function-level dedupe, occurrence updates, auto-defer and migration ---

const DAY = 24 * 3600 * 1000;

/** In-memory todo store shaped like the persisted API used by the server adapter. */
function fakeStore() {
  const items = [];
  let tick = 0;
  return {
    items,
    addTodo: async (_d, _r, input) => { items.push({ id: `t${items.length}`, createdAt: new Date(Date.UTC(2026, 0, 1) + (tick += 1000)).toISOString(), updatedAt: `u${tick}`, ...input }); },
    listTodos: async () => ({ items }),
    updateTodo: async (_d, _r, id, patch) => {
      const row = items.find((t) => t.id === id);
      const { expectedUpdatedAt, appendChangelog, ...rest } = patch;
      if (expectedUpdatedAt && expectedUpdatedAt !== row.updatedAt) throw new Error('conflict');
      Object.assign(row, rest, { updatedAt: `u${(tick += 1)}` });
      if (rest.status && rest.status !== 'deferred') delete row.deferredReason;
      return row;
    },
  };
}

test('same function with a different signature updates the existing todo instead of creating one', async () => {
  const store = fakeStore();
  let clock = Date.parse('2026-11-04T10:00:00Z');
  const wd = createServerStallWatchdog({
    repoRoot, dataDir: '/x', ...store, publishNotification: () => {}, now: () => clock,
    createWatchdog: (o) => createStallWatchdog({ ...o, registryPath: undefined, thresholdMs: 1, now: () => new Date(clock), maxNewTodosPerDay: 99 }),
  });
  // Same top function/file; the leaf set differs, and a fresh watchdog has an empty registry.
  const first = { type: 'stall', reason: 'heartbeat', stalledForMs: 6000, detectedAt: '2026-11-04T10:00:00.000Z', summary: summarizeProfile(profile('copyChatOnWrite'), { repoRoot }) };
  assert.equal((await wd.handleReport(first)).outcome, 'created');
  const other = summarizeProfile(profile('serializedRow'), { repoRoot });
  other.causes[0].key = first.summary.causes[0].key;
  // Force a different signature while keeping the same function/file in the title.
  const second = { type: 'stall', reason: 'heartbeat', stalledForMs: 9000, detectedAt: '2026-11-05T09:00:00.000Z', summary: { ...other, causes: [], lib: [{ ...first.summary.causes[0], selfMs: 1, percent: 1 }] } };
  assert.notEqual(computeSignature(second.summary), computeSignature(first.summary));
  assert.equal((await wd.handleReport(second)).outcome, 'deduped');
  assert.equal(store.items.length, 1);
  const body = store.items[0].body;
  assert.match(body, /^stall-occurrences: 2$/m);
  assert.match(body, /^stall-max-ms: 9000$/m);
  assert.match(body, /^stall-last-seen: 2026-11-05T09:00:00.000Z$/m);
  assert.match(body, /## Longest stall profile\nRecorded at [^\n]+\n\n### Dominant causes[^\n]*\n- /);
  assert.equal(body.match(/## Longest stall profile/g).length, 1);
});

test('stale idea stall todos are auto-deferred with a reason; a recurrence wakes them', async () => {
  const store = fakeStore();
  const now = Date.parse('2026-11-05T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  store.items.push(
    { id: 'old', status: 'idea', title: 'Event-loop stall: a (lib/a.js)', body: `x\nstall-last-seen: ${iso(now - 8 * DAY)}\nstall-signature: s1`, updatedAt: 'u1' },
    { id: 'fresh', status: 'idea', title: 'Event-loop stall: b (lib/b.js)', body: `x\nstall-last-seen: ${iso(now - 6 * DAY)}`, updatedAt: 'u1' },
    { id: 'legacy', status: 'idea', title: 'Event-loop stall: c (lib/c.js)', body: `- Detected at: ${iso(now - 9 * DAY)}`, updatedAt: 'u1' },
    { id: 'ready', status: 'ready', title: 'Event-loop stall: d (lib/d.js)', body: `stall-last-seen: ${iso(now - 30 * DAY)}`, updatedAt: 'u1' },
    { id: 'other', status: 'idea', title: 'Something else', body: `stall-last-seen: ${iso(now - 30 * DAY)}`, updatedAt: 'u1' },
  );
  const moved = await deferStaleStallTodos({ dataDir: '/x', repoRoot, listTodos: store.listTodos, updateTodo: store.updateTodo, now: () => now });
  assert.deepEqual(moved.sort(), ['legacy', 'old']);
  assert.equal(store.items.find((t) => t.id === 'old').status, 'deferred');
  assert.equal(store.items.find((t) => t.id === 'old').deferredReason, AUTO_DEFER_REASON);
  assert.equal(store.items.find((t) => t.id === 'fresh').status, 'idea');

  let received;
  const wd = createServerStallWatchdog({
    repoRoot, dataDir: '/x', ...store, publishNotification: () => {}, now: () => now,
    createWatchdog: (o) => { received = o; return {}; },
  });
  assert.equal(typeof received.sweepStale, 'function');
  const found = await received.findTodoBySignature('s1', { causeKey: 'zz', title: 'nope' });
  assert.equal(found.id, 'old');
  await received.onDuplicate(found, { signature: 's1', detectedAt: iso(now), stalledForMs: 5000, reason: 'heartbeat', summary: { causes: [], lib: [], top: [] } });
  assert.equal(store.items.find((t) => t.id === 'old').status, 'idea');
  assert.equal(wd.constructor, Object);
});

test('migration: dry-run plans without writing; apply defers duplicates with a link and is idempotent', async () => {
  const store = fakeStore();
  const title = 'Event-loop stall: writeJsonAtomic (lib/persist/json.js)';
  const mk = (id, status, createdAt, extra = '') => ({ id, status, title, createdAt, updatedAt: `u-${id}`, body: `- Detected at: ${createdAt}\n- Main thread unresponsive for: ${extra || 4000} ms\nstall-signature: ${id}` });
  store.items.push(
    mk('a', 'idea', '2026-10-01T00:00:00Z', 4000),
    mk('b', 'deferred', '2026-10-02T00:00:00Z', 9000),
    mk('c', 'idea', '2026-10-03T00:00:00Z', 5000),
    { ...mk('d', 'done', '2026-10-04T00:00:00Z'), body: 'done' },
    { id: 'solo', status: 'idea', title: 'Event-loop stall: other (lib/o.js)', body: '', updatedAt: 'u' },
  );
  const before = JSON.stringify(store.items);
  const plan = planStallDedupe(store.items);
  assert.equal(plan.length, 1);
  const summary = summarizePlan(plan, 5);
  assert.equal(summary.duplicatesToDefer, 2);
  assert.equal(summary.groups[0].primaryId, 'a');
  assert.equal(summary.groups[0].maxMs, 9000);
  assert.equal(JSON.stringify(store.items), before, 'planning must not write');

  await applyStallDedupe(plan, { dataDir: '/x', repoRoot, updateTodo: store.updateTodo });
  const byId = Object.fromEntries(store.items.map((t) => [t.id, t]));
  assert.equal(store.items.length, 5, 'nothing is deleted');
  for (const id of ['b', 'c']) {
    assert.equal(byId[id].status, 'deferred');
    assert.equal(byId[id].sourceTodoId, 'a');
    assert.match(byId[id].body, /^stall-merged-into: a$/m);
    assert.match(byId[id].deferredReason, /Duplicate of stall todo a/);
  }
  assert.equal(byId.a.status, 'idea');
  assert.match(byId.a.body, /^stall-occurrences: 3$/m);
  assert.match(byId.a.body, /^stall-max-ms: 9000$/m);
  assert.equal(byId.d.status, 'done');
  assert.equal(planStallDedupe(store.items).length, 0, 'second run finds nothing to merge');
  // The watchdog never attaches a recurrence to a merged duplicate.
  let received;
  createServerStallWatchdog({ repoRoot, dataDir: '/x', ...store, publishNotification: () => {}, createWatchdog: (o) => { received = o; return {}; } });
  assert.equal((await received.findTodoBySignature('b', { title })).id, 'a');
});

test('longer stall replaces the whole dated profile and keeps max-ms; shorter one does not', async () => {
  const store = fakeStore();
  const diagnostics = [];
  const wd = createServerStallWatchdog({
    repoRoot, dataDir: '/x', ...store, publishNotification: () => {}, now: () => Date.parse('2026-11-04T10:00:00Z'),
    recordDiagnostic: (event, details) => diagnostics.push({ event, details }),
    createWatchdog: (o) => createStallWatchdog({ ...o, registryPath: undefined, now: () => new Date('2026-11-04T10:00:00Z'), maxNewTodosPerDay: 99 }),
  });
  // Same cause (archiveFamilyMembers), different CPU numbers and leaf functions per profile.
  const report = (ms, leaf, deltaUs, at) => ({
    type: 'stall', reason: 'heartbeat', stalledForMs: ms, detectedAt: at, profileMs: 2000,
    summary: summarizeProfile(profile(leaf, 'archiveFamilyMembers', deltaUs), { repoRoot }),
  });
  assert.equal((await wd.handleReport(report(3000, 'firstLeaf', 1000, '2026-11-04T10:00:00.000Z'))).outcome, 'created');
  // First creation initializes the real duration and stall-max-ms.
  assert.match(store.items[0].body, /^stall-max-ms: 3000$/m);
  assert.match(store.items[0].body, /firstLeaf.* 3 ms/);
  assert.equal(diagnostics.length, 0, 'a short stall is not logged to server-diagnostics');
  // 5 s stall: longer than the stored 3 s max, so the whole profile is replaced and dated.
  await wd.handleReport(report(5000, 'secondLeaf', 2000, '2026-11-05T09:00:00.000Z'));
  let body = store.items[0].body;
  assert.match(body, /^stall-max-ms: 5000$/m);
  assert.match(body, /^- Main thread unresponsive for: 5000 ms$/m);
  assert.match(body, /## Longest stall profile\nRecorded at 2026-11-05T09:00:00.000Z; main thread blocked for 5000 ms;/);
  assert.match(body, /secondLeaf.* 6 ms/);
  assert.match(body, /archiveFamilyMembers.* 8 ms \(100%\)/);
  assert.doesNotMatch(body, /firstLeaf/);
  assert.doesNotMatch(body, /archiveFamilyMembers.* 4 ms/);
  assert.equal(body.match(/Top functions overall/g).length, 1);
  // 4 s stall is shorter than the max: counters move, the profile and max stay.
  await wd.handleReport(report(4000, 'thirdLeaf', 3000, '2026-11-06T09:00:00.000Z'));
  body = store.items[0].body;
  assert.match(body, /^stall-max-ms: 5000$/m);
  assert.match(body, /^stall-occurrences: 3$/m);
  assert.match(body, /^stall-last-seen: 2026-11-06T09:00:00.000Z$/m);
  assert.match(body, /secondLeaf/);
  assert.doesNotMatch(body, /thirdLeaf/);
  // A 12 s stall always replaces the profile and is logged with its signature.
  await wd.handleReport(report(12000, 'fourthLeaf', 4000, '2026-11-07T09:00:00.000Z'));
  body = store.items[0].body;
  assert.match(body, /^stall-max-ms: 12000$/m);
  assert.match(body, /fourthLeaf/);
  assert.doesNotMatch(body, /secondLeaf/);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].event, 'long-event-loop-stall');
  assert.match(diagnostics[0].details.message, /signature=[0-9a-f]{12} stalledForMs=12000/);
});

test('long-stall diagnostics are recorded even when todo storage throws', async () => {
  const seen = [];
  const warnings = [];
  const wd = createStallWatchdog({
    repoRoot,
    findTodoBySignature: async () => { throw new Error('disk gone'); },
    createTodo: async () => { throw new Error('disk gone'); },
    onLongStall: (info) => { seen.push(info); },
    logger: { warn: (m) => warnings.push(m) },
  });
  const summary = summarizeProfile(profile('leaf'), { repoRoot });
  const result = await wd.handleReport({ type: 'stall', reason: 'heartbeat', stalledForMs: 15000, summary });
  assert.equal(result.outcome, 'failed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signature, computeSignature(summary));
  assert.equal(seen[0].stalledForMs, 15000);
  // A throwing diagnostics hook must not break report handling either.
  const wd2 = createStallWatchdog({ repoRoot, onLongStall: () => { throw new Error('diag'); }, logger: { warn: () => {} } });
  assert.equal((await wd2.handleReport({ type: 'stall', reason: 'heartbeat', stalledForMs: 15000, summary })).outcome, 'no-createTodo');
  assert.equal(wd2.getState().errors, 1);
});

test('worker reports the real blocked->unblocked duration of a stall', async () => {
  const { Worker } = await import('node:worker_threads');
  const sab = new SharedArrayBuffer(4);
  const beat = new Int32Array(sab);
  const worker = new Worker(new URL('../lib/server-health/stall-watchdog-worker.js', import.meta.url), {
    execArgv: [],
    workerData: { sab, thresholdMs: 300, profileMs: 100, cooldownMs: 0, checkMs: 50, repoRoot, heartbeatFile: '', longStallMs: 700 },
  });
  try {
    const messages = [];
    const report = new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m.type === 'stall' || m.type === 'error') { messages.push(m); resolve(m); } });
      worker.on('error', reject);
    });
    const timer = setInterval(() => Atomics.add(beat, 0, 1), 50);
    await new Promise((r) => setTimeout(r, 200));
    // Block the heartbeat (not the loop, so the test itself keeps running) for ~1.2 s.
    clearInterval(timer);
    await new Promise((r) => setTimeout(r, 1200));
    Atomics.add(beat, 0, 1);
    const msg = await report;
    assert.equal(msg.type, 'stall');
    assert.ok(msg.stalledForMs >= 1100 && msg.stalledForMs < 2500, `real duration, got ${msg.stalledForMs}`);
    // The forced long-stall profile (>700 ms here) must not produce an earlier or extra report.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(messages.length, 1);
    assert.equal(msg.profiledLong, true);
  } finally { await worker.terminate(); }
});
