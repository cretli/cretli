import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { requireAuth } from '../lib/auth.js';
import { registerUsageRoutes } from '../lib/routes/usage-routes.js';
import {
  getHarnessUsageLimit,
  noteUnclassifiedRunError,
} from '../lib/harness-usage-limits.js';
import {
  acknowledgeUnclassifiedSignature,
  buildTelemetryCoverage,
  listUnclassifiedSignatures,
  resetUnclassifiedRegistries,
  syncUnclassifiedErrors,
} from '../lib/usage/unclassified-errors.js';
import { buildHarnessHealth } from '../lib/usage/harness-health.ts';
import { resetUnclassifiedErrorNotifyRateLimit } from '../lib/notifications/notification-producers.ts';

function setup() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-unclassified-'));
  resetUnclassifiedRegistries();
  resetUnclassifiedErrorNotifyRateLimit();
  const published = [];
  const publish = async (item) => { published.push(item); };
  return { dataDir, published, publish, done: () => rmSync(dataDir, { recursive: true, force: true }) };
}

const note = (dataDir, message, extra = {}) => noteUnclassifiedRunError({ harness: 'sdk', model: 'm1', message, dataDir, ...extra });

test('new signature => one notification; repeat => counter only', async () => {
  const t = setup();
  try {
    note(t.dataDir, 'service info not found');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 1);
    assert.match(t.published[0].fingerprint, /^unclassified-errors:sdk:[0-9a-f]{16}#episode:1r0$/);
    note(t.dataDir, 'service info not found');
    note(t.dataDir, 'service info not found');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 1);
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir });
    assert.equal(row.count, 3);
    assert.equal(row.ack.state, 'open');
    assert.equal(row.harness, 'sdk');
    assert.ok(row.firstSeenAt && row.lastSeenAt);
  } finally { t.done(); }
});

test('ACK hides the entry; occurrence after ACK reshows it with exactly one notification', async () => {
  const t = setup();
  try {
    note(t.dataDir, 'subscription plan does not yet include access');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.deepEqual(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version }), { ok: true, version: 1 });
    assert.equal((await listUnclassifiedSignatures({ dataDir: t.dataDir })).length, 0);
    assert.equal((await listUnclassifiedSignatures({ dataDir: t.dataDir, includeAcked: true }))[0].ack.state, 'acked');
    // Syncing without a new occurrence changes nothing.
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 1);
    // Two occurrences after the ACK: reshown, ONE new notification.
    note(t.dataDir, 'subscription plan does not yet include access');
    note(t.dataDir, 'subscription plan does not yet include access');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 2);
    assert.notEqual(t.published[1].fingerprint, t.published[0].fingerprint);
    const shown = await listUnclassifiedSignatures({ dataDir: t.dataDir });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].count, 3);
  } finally { t.done(); }
});

test('stale ACK version loses the race against a newer occurrence', async () => {
  const t = setup();
  try {
    note(t.dataDir, 'weird failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    note(t.dataDir, 'weird failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const res = acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'stale_version');
    assert.equal((await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false })).length, 1);
    assert.equal(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: 'zz' }).reason, 'invalid_id');
  } finally { t.done(); }
});

test('notifications are rate limited', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 8; i += 1) note(t.dataDir, `distinct failure number ${i} alpha${'x'.repeat(i)}`);
    const res = await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish, now: () => 1000 });
    assert.equal(res.notified, 5);
    assert.equal(res.throttled, 3);
    assert.equal(t.published.length, 5);
  } finally { t.done(); }
});

const SECRET_MESSAGE = 'Request failed api_key=sk-abcdef0123456789ABCDEF at /home/maintainer/proj/.env via https://api.example.com/v1/chat?token=abc123 (see ~/.config/x)';

test('API list and health payload never leak key, home path or URL', async () => {
  const t = setup();
  try {
    note(t.dataDir, SECRET_MESSAGE);
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const items = await listUnclassifiedSignatures({ dataDir: t.dataDir });
    const health = buildHarnessHealth({ harness: 'sdk', dataDir: t.dataDir, events: [] });
    const blob = JSON.stringify({ items, health: health.unclassifiedErrors, notices: t.published });
    for (const leak of ['sk-abcdef', 'abc123', '/home/maintainer', 'api.example.com', '.config', 'https://']) {
      assert.ok(!blob.includes(leak), `leaked ${leak}: ${blob}`);
    }
    assert.ok(items[0].message.includes('Request failed'));
  } finally { t.done(); }
});

test('"tool not found" is a separate category, display-only, and never locks a model', async () => {
  const t = setup();
  try {
    note(t.dataDir, 'Tool mcp__x__read not found in agent cli');
    note(t.dataDir, 'service info not found');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const items = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    const compat = items.find((i) => i.category === 'tool_not_found');
    assert.ok(compat);
    assert.equal(items.find((i) => i.category === 'unclassified').message, 'service info not found');
    assert.equal(compat.blocksModel, false);
    assert.equal(getHarnessUsageLimit({ harness: 'sdk', model: 'm1', dataDir: t.dataDir }), null);
    const health = buildHarnessHealth({ harness: 'sdk', dataDir: t.dataDir, events: [] });
    assert.equal(health.unclassifiedErrors.compat.length, 1);
    assert.equal(health.unclassifiedErrors.items.length, 1);
    assert.equal(health.activeLimit, null);
    assert.match(t.published.find((p) => /compatibility/.test(p.title)).title, /Tool compatibility/);
  } finally { t.done(); }
});

test('telemetry coverage alarms on growth in comparable successful runs only', () => {
  const run = (i, outcome, known) => ({
    eventType: 'run', outcome, at: `2026-10-01T00:00:${String(i).padStart(2, '0')}Z`,
    ...(known ? { latencyMs: 10, measurementPresent: true } : {}),
  });
  const growing = [];
  for (let i = 0; i < 8; i += 1) growing.push(run(i, 'ok', true));
  for (let i = 8; i < 16; i += 1) growing.push(run(i, 'ok', i % 2 === 0));
  const cov = buildTelemetryCoverage(growing);
  const ok = cov.categories.find((c) => c.category === 'ok');
  assert.equal(cov.alarm, true);
  assert.equal(ok.severity, 'high');
  // A uniformly high share of unknowns (e.g. cancelled runs) is not an alarm by itself.
  const steady = Array.from({ length: 16 }, (_, i) => run(i, 'aborted', false));
  const steadyCov = buildTelemetryCoverage(steady);
  assert.equal(steadyCov.alarm, false);
  assert.equal(steadyCov.categories[0].measurementUnknownShare, 1);
  // Too few runs to compare: no alarm.
  assert.equal(buildTelemetryCoverage([run(1, 'ok', true), run(2, 'ok', false)]).alarm, false);
});

test('endpoint: 401 without a session, 200 list and ACK through the route', async () => {
  const t = setup();
  const app = express();
  app.use(express.json());
  app.use(requireAuth);
  registerUsageRoutes(app, { dataDir: t.dataDir });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = await fetch(`${base}/api/usage/unclassified-errors`);
    assert.ok([401, 403].includes(get.status), `status ${get.status}`);
    const post = await fetch(`${base}/api/usage/unclassified-errors/ack`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: '0123456789abcdef' }),
    });
    assert.ok([401, 403].includes(post.status), `status ${post.status}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    t.done();
  }
});

test('route handlers: restricted callers get 403; list and ACK work for a session', async () => {
  const t = setup();
  try {
    note(t.dataDir, SECRET_MESSAGE);
    const routes = new Map();
    registerUsageRoutes({ get: (r, h) => routes.set(`GET ${r}`, h), post: (r, h) => routes.set(`POST ${r}`, h) }, { dataDir: t.dataDir });
    const call = async (key, req) => {
      const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
      await routes.get(key)({ query: {}, body: {}, ...req }, res);
      return res;
    };
    assert.equal((await call('GET /api/usage/unclassified-errors', { widgetAccess: {} })).statusCode, 403);
    assert.equal((await call('POST /api/usage/unclassified-errors/ack', { mcpIntegration: {} })).statusCode, 403);
    const list = await call('GET /api/usage/unclassified-errors', {});
    assert.equal(list.body.items.length, 1);
    const ack = await call('POST /api/usage/unclassified-errors/ack', { body: { id: list.body.items[0].id, version: list.body.items[0].version } });
    assert.equal(ack.body.ok, true);
    assert.equal((await call('GET /api/usage/unclassified-errors', {})).body.items.length, 0);
    assert.equal((await call('POST /api/usage/unclassified-errors/ack', { body: { id: '0123456789abcdef' } })).statusCode, 404);
  } finally { t.done(); }
});

test('parallel syncs are serialized: registry version stays equal to the store counter', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 3; i += 1) note(t.dataDir, 'parallel failure');
    await Promise.all([
      syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish }),
      syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish }),
      syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish }),
    ]);
    assert.equal(t.published.length, 1);
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.equal(row.count, 3);
    assert.equal(row.version, 3);
    assert.equal(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version }).ok, true);
    // The next real occurrence after the ACK must reopen the episode and notify.
    note(t.dataDir, 'parallel failure');
    await Promise.all([
      syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish }),
      syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish }),
    ]);
    assert.equal(t.published.length, 2);
    assert.equal((await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false })).length, 1);
  } finally { t.done(); }
});

test('store eviction does not mask a re-occurrence after ACK', async () => {
  const t = setup();
  try {
    for (let i = 0; i < 4; i += 1) note(t.dataDir, 'evicted failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.equal(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version }).ok, true);
    // Simulate the store evicting the row (age / row cap), then the signature recurring.
    writeFileSync(path.join(t.dataDir, 'usage', 'unclassified-errors.jsonl'), '');
    await new Promise((resolve) => setTimeout(resolve, 5));
    note(t.dataDir, 'evicted failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 2);
    const shown = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].ack.state, 'open');
    assert.equal(shown[0].count, 1);
    assert.ok(shown[0].version > 4);
  } finally { t.done(); }
});

test('ACK rejects a version greater than the current counter', async () => {
  const t = setup();
  try {
    note(t.dataDir, 'inflated ack failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    const res = acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version + 100 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'future_version');
    assert.equal((await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false })).length, 1);
    // Later occurrences are not pre-silenced.
    assert.equal(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version }).ok, true);
    note(t.dataDir, 'inflated ack failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 2);
  } finally { t.done(); }
});

test('eviction recreate with the same-millisecond firstSeenAt still reopens an ACKed episode', async () => {
  const t = setup();
  const file = path.join(t.dataDir, 'usage', 'unclassified-errors.jsonl');
  try {
    for (let i = 0; i < 4; i += 1) note(t.dataDir, 'same ms failure');
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    const [row] = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.equal(acknowledgeUnclassifiedSignature({ dataDir: t.dataDir, id: row.id, version: row.version }).ok, true);
    // Recreate the evicted row with an identical firstSeenAt and a restarted counter.
    const stored = JSON.parse(readFileSync(file, 'utf8').trim());
    writeFileSync(file, `${JSON.stringify({ ...stored, count: 1 })}\n`);
    await syncUnclassifiedErrors({ dataDir: t.dataDir, publish: t.publish });
    assert.equal(t.published.length, 2);
    const shown = await listUnclassifiedSignatures({ dataDir: t.dataDir, sync: false });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].ack.state, 'open');
    assert.equal(shown[0].version, 5);
  } finally { t.done(); }
});
