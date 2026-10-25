import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import express from 'express';
import { createServer, get } from 'node:http';
import { buildHarnessDiagnosticsReport, prepareHarnessDiagnosticsWorker, registerHarnessDiagnosticsRoutes } from '../lib/routes/harness-diagnostics-routes.js';
import { budgetMs } from './helpers/time-budget.js';

test.after(removeIsolatedDataDir);

test('large history is computed off-thread, shared, cached and invalidated', async (t) => {
  const now = new Date().toISOString();
  const file = path.join(ISOLATED_DATA_DIR, 'delegations.json');
  const rows = Array.from({ length: 10_000 }, (_, i) => ({
    id: `synthetic-${i}`, role: 'implement', workRole: 'implement',
    harness: 'codex', model: 'example-model', status: 'completed',
    createdAt: now, updatedAt: now, finishedAt: now,
  }));
  writeFileSync(file, JSON.stringify({ v: 2, items: rows }));
  const app = express();
  registerHarnessDiagnosticsRoutes(app);
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = (route) => new Promise((resolve, reject) => {
    get(`${base}${route}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
      response.on('error', reject);
    }).on('error', reject);
  });
  // This is server startup, not a report: the report cache is still empty.
  const bootStart = performance.now();
  const bootPingStart = performance.now();
  assert.deepEqual(await read('/ping'), { ok: true });
  assert.ok(performance.now() - bootPingStart < 75, 'worker startup does not block HTTP');
  await prepareHarnessDiagnosticsWorker();
  const readyAt = Date.now();
  t.diagnostic(`worker startup=${(performance.now() - bootStart).toFixed(1)}ms`);
  let ticks = 0;
  let maxGap = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const current = performance.now();
    maxGap = Math.max(maxGap, current - previous);
    previous = current;
    ticks += 1;
  }, 10);
  const started = performance.now();
  let report;
  let pingMs;
  try {
    const diagnostics = read('/api/harness-diagnostics?role=implement');
    const duplicate = read('/api/harness-diagnostics?role=implement');
    // Let the diagnostics HTTP handler dispatch work before probing a second route.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pingStart = performance.now();
    assert.deepEqual(await read('/ping'), { ok: true });
    pingMs = performance.now() - pingStart;
    const reports = await Promise.all([diagnostics, duplicate]);
    report = reports[0];
    assert.deepEqual(reports[0], reports[1]);
  } finally {
    clearInterval(timer);
  }
  const coldMs = performance.now() - started;
  t.diagnostic(`cold HTTP=${coldMs.toFixed(1)}ms max timer gap=${maxGap.toFixed(1)}ms concurrent HTTP=${pingMs.toFixed(1)}ms`);
  assert.ok(coldMs < budgetMs(300), `cold report took ${coldMs}ms`);
  assert.ok(pingMs < 75, `concurrent request took ${pingMs}ms`);
  assert.equal(report.ok, true);
  assert.ok(Date.parse(report.generated_at) >= readyAt, 'startup does not precompute a report');
  assert.ok(ticks > 0, 'HTTP event loop continues during cold aggregation');
  assert.ok(maxGap < budgetMs(75), `main thread stalled for ${maxGap}ms`);
  const warmStart = performance.now();
  const cached = await read('/api/harness-diagnostics?role=implement');
  assert.deepEqual(cached, report);
  const warmMs = performance.now() - warmStart;
  t.diagnostic(`warm=${warmMs.toFixed(1)}ms`);
  assert.ok(warmMs < 300, 'cached response stays under 300ms');
  cached.ok = false;
  assert.equal((await read('/api/harness-diagnostics?role=implement')).ok, true);

  // A changed history must produce a new snapshot before the TTL expires.
  writeFileSync(file, JSON.stringify({ v: 2, items: [] }));
  const changed = await buildHarnessDiagnosticsReport({ role: 'implement' });
  assert.equal(changed.stats.canonical.totals.cycles.closed_cycles, 0);
  assert.equal(report.stats.canonical.totals.cycles.closed_cycles, rows.length);
  const usageDir = path.join(ISOLATED_DATA_DIR, 'usage');
  mkdirSync(usageDir, { recursive: true });
  const usageFile = path.join(usageDir, `${now.slice(0, 10)}.jsonl`);
  appendFileSync(usageFile, `${JSON.stringify({ at: now, harness: 'codex', model: 'example-model', inputTokens: 10 })}\n`);
  const afterUsage = await buildHarnessDiagnosticsReport({ role: 'implement' });
  assert.notEqual(afterUsage.generated_at, changed.generated_at);
  const otherRole = await buildHarnessDiagnosticsReport({ role: 'review' });
  assert.equal(otherRole.role, 'review');
});

test('expired reports and different ranges rebuild; worker failures are not retained', async (t) => {
  const input = { role: 'implement', range: { from: '2026-01-01', to: '2026-01-02' } };
  const first = await buildHarnessDiagnosticsReport(input);
  const clock = Date.now();
  t.mock.method(Date, 'now', () => clock + 31_000);
  const expired = await buildHarnessDiagnosticsReport(input);
  assert.notEqual(expired.generated_at, first.generated_at);
  t.mock.restoreAll();
  const other = await buildHarnessDiagnosticsReport({ ...input, range: { from: '2026-02-01', to: '2026-02-02' } });
  assert.notDeepEqual(other.stats.cost.range, first.stats.cost.range);
  const file = path.join(ISOLATED_DATA_DIR, 'delegations.json');
  writeFileSync(file, JSON.stringify({ v: 999, items: [] }));
  await assert.rejects(buildHarnessDiagnosticsReport(input));
  await assert.rejects(buildHarnessDiagnosticsReport(input));
  writeFileSync(file, JSON.stringify({ v: 2, items: [] }));
  assert.equal((await buildHarnessDiagnosticsReport(input)).ok, true);
});

test('persistent workers see changed favorites and added or cleared lockouts', async () => {
  const input = { role: 'implement' };
  const baseline = await buildHarnessDiagnosticsReport(input);
  const model = baseline.models.find((row) => row.harness === 'codex').model;
  writeFileSync(path.join(ISOLATED_DATA_DIR, 'config.json'), JSON.stringify({
    codexChatEnabledModels: [model],
  }));
  const findModel = (report) => report.models.find((row) => row.harness === 'codex' && row.model === model);
  const before = findModel(await buildHarnessDiagnosticsReport(input));
  assert.equal(before.favorite, true, 'changed favorites invalidate the cached catalog');
  assert.equal(before.availability.usage_limited, false);
  const limitsFile = path.join(ISOLATED_DATA_DIR, 'harness-usage-limits.json');
  writeFileSync(limitsFile, JSON.stringify([{
    harness: 'codex', model,
    resetAt: new Date(Date.now() + 60_000).toISOString(),
    detectedAt: new Date().toISOString(), message: 'Rate limit reached',
  }]));
  const limited = findModel(await buildHarnessDiagnosticsReport(input));
  assert.equal(limited.availability.usage_limited, true);
  assert.equal(limited.availability.locked_out, true);
  writeFileSync(limitsFile, '[]');
  const cleared = findModel(await buildHarnessDiagnosticsReport(input));
  assert.equal(cleared.availability.usage_limited, false);
  assert.equal(cleared.availability.locked_out, false);
});
