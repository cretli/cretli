import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetRegistry, validateFleetUrl } from '../lib/fleet/registry.js';
import { FleetPoller, requestFleetSummary } from '../lib/fleet/poller.js';
import { sanitizeFleetSummary } from '../lib/fleet/summary.js';

const token = 'FLEET_SECRET_TEST_9';
const input = { name: 'Team', url: 'https://example.com', token, ownerLabel: 'Owner' };
const summary = { schemaVersion: 1, instance: { online: true }, activeWatcherCycles: 2, blockedTodos: 1, plansAwaitingApproval: 0, providerUsage: { codex: { utilizationPercent: 20, limitPercent: 100 } } };
function registry(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { store: new FleetRegistry({ dataDir }), dataDir };
}
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('registry validates URLs, persists CRUD with 0600 and redacts credentials', (t) => {
  const { store, dataDir } = registry(t);
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=secret', 'file:///tmp/x', 'garbage', 'http://127.0.0.1.evil.com']) assert.throws(() => validateFleetUrl(url), /fleetInvalidInstance/);
  for (const url of ['https://example.com', 'http://127.0.0.1:9000', 'http://localhost', 'http://[::1]']) assert.ok(validateFleetUrl(url));
  assert.throws(() => store.create({ ...input, token: 'bad\r\nheader' }), /fleetInvalidInstance/);
  const entry = store.create(input);
  assert.equal(JSON.stringify(entry).includes(token), false);
  assert.equal(JSON.stringify(store.list()).includes('token'), false);
  assert.equal(fs.statSync(path.join(dataDir, 'fleet-instances.json')).mode & 0o777, 0o600);
  const loaded = new FleetRegistry({ dataDir });
  assert.equal(loaded.credentials(entry.id).token, token);
  loaded.update(entry.id, { name: 'Other' });
  assert.equal(loaded.credentials(entry.id).token, token);
  loaded.update(entry.id, { token: 'rotated' });
  assert.equal(loaded.credentials(entry.id).token, 'rotated');
  loaded.remove(entry.id);
  assert.deepEqual(new FleetRegistry({ dataDir }).list(), []);
  assert.throws(() => loaded.update(entry.id, {}), /fleetInstanceNotFound/);
  assert.throws(() => loaded.remove(entry.id), /fleetInstanceNotFound/);
});

test('storage failures do not mutate memory or expose input', (t) => {
  const { store, dataDir } = registry(t);
  fs.rmSync(dataDir, { recursive: true });
  fs.writeFileSync(dataDir, 'block directory creation');
  t.after(() => fs.rmSync(dataDir, { force: true }));
  assert.throws(() => store.create(input), { message: 'fleetStorageUnavailable' });
  assert.deepEqual(store.list(), []);
});

test('malformed persisted registry fails closed', (t) => {
  const { dataDir } = registry(t);
  fs.writeFileSync(path.join(dataDir, 'fleet-instances.json'), token);
  assert.throws(() => new FleetRegistry({ dataDir }), { message: 'fleetStorageUnavailable' });
});

test('summary drops remote private fields and rejects invalid counters', () => {
  assert.deepEqual(sanitizeFleetSummary({ ...summary, secret: token, instance: { online: true, token }, providerUsage: { ...summary.providerUsage, [token]: { utilizationPercent: 1, limitPercent: 100 } } }), summary);
  for (const bad of [{ ...summary, schemaVersion: 2 }, { ...summary, blockedTodos: -1 }, { ...summary, instance: {} }, { ...summary, providerUsage: { codex: { utilizationPercent: token, limitPercent: 100 } } }]) assert.throws(() => sanitizeFleetSummary(bad));
});

test('poller fake clock: success, backoff, stale/offline, recovery and no overlap', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store } = registry(t);
  const { id } = store.create(input);
  let calls = 0; let fail = false; let release;
  const poller = new FleetPoller(store, { intervalMs: 100, timeoutMs: 50, staleMs: 500, maxBackoffMs: 400, request: async () => { calls++; if (release) await new Promise((r) => { release = r; }); if (fail) throw new Error(token); return summary; } });
  t.after(() => poller.stop());
  poller.start(); poller.start();
  t.mock.timers.tick(0); await settle();
  assert.equal(calls, 1); assert.equal(poller.status(id).state, 'online');
  fail = true;
  t.mock.timers.tick(100); await settle();
  assert.equal(poller.status(id).state, 'stale');
  t.mock.timers.tick(199); await settle(); assert.equal(calls, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 3);
  t.mock.timers.tick(400); await settle(); assert.equal(calls, 4);
  assert.equal(poller.status(id).state, 'offline');
  fail = false;
  t.mock.timers.tick(400); await settle(); assert.equal(poller.status(id).state, 'online');
  release = true;
  t.mock.timers.tick(100); await settle(); const count = calls;
  t.mock.timers.tick(40); await settle(); assert.equal(calls, count);
  release(); release = null; await settle();
  assert.equal(JSON.stringify(poller.list()).includes(token), false);
  poller.stop(); t.mock.timers.tick(10000); await settle(); assert.equal(calls, count);
});

test('timeout aborts, backs off; removal/update/shutdown cancel pending work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store } = registry(t); const { id } = store.create(input);
  const signals = []; let calls = 0;
  const poller = new FleetPoller(store, { intervalMs: 100, timeoutMs: 50, request: (_entry, signal) => { calls++; signals.push(signal); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(token)))); } });
  t.after(() => poller.stop()); poller.start();
  t.mock.timers.tick(0); await settle();
  t.mock.timers.tick(50); await settle(); assert.equal(signals[0].aborted, true);
  t.mock.timers.tick(199); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await settle(); assert.equal(calls, 2);
  store.update(id, { token: 'replacement' }); assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(0); await settle(); assert.equal(calls, 3);
  store.remove(id); assert.equal(signals[2].aborted, true);
  t.mock.timers.tick(1000); await settle(); assert.deepEqual(poller.list(), []); assert.equal(calls, 3);
  store.create(input); t.mock.timers.tick(0); await settle();
  poller.stop(); assert.equal(signals[3].aborted, true);
  t.mock.timers.tick(1000); await settle(); assert.equal(calls, 4);
});

test('MCP transport sends tools/call, handles JSON/SSE and rejects errors/redirects', async (t) => {
  const http = await import('node:http');
  let mode = 'json'; let seen;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen = { url: req.url, headers: req.headers, body: JSON.parse(body) };
    if (mode === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
    const result = { jsonrpc: '2.0', id: 1, result: { structuredContent: summary } };
    if (mode === 'error') result.result = { isError: true, content: [{ type: 'text', text: token }] };
    res.setHeader('Content-Type', mode === 'sse' ? 'text/event-stream' : 'application/json');
    res.end(mode === 'sse' ? `event: message\ndata: ${JSON.stringify(result)}\n\n` : JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const entry = { ...input, url: `http://127.0.0.1:${server.address().port}` };
  for (mode of ['json', 'sse']) assert.deepEqual(await requestFleetSummary(entry, new AbortController().signal), summary);
  assert.equal(seen.url, '/mcp'); assert.equal(seen.headers.authorization, `Bearer ${token}`);
  assert.equal(seen.body.method, 'tools/call'); assert.equal(seen.body.params.name, 'fleet_summary');
  mode = 'error'; await assert.rejects(requestFleetSummary(entry), { message: 'fleetPollFailed' });
  mode = 'redirect'; await assert.rejects(requestFleetSummary(entry));
});

test('slow polls never overlap and late completion after removal cannot restore status', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { store } = registry(t); const { id } = store.create(input);
  let calls = 0; let complete;
  const poller = new FleetPoller(store, { intervalMs: 100, timeoutMs: 1000, request: () => { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  t.after(() => poller.stop()); poller.start();
  t.mock.timers.tick(0); await settle();
  t.mock.timers.tick(500); await settle(); assert.equal(calls, 1);
  store.remove(id);
  complete({ ...summary, token }); await settle();
  assert.deepEqual(poller.list(), []);
  assert.equal(poller.status(id).summary, null);
  t.mock.timers.tick(10000); await settle(); assert.equal(calls, 1);
});
