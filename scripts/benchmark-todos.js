#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { workspaceKeyFromCwd } from '../lib/persist/todos-persist.js';

const self = fileURLToPath(import.meta.url);
const smoke = process.argv.includes('--smoke');
const counts = smoke ? { noop: 2, changes: 2, bytes: 22_300 } : { noop: 1000, changes: 1000, bytes: 22_300_000 };
const smokeBytes = process.argv.find((arg) => arg.startsWith('--smoke-bytes='));
if (smoke && smokeBytes) {
  counts.bytes = Number(smokeBytes.slice('--smoke-bytes='.length));
  if (!Number.isSafeInteger(counts.bytes) || counts.bytes < 1) throw new Error('Invalid smoke fixture size');
}
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p95: sorted[Math.ceil(sorted.length * .95) - 1] ?? null, p99: sorted[Math.ceil(sorted.length * .99) - 1] ?? null, max: sorted.at(-1) ?? null };
};
// Linux per-thread counters isolate the SQLite worker from main-thread overlay writes.
const workerIo = () => fs.readdirSync('/proc/self/task').filter((id) => id !== String(process.pid)).reduce((sum, id) => {
  try { return sum + Number(fs.readFileSync(`/proc/self/task/${id}/io`, 'utf8').match(/^write_bytes:\s+(\d+)/m)?.[1] ?? 0); } catch { return sum; }
}, 0);
const io = () => Number(fs.readFileSync('/proc/self/io', 'utf8').match(/^write_bytes:\s+(\d+)/m)?.[1] ?? NaN);
const timed = async (fn, samples) => { const start = performance.now(); const result = await fn(); samples.push(performance.now() - start); return result; };

async function workload(kind, root) {
  const { createLegacyJsonTodosBackend } = await import('../lib/persist/todos-store.js');
  const { getWriteStats, resetWriteStats } = await import('../lib/persist/atomic-write.js');
  const { aggregateTodosWriteStats } = await import('../lib/server-diagnostics.js');
  const { upsertWorkspaceWatcher, getWorkspaceWatcher, loadWorkspaceWatchersDocument } = await import('../lib/persist/workspace-watchers-persist.js');
  const migration = await import('../lib/storage/todos-migration.js');
  const { TODOS_SQLITE_FILE } = await import('../lib/persist/todos-backend-marker.js');
  const cwd = path.join(root, 'workspace-a'), target = path.join(root, 'workspace-b');
  fs.mkdirSync(cwd); fs.mkdirSync(target);
  const key = workspaceKeyFromCwd(cwd), targetKey = workspaceKeyFromCwd(target);
  const stamp = '2026-01-01T00:00:00.000Z';
  const perRow = Math.floor(counts.bytes / 50);
  const bodyLength = Math.min(8000, perRow);
  const planLength = Math.min(32000, Math.max(0, perRow - bodyLength));
  const logLength = Math.min(400000, Math.max(0, perRow - bodyLength - planLength));
  const changelog = Array.from({ length: Math.ceil(logLength / 4000) }, (_, i) => ({ kind: 'note', text: 'c'.repeat(Math.min(4000, logLength - i * 4000)), at: stamp }));
  const doc = { version: 3, updatedAt: stamp, idempotency: {}, items: Array.from({ length: 50 }, (_, i) => ({
    id: `todo-${i}`, title: `Task ${i}`, status: 'ready', parentId: '', siblingIndex: i,
    createdAt: stamp, updatedAt: stamp, body: 'x'.repeat(bodyLength), plan: { markdown: 'p'.repeat(planLength) }, changelog, futureField: { preserved: true },
  })) };
  fs.mkdirSync(path.join(root, 'todos'), { recursive: true });
  fs.writeFileSync(path.join(root, 'todos', `${key}.json`), JSON.stringify(doc));
  fs.writeFileSync(path.join(root, 'todos', `${targetKey}.json`), JSON.stringify({ version: 3, updatedAt: stamp, items: [], idempotency: {} }));
  const fixtureBytes = fs.statSync(path.join(root, 'todos', `${key}.json`)).size;
  let opened, backend = createLegacyJsonTodosBackend();
  let rehearsal = null;
  const batches = [];
  if (kind === 'sqlite') {
    // Rehearse on a verified copy; the original fixture remains available for comparison.
    const copy = path.join(root, 'rehearsal-copy');
    fs.cpSync(path.join(root, 'todos'), path.join(copy, 'todos'), { recursive: true });
    assert.equal(hash(fs.readFileSync(path.join(copy, 'todos', `${key}.json`))), hash(fs.readFileSync(path.join(root, 'todos', `${key}.json`))));
    const opts = { dataDir: copy, datasetGeneration: 'todos-gen-1', minQuietMs: 0 };
    const plan = migration.planTodosMigration(opts);
    const applied = migration.applyTodosMigration({ ...opts, confirmPlanHash: plan.planHash });
    const verification = migration.verifyTodosStoreAgainstDocs(path.join(copy, TODOS_SQLITE_FILE), { [key]: doc, [targetKey]: { version: 3, updatedAt: stamp, items: [], idempotency: {} } });
    const { openSqliteTodosBackend, FAULT_HANDLERS } = await import('../tests/fixtures/todos-sqlite-harness.js');
    opened = await openSqliteTodosBackend({ dataDir: copy, bootstrap: false, handlersPath: FAULT_HANDLERS, faultInjection: true, nudge: () => {} });
    // Include a durable post-import ACK in the rollback export.
    await opened.store.updateTodo({ commandId: 'rehearsal-ack', workspaceKey: key, id: 'todo-0', expectedUpdatedAt: stamp, set: { title: 'Post-cutover ACK' } });
    await opened.close();
    const exported = migration.exportTodosRollback({ dataDir: copy, outDir: path.join(root, 'logical-export') });
    const checked = migration.verifyTodosRollbackExport({ dataDir: copy, exportDir: exported.outDir });
    const activated = migration.activateTodosRollback({ dataDir: copy, exportDir: exported.outDir });
    const { openTodosRuntime } = await import('../lib/persist/todos-runtime.js');
    const rolled = await openTodosRuntime({ dataDir: copy, fence: 1 });
    assert.equal((await rolled.backend.getTodo(copy, cwd, 'todo-0')).title, 'Post-cutover ACK');
    await rolled.close();
    rehearsal = { migration: applied.marker.backend, verification, rollback: activated.marker.backend, manifestHash: checked.manifestHash, postAckPreserved: true };
    const fixturePlan = migration.planTodosMigration({ dataDir: root, datasetGeneration: 'todos-gen-1', minQuietMs: 0 });
    migration.applyTodosMigration({ dataDir: root, datasetGeneration: 'todos-gen-1', minQuietMs: 0, confirmPlanHash: fixturePlan.planHash });
    opened = await openSqliteTodosBackend({ dataDir: root, bootstrap: false, handlersPath: FAULT_HANDLERS, faultInjection: true, nudge: () => {}, wrapStore: (store) => ({
      ...store, batch: async (args) => {
        const bytes = Buffer.byteLength(JSON.stringify(args));
        const start = performance.now();
        try { return await store.batch(args); } finally { batches.push({ bytes, ms: performance.now() - start }); }
      },
    }) });
    backend = opened.backend;
  }
  resetWriteStats();
  const hist = monitorEventLoopDelay({ resolution: 1 }); hist.enable();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const writes = [], noop = [], lists = [], indexedLists = [], details = [], claims = [], checkpoints = [];
  const initialIo = io(), initialWorkerIo = workerIo();
  try {
  for (let i = 0; i < counts.noop; i++) await timed(() => backend.updateTodo(root, cwd, 'todo-0', { title: 'Task 0' }), noop);
  const noopBytes = io() - initialIo, noopWorkerBytes = workerIo() - initialWorkerIo;
  const changeIo = io(), changeWorkerIo = workerIo();
  for (let i = 0; i < counts.changes; i++) {
    await timed(() => backend.updateTodo(root, cwd, `todo-${i % 50}`, { title: `Changed ${i}` }), writes);
    if (i % 100 === 0) process.stderr.write(`${kind}: changes ${i}/${counts.changes}\n`);
  }
  const changeBytes = io() - changeIo, changeWorkerBytes = workerIo() - changeWorkerIo;
  const steadyMetrics = opened?.host.getMetrics();
  for (let i = 0; i < 20; i++) {
    const list = await timed(() => backend.listTodos(root, cwd), lists); assert.equal(list.items.length, 50);
    await timed(() => backend.getTodo(root, cwd, 'todo-0'), details);
    if (opened) assert.equal((await timed(() => opened.store.listTodos({ workspaceKey: key, limit: 50 }), indexedLists)).items.length, 50);
  }
  const beforeConflict = await backend.getTodo(root, cwd, 'todo-0');
  await assert.rejects(async () => backend.updateTodo(root, cwd, 'todo-0', { expectedUpdatedAt: 'stale', title: 'Rejected' }), (e) => /** @type {any} */ (e).code === 'CONFLICT');
  assert.deepEqual(await backend.getTodo(root, cwd, 'todo-0'), beforeConflict);
  upsertWorkspaceWatcher(cwd, { mode: 'observe' }, { dataDir: root });
  const row = getWorkspaceWatcher(cwd, { dataDir: root });
  const claimed = await timed(() => backend.commitWatcherTodoCommand(root, cwd, {
    todoId: 'todo-0', expectedTodoUpdatedAt: beforeConflict.updatedAt, expectedWatcherUpdatedAt: row.updatedAt,
    expectedWatcherRevision: loadWorkspaceWatchersDocument({ dataDir: root }).revision,
    decide: () => ({ todoPatch: { status: 'doing' }, watcherPatch: { mode: 'autopilot' } }),
  }), claims);
  assert.equal(claimed.ok, true);
  const moving = await backend.getTodo(root, cwd, 'todo-49');
  await backend.moveTodo({ dataDir: root, sourceFolder: cwd, targetFolder: target, todoId: moving.id, expectedUpdatedAt: moving.updatedAt });
  assert.equal((await backend.listTodos(root, cwd)).items.length, 49);
  assert.equal((await backend.listTodos(root, target)).items.length, 1);
  const burst = [];
  const pendingBurst = Array.from({ length: 200 }, (_, i) => timed(() => backend.updateTodo(root, cwd, `todo-${i % 49}`, { title: `Burst ${i}` }), burst));
  const priorityProbe = [];
  if (opened) for (const priority of ['stop', 'claim', 'final']) pendingBurst.push(timed(() => opened.host.control('ping', { priority }), priorityProbe));
  await Promise.all(pendingBurst);
  let workerLoss = 'not applicable (no worker)';
  if (opened) {
    const args = { commandId: 'lost-ack', workspaceKey: targetKey, item: { id: 'lost', title: 'Recovered', status: 'ready', updatedAt: stamp } };
    await opened.host.command('test.arm', { commandId: args.commandId, mode: 'afterCommitExit' });
    await assert.rejects(opened.store.addTodo(args), (e) => /** @type {any} */ (e).code === 'unknown_commit');
    assert.equal((await opened.store.resolveUnknown({ ...args, operation: 'add' })).outcome, 'committed');
    assert.equal((await opened.store.addTodo(args)).replayed, true);
    await opened.store.deleteTodo({ commandId: 'remove-lost', workspaceKey: targetKey, id: 'lost' });
    workerLoss = 'PASS: committed receipt resolved; same command replayed exactly once';
    for (let i = 0; i < 20; i++) await timed(() => opened.host.control('checkpoint'), checkpoints);
  }
  await new Promise((resolve) => setTimeout(resolve, 10)); hist.disable();
  const stats = aggregateTodosWriteStats(getWriteStats().rows);
  const exports = [await backend.exportSnapshot(root, cwd), await backend.exportSnapshot(root, target)];
  // Timestamps differ between independent runs; content/order/unknown fields remain comparable.
  const logical = JSON.parse(JSON.stringify(exports), (k, v) => ['updatedAt', 'createdAt', 'at'].includes(k) ? '<timestamp>' : typeof v === 'string' ? v.replaceAll(root, '<fixture-root>') : v);
  const dbBytes = kind === 'sqlite' ? ['', '-wal'].reduce((n, suffix) => n + (fs.existsSync(path.join(root, `${TODOS_SQLITE_FILE}${suffix}`)) ? fs.statSync(path.join(root, `${TODOS_SQLITE_FILE}${suffix}`)).size : 0), 0) : null;
  const metrics = opened?.host.getMetrics();
  const result = { kind, fixtureBytes, fixtureHash: hash(doc), logicalExportHash: hash(logical), counts, stats, noopBytes, noopWorkerBytes, changeBytes, changeWorkerBytes, batches: { count: batches.length, maxBytes: Math.max(0, ...batches.map((b) => b.bytes)), ...summary(batches.map((b) => b.ms)) }, priorityProbe: summary(priorityProbe), bytesPerChange: changeBytes / counts.changes,
    writes: summary(writes.slice(0, 20)), allChanges: summary(writes), noop: summary(noop), list: summary(lists), indexedList: summary(indexedLists), detail: summary(details), claim: summary(claims), burst: summary(burst),
    eventLoop: { resolutionMs: 1, p99: hist.percentile(99) / 1e6, max: hist.max / 1e6 }, checkpoints: summary(checkpoints), steadyMetrics, metrics, dbBytes, workerLoss, rehearsal };
  if (opened) await opened.close();
  return result;
  } catch (error) {
    hist.disable();
    const failure = /** @type {any} */ (error);
    const result = { kind, fixtureBytes, fixtureHash: hash(doc), counts, rehearsal,
      runtimeFailure: { code: failure.code ?? 'error', operation: failure.details?.operation ?? 'unknown', commitState: failure.details?.commitState ?? 'unknown' },
      completed: { noop: noop.length, changes: writes.length, list: lists.length },
      stats: aggregateTodosWriteStats(getWriteStats().rows), metrics: opened?.host.getMetrics(),
    };
    if (opened) await opened.close();
    return result;
  }
}

function blockedReport(json, sqlite, sqliteVersion) {
  const reason = `${sqlite.runtimeFailure.code}/${sqlite.runtimeFailure.operation}`;
  const gates = [
    ['Changed write ACK p95 / p99 ms', '120 / 250'],
    ['Worker queue + execute p95 / p99 ms', '80 / 180'],
    ['Indexed list 50 rows p95 / p99 ms', '40 / 90'],
    ['Event loop p99 / max ms at 1 ms', '25 / 100'],
    ['Steady queue age p95 ms', '200'], ['Burst 200 max ms', '2000'],
    ['Stop/claim/final priority wait ms', '500'],
    ['1000 changes DB+WAL written bytes / JSON', '0.25'], ['No-op bytes', '0'],
    ['Checkpoint p99 ms', '500'], ['Group commit batch bytes / ms', '262144 / 40'],
    ['Todos JSON writes', '0'], ['Full main-thread document serializations', '0'],
    ['Todos JSON stringifyMs SQLite / JSON', '0.01'],
    ['CAS / watcher claim / two-workspace move / COMMIT loss', 'all correct'],
    ['Count / logical export hash after workload', 'equal'],
  ];
  return `# Todos backend benchmark

Generated: ${new Date().toISOString()}. Command: \`node scripts/benchmark-todos.js\`.

**Cutover BLOCKED.** The default SQLite facade cannot execute the required
50-row / ${sqlite.fixtureBytes}-byte fixture: first no-op read fails with
\`${reason}\` (worker result limit 4 MiB). No production limit or wiring was
changed. The fixture was seeded with the verified offline migration, because a
full-document worker import also exceeds the request limit. The refusal is a
real L4 backend blocker; unexecuted gates below FAIL certification, not fabricated
latency values. Production remains unchanged.

CPU: ${os.cpus()[0].model}; logical CPUs: ${os.cpus().length}; RAM: ${os.totalmem()} bytes;
platform: ${os.platform()} ${os.arch()} ${os.release()}; Node: ${process.version}; SQLite: ${sqliteVersion}.
Fixture hash (identical in both backends): ${sqlite.fixtureHash}.
Synthetic L2-size equivalent; the historical L2 fixture is unavailable.

JSON completed ${json.counts.noop} no-ops, ${json.counts.changes} changes (first 20 for
ACK latency), list/detail, CAS refusal, watcher claim, two-workspace move and burst
200. SQLite completed ${sqlite.completed.noop} no-ops, ${sqlite.completed.changes}
changes and ${sqlite.completed.list} lists. Histogram resolution: 1 ms. API latency
uses performance.now(). Physical bytes use Linux write_bytes; worker-thread
counters isolate SQLite from main-thread overlay writes. These counters measure
block writes, not syscall byte counts; DB+WAL footprint is reported separately
when a workload completes. No thresholds were lowered.

| Gate | Value | Limit | Result |
| --- | --- | --- | --- |
${gates.map(([name, limit]) => `| ${name} | unavailable: ${reason}; workload did not complete | ${limit} | FAIL |`).join('\n')}

The SQLite todos-key counters at refusal are ${JSON.stringify(sqlite.stats)};
JSON stringifyMs is ${json.stats.stringifyMs}. The apparent zero SQLite/JSON ratio
**cannot certify the <=1% gate** because SQLite did not execute the same workload.
All unavailable gates above are recorded cutover blockers. Full-document
materialization/diff serialization in the facade is an additional known blocker.

## Copy rehearsal

PASS: copied synthetic fixture, verified byte hash, migration to SQLite,
workspace/item/canonical-hash verification, one new durable post-import ACK,
clean close, logical export with receipts/fence, export verification, rollback
activation, sidecar-aware runtime read. Post-cutover ACK preserved.
Manifest: ${sqlite.rehearsal.manifestHash}.
Verification canonical hash: ${sqlite.rehearsal.verification.canonicalHash}.
The small post-import worker command works; the full-document facade read is what
fails. This was a synthetic data copy in OS temp, not a production backup.
Temporary files are removed by the command after reporting.

## Actual measurements

\`\`\`json
${JSON.stringify({ json, sqlite }, null, 2)}
\`\`\`
`;
}

function report(json, sqlite, sqliteVersion) {
  if (sqlite.runtimeFailure) return blockedReport(json, sqlite, sqliteVersion);
  const gates = [];
  const gate = (name, value, limit, pass) => gates.push({ name, value, limit, verdict: pass ? 'PASS' : 'FAIL' });
  const pair = (name, value, p95, p99) => { gate(`${name} p95`, value?.p95 ?? 'unmeasured', p95, value?.p95 != null && value.p95 <= p95); gate(`${name} p99`, value?.p99 ?? 'unmeasured', p99, value?.p99 != null && value.p99 <= p99); };
  pair('API changed write ACK ms', sqlite.writes, 120, 250);
  pair('Worker queue + execute + reply ms (conservative)', sqlite.steadyMetrics?.requestMs, 80, 180);
  pair('Indexed list 50 rows ms', sqlite.indexedList, 40, 90);
  gate('Event loop p99 ms', sqlite.eventLoop.p99, 25, sqlite.eventLoop.p99 <= 25);
  gate('Event loop max ms', sqlite.eventLoop.max, 100, sqlite.eventLoop.max <= 100);
  gate('Steady queue age p95 ms', sqlite.steadyMetrics?.queue.queueAgeMs.p95, 200, sqlite.steadyMetrics?.queue.queueAgeMs.p95 <= 200);
  gate('Burst 200 API completion max ms (includes queue)', sqlite.burst.max, 2000, sqlite.burst.max <= 2000);
  gate('Watcher claim ms', sqlite.claim.max, 500, sqlite.claim.max <= 500);
  gate('Stop/claim/final worker priority ACK ms (includes wait)', sqlite.priorityProbe.max, 500, sqlite.priorityProbe.max != null && sqlite.priorityProbe.max <= 500);
  gate('1000 changes DB+WAL worker write_bytes / JSON process write_bytes', sqlite.changeWorkerBytes / json.changeBytes, .25, sqlite.changeWorkerBytes >= 0 && json.changeBytes > 0 && sqlite.changeWorkerBytes / json.changeBytes <= .25);
  gate('No-op physical write bytes (includes overlay)', sqlite.noopBytes, 0, sqlite.noopBytes === 0);
  gate('Checkpoint p99 ms', sqlite.checkpoints.p99, 500, sqlite.checkpoints.p99 != null && sqlite.checkpoints.p99 <= 500);
  gate('Transaction batch payload bytes (no group commit enabled)', sqlite.batches.maxBytes, 262144, sqlite.batches.maxBytes <= 262144);
  gate('Transaction batch ACK max ms (includes queue/reply)', sqlite.batches.max, 40, sqlite.batches.max != null && sqlite.batches.max <= 40);
  gate('Todos JSON writes (getWriteStats)', sqlite.stats.writes, 0, sqlite.stats.writes === 0);
  gate('Full document main-thread serializations', 'present: materialize + diffDocuments + normalized overlay', 0, false);
  const ratio = json.stats.stringifyMs > 0 ? sqlite.stats.stringifyMs / json.stats.stringifyMs : null;
  gate('Todos JSON stringifyMs SQLite / JSON', ratio ?? 'no nonzero baseline', .01, ratio !== null && ratio <= .01);
  gate('Logical export content/order hash equality', `${sqlite.logicalExportHash} / ${json.logicalExportHash}`, 'equal', sqlite.logicalExportHash === json.logicalExportHash);
  gate('CAS / counts / receipt reconciliation', sqlite.workerLoss, 'correct', sqlite.workerLoss.startsWith('PASS'));
  const blockers = gates.filter((g) => g.verdict === 'FAIL');
  return `# Todos backend benchmark\n\nGenerated: ${new Date().toISOString()}. Command: \`node scripts/benchmark-todos.js\`. ${smoke ? '**SMOKE ONLY; not acceptance evidence.**' : 'Full workload.'}\n\nCPU: ${os.cpus()[0].model}; logical CPUs: ${os.cpus().length}; RAM: ${os.totalmem()} bytes; platform: ${os.platform()} ${os.arch()} ${os.release()}; Node: ${process.version}; SQLite: ${sqliteVersion}. No host/user names recorded.\n\n50 rows, ${sqlite.fixtureBytes} JSON bytes; ${sqlite.counts.noop} no-op updates, ${Math.min(20, sqlite.counts.changes)} measured changed writes plus ${Math.max(0, sqlite.counts.changes - 20)} for the byte workload, list/detail, CAS refusal, watcher claim, two-workspace move, burst 200, worker exit after COMMIT. Fresh independent backends use identical fixture hash ${sqlite.fixtureHash}. L2 historical fixture is unavailable; this is a synthetic equivalent, not a historical comparison.\n\nHistogram resolution: 1 ms. API ACK uses performance.now(); host metrics are bounded rolling samples (last window), not merged percentiles. Worker request time includes queue, execute and reply; execute and queue metrics are included below. Physical process write_bytes includes overlay and lock writes; DB+WAL footprint is not bytes written. Linux non-main-thread write_bytes isolates worker writes (DB/WAL, including checkpoint writes) during the change window; the JSON denominator is total process write_bytes (including lock overhead). This is physical block accounting, not a syscall byte tracer. Batch metrics measure facade transaction batches including queue/reply; independent-command group commit is not enabled. Stop/claim/final probes are worker ping requests submitted alongside the burst, not application Stop commands. Scratch JSON writes outside the configured root are excluded from getWriteStats todos keys; the full-document serialization gate independently FAILs.\n\n| Gate | Value | Limit | Result |\n| --- | --- | --- | --- |\n${gates.map((g) => `| ${g.name} | ${g.value} | ${g.limit} | ${g.verdict} |`).join('\n')}\n\n## Cutover blockers\n\n${blockers.map((g) => `- ${g.name}: ${g.value}`).join('\n')}\n\nNo thresholds were lowered. These failures block cutover. Production wiring is unchanged.\n\n## Copy rehearsal\n\nVerified fixture copy -> migration -> count/canonical-hash verification -> new durable ACK -> clean worker close -> logical export with receipts/fence -> verification -> rollback activation -> sidecar-aware runtime read: PASS. Post-cutover ACK preserved. Export manifest: ${sqlite.rehearsal.manifestHash}. This is a synthetic data-copy rehearsal in OS temp, not a production backup rehearsal. Temporary files are removed after reporting.\n\n## Raw measurements\n\n\`\`\`json\n${JSON.stringify({ json, sqlite }, null, 2)}\n\`\`\`\n`;
}

try {
  if (process.argv.includes('--worker')) {
    console.log = (...args) => console.error(...args);
    const kind = process.argv[process.argv.indexOf('--worker') + 1];
    const result = await workload(kind, process.env.CRETLI_DATA_DIR);
    process.stdout.write(`\nTODOS_BENCHMARK_RESULT=${JSON.stringify(result)}\n`);
  } else {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todos-benchmark-'));
    try {
      const results = {};
      for (const kind of ['json', 'sqlite']) {
        const dir = path.join(root, kind); fs.mkdirSync(dir);
        const child = spawnSync(process.execPath, [self, '--worker', kind, ...(smoke ? ['--smoke', ...(smokeBytes ? [smokeBytes] : [])] : [])], { env: { ...process.env, CRETLI_DATA_DIR: dir }, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
        if (child.status !== 0) throw new Error(`${kind} workload exited ${child.status}`);
        const resultLine = child.stdout.split('\n').find((line) => line.startsWith('TODOS_BENCHMARK_RESULT='));
        if (!resultLine) throw new Error('Missing workload result');
        results[kind] = JSON.parse(resultLine.slice('TODOS_BENCHMARK_RESULT='.length));
      }
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:'); const version = db.prepare('select sqlite_version() as version').get().version; db.close();
      const outputArg = process.argv.find((arg) => arg.startsWith('--out='));
      const output = outputArg ? outputArg.slice(6) : smoke ? path.join(root, 'smoke.md') : 'docs/storage-todos-benchmark.md';
      fs.writeFileSync(output, report(results.json, results.sqlite, version));
      console.log(JSON.stringify({ report: output, smoke, rehearsal: 'PASS', fixtureHashesEqual: results.json.fixtureHash === results.sqlite.fixtureHash, runtimeFailure: results.sqlite.runtimeFailure ?? null }));
      if (results.sqlite.runtimeFailure) process.exitCode = 1;
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
} catch (error) { console.error(error); process.exit(1); }
