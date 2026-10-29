import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-port-exposure-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = path.join(temp, 'data');
const auth = await import('../lib/auth.js');
const { createPortExposureService } = await import('../lib/port-exposure/service.js');
const { createExposureLedger } = await import('../lib/port-exposure/ledger.js');
const { normalizePortExposurePolicy } = await import('../lib/port-exposure/policy.js');
const { createBackend, selectBackendKind } = await import('../lib/port-exposure/backends.js');
const { registerPortExposureRoutes } = await import('../lib/routes/port-exposure-routes.js');

let seq = 0;
const nextFile = () => path.join(temp, `ledger-${seq += 1}.json`);

const natReport = (over = {}) => ({
  platform: 'wsl2', networkingMode: 'nat', wslAddresses: ['172.20.0.2'], listeners: [], portproxy: [], ...over,
});

/** Fake Windows executor recording every operation and keeping portproxy state. */
function fakeExecutor() {
  const calls = [];
  const rules = { portproxy: [], firewall: [] };
  return {
    calls, rules,
    async run(op) {
      calls.push(op);
      if (op.op === 'portproxy-add') rules.portproxy.push({ listenAddress: '0.0.0.0', listenPort: op.port, connectAddress: op.connectAddress, connectPort: op.port });
      if (op.op === 'portproxy-delete') rules.portproxy = rules.portproxy.filter((r) => r.listenPort !== op.port);
      if (op.op === 'firewall-add') rules.firewall.push(op.port);
      if (op.op === 'firewall-delete') rules.firewall = rules.firewall.filter((p) => p !== op.port);
      return { ok: true };
    },
    async listRules() { return { portproxy: [...rules.portproxy], firewall: [...rules.firewall] }; },
  };
}

function setup({ report = natReport(), executor = null, policy = {}, makeBackend, start = Date.parse('2026-01-01T00:00:00Z') } = {}) {
  const state = { report, t: start };
  const ledger = createExposureLedger({ file: nextFile() });
  const service = createPortExposureService({
    ledger,
    getPolicy: () => normalizePortExposurePolicy(policy),
    getReport: async () => state.report,
    executor,
    makeBackend,
    now: () => state.t,
  });
  return { state, ledger, service, executor };
}
const op = { kind: 'operator' };

test('hard blocks return distinct codes', async () => {
  const { service } = setup({ report: natReport({ listeners: [{ address: '127.0.0.1', port: 4000, pid: 1, command: 'node' }] }) });
  assert.equal((await service.expose({ port: 9222 }, op)).error, 'port-denylisted');
  assert.equal((await service.expose({ port: 80 }, op)).error, 'port-out-of-range');
  assert.equal((await service.expose({ port: 4000 }, op)).error, 'port-loopback-only');
  assert.equal((await service.expose({ port: 'abc' }, op)).error, 'port-invalid');
  assert.equal((await service.expose({ port: 70000 }, op)).error, 'port-invalid');
  const codes = new Set(['port-denylisted', 'port-out-of-range', 'port-loopback-only', 'port-invalid']);
  assert.equal(codes.size, 4);
});

test('denylist is configurable and keeps the built-in debug ports', () => {
  const p = normalizePortExposurePolicy({ denylist: [4500], agentMode: 'bogus' });
  assert.ok(p.denylist.includes(4500) && p.denylist.includes(9222));
  assert.equal(p.agentMode, 'ask');
});

test('a listener on 0.0.0.0 is not loopback-only', async () => {
  const { service } = setup({ report: natReport({ listeners: [{ address: '0.0.0.0', port: 4000 }, { address: '127.0.0.1', port: 4000 }] }) });
  assert.equal((await service.expose({ port: 4000 }, op)).ok, true);
});

test('TTL closes the entry and records the actor', async () => {
  const { service, ledger, state } = setup({ executor: fakeExecutor() });
  const r = await service.expose({ port: 4000, ttlMs: 120_000 }, op);
  assert.equal(r.entry.state, 'active');
  state.t += 60_000;
  assert.deepEqual((await service.sweepExpired()).closed, []);
  state.t += 61_000;
  assert.deepEqual((await service.sweepExpired()).closed, [4000]);
  assert.equal(ledger.open().length, 0);
  assert.equal(ledger.history()[0].closedBy, 'system:ttl');
});

test('requested TTL is clamped to the policy maximum', async () => {
  const { service, state } = setup({ policy: { maxTtlMs: 600_000 } });
  const r = await service.expose({ port: 4000, ttlMs: 99_999_999 }, op);
  assert.equal(Date.parse(r.entry.expiresAt) - state.t, 600_000);
});

test('app stop closes only that app\'s exposures', async () => {
  const exec = fakeExecutor();
  const { service, ledger } = setup({ executor: exec });
  await service.expose({ port: 4000, owner: 'app:web' }, op);
  await service.expose({ port: 4001, owner: 'app:api' }, op);
  await service.expose({ port: 4002 }, op);
  assert.deepEqual((await service.closeForApp('web')).closed, [4000]);
  assert.deepEqual(ledger.open().map((e) => e.port).sort(), [4001, 4002]);
  assert.equal(ledger.history()[0].closedBy, 'system:app-stop:web');
  assert.ok(!exec.rules.portproxy.some((r) => r.listenPort === 4000));
});

test('reconcile after a WSL IP change rewrites only ledger rules', async () => {
  const exec = fakeExecutor();
  const { service, state, ledger } = setup({ executor: exec });
  await service.expose({ port: 4000 }, op);
  // A foreign rule that happens to exist on another port.
  const foreign = { listenAddress: '0.0.0.0', listenPort: 5000, connectAddress: '172.20.0.2', connectPort: 5000 };
  exec.rules.portproxy.push(foreign);
  state.report = natReport({ wslAddresses: ['172.20.0.9'], portproxy: [...exec.rules.portproxy] });
  exec.calls.length = 0;
  const r = await service.reconcile();
  assert.deepEqual(r.changed, [4000]);
  assert.equal(ledger.get(4000).targetIp, '172.20.0.9');
  assert.ok(exec.calls.length > 0);
  assert.ok(exec.calls.every((c) => c.port === 4000), 'only the ledger port is touched');
  assert.equal(exec.rules.portproxy.find((x) => x.listenPort === 4000).connectAddress, '172.20.0.9');
  assert.equal(exec.rules.portproxy.find((x) => x.listenPort === 5000).connectAddress, '172.20.0.2');
  assert.deepEqual(r.foreign.map((f) => f.port), [5000]);
});

test('reconcile flags drift when a rule is missing and no helper can recreate it', async () => {
  const { service, ledger, state } = setup({ report: natReport({ portproxy: [] }) });
  await service.expose({ port: 4000 }, op);
  state.report = natReport({ portproxy: [] });
  // Without a helper the entry is pending_manual and keeps waiting.
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'pending_manual');
  // Once diagnostics confirm the rule it becomes active; if the rule later vanishes it drifts.
  state.report = natReport({ portproxy: [{ listenAddress: '0.0.0.0', listenPort: 4000, connectAddress: '172.20.0.2', connectPort: 4000 }] });
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'active');
  state.report = natReport({ portproxy: [] });
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'drift');
});

test('missing rule with a helper is recreated', async () => {
  const exec = fakeExecutor();
  const { service, ledger, state } = setup({ executor: exec });
  await service.expose({ port: 4000 }, op);
  exec.rules.portproxy = [];
  state.report = natReport({ portproxy: [] });
  await service.reconcile();
  assert.equal(exec.rules.portproxy.length, 1);
  assert.equal(ledger.get(4000).state, 'active');
});

test('close of a rule outside the ledger is refused and executes nothing', async () => {
  const exec = fakeExecutor();
  exec.rules.portproxy.push({ listenAddress: '0.0.0.0', listenPort: 5000, connectAddress: '172.20.0.2', connectPort: 5000 });
  const { service } = setup({ executor: exec, report: natReport({ portproxy: exec.rules.portproxy }) });
  const r = await service.close(5000, op);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not-in-ledger');
  assert.equal(exec.calls.length, 0);
  assert.equal(exec.rules.portproxy.length, 1);
});

test('foreign rule on a denylisted port yields a warning and command, and is never removed', async () => {
  const exec = fakeExecutor();
  const report = natReport({ portproxy: [{ listenAddress: '0.0.0.0', listenPort: 9222, connectAddress: '172.20.0.2', connectPort: 9222 }] });
  const { service } = setup({ executor: exec, report });
  const r = await service.reconcile();
  assert.equal(r.foreign[0].warning, 'foreign-denylisted-port');
  assert.match(r.foreign[0].command, /portproxy delete v4tov4 listenport=9222/);
  assert.equal(exec.calls.length, 0);
});

test('agent can close only its own exposure; operator can close any', async () => {
  const { service, ledger } = setup({ executor: fakeExecutor(), policy: { agentMode: 'allow_in_range' } });
  const a = await service.expose({ port: 4000 }, { kind: 'agent', chatId: 'c1' });
  assert.equal(a.entry.owner, 'chat:c1');
  assert.equal(a.entry.createdBy, 'chat:c1');
  await service.expose({ port: 4001 }, { kind: 'agent', chatId: 'c2' });
  await service.expose({ port: 4002, owner: 'app:x' }, op);
  const denied = await service.close(4001, { kind: 'agent', chatId: 'c1' });
  assert.equal(denied.error, 'close-forbidden');
  assert.equal((await service.close(4002, { kind: 'agent', chatId: 'c1' })).error, 'close-forbidden');
  assert.equal(ledger.open().length, 3);
  assert.equal((await service.close(4000, { kind: 'agent', chatId: 'c1' })).ok, true);
  assert.equal((await service.close(4001, op)).ok, true);
  assert.deepEqual(ledger.history().map((e) => e.closedBy), ['chat:c1', 'user']);
});

test('agent mode policy: ask and never refuse, an agent cannot claim another owner', async () => {
  const ask = setup();
  assert.equal((await ask.service.expose({ port: 4000 }, { kind: 'agent', chatId: 'c1' })).error, 'agent-approval-required');
  const never = setup({ policy: { agentMode: 'never' } });
  assert.equal((await never.service.expose({ port: 4000 }, { kind: 'agent', chatId: 'c1' })).error, 'agent-exposure-disabled');
  const allow = setup({ policy: { agentMode: 'allow_in_range' } });
  const r = await allow.service.expose({ port: 4000, owner: 'user' }, { kind: 'agent', chatId: 'c1' });
  assert.equal(r.entry.owner, 'chat:c1');
  // Hard blocks apply to agents too.
  assert.equal((await allow.service.expose({ port: 9222 }, { kind: 'agent', chatId: 'c1' })).error, 'port-denylisted');
  assert.equal((await ask.service.expose({ port: 4000, owner: 'chat:other' }, op)).error, 'owner-invalid');
});

test('fake backend is driven through the interface', async () => {
  const calls = [];
  const fake = {
    kind: 'wsl-nat',
    async probe() { return { kind: 'wsl-nat', canExecute: true, notes: [] }; },
    async list() { return []; },
    async expose(port) { calls.push(['expose', port]); return { state: 'active', commands: [] }; },
    async close(port) { calls.push(['close', port]); return { state: 'closed', commands: [] }; },
    async reconcile(entries) { calls.push(['reconcile', entries.map((e) => e.port)]); return { updates: [{ port: 4000, patch: { state: 'drift' } }, { port: 7777, patch: { state: 'active' } }] }; },
  };
  const { service, ledger } = setup({ makeBackend: () => fake });
  await service.expose({ port: 4000 }, op);
  const r = await service.reconcile();
  assert.deepEqual(r.changed, [4000]); // The update for 7777 (not in the ledger) is discarded.
  assert.equal(ledger.get(7777), null);
  await service.close(4000, op);
  assert.deepEqual(calls.map((c) => c[0]), ['expose', 'reconcile', 'close']);
});

test('executor failure on close keeps the entry managed', async () => {
  const exec = fakeExecutor();
  const { service, ledger } = setup({ executor: exec });
  await service.expose({ port: 4000 }, op);
  exec.run = async () => ({ ok: false, error: 'boom' });
  const r = await service.close(4000, op);
  assert.equal(r.error, 'close-failed');
  assert.equal(ledger.get(4000).state, 'active');
});

const proxyRule = (port) => ({ listenAddress: '0.0.0.0', listenPort: port, connectAddress: '172.20.0.2', connectPort: port });

test('manual close keeps the entry open as close_pending with removal commands; reconcile confirms removal', async () => {
  const { service, ledger, state } = setup();
  await service.expose({ port: 4000 }, op);
  state.report = natReport({ availability: { portproxy: true }, portproxy: [proxyRule(4000)] });
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'active');

  const r = await service.close(4000, op);
  assert.equal(r.ok, true);
  assert.equal(r.closeState, 'pending_manual');
  assert.match(r.commands.join('\n'), /portproxy delete v4tov4 listenport=4000/);
  assert.equal(ledger.get(4000).state, 'close_pending');
  assert.equal(ledger.get(4000).closeRequestedBy, 'user');
  assert.equal(ledger.history().length, 0);

  // Idempotent: a second call refreshes the commands and keeps one open entry.
  const again = await service.close(4000, op);
  assert.equal(again.closeState, 'pending_manual');
  assert.equal(ledger.open().length, 1);

  // Rule still observed: stays pending, and is not repaired or recreated.
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'close_pending');

  // Diagnostics show the rule gone: closed with the requesting actor recorded.
  state.report = natReport({ availability: { portproxy: true }, portproxy: [] });
  const rec = await service.reconcile();
  assert.deepEqual(rec.changed, [4000]);
  assert.equal(ledger.open().length, 0);
  assert.equal(ledger.history()[0].closedBy, 'user');
  assert.equal(ledger.history()[0].closeReason, 'requested');
});

test('an unavailable portproxy probe never confirms a pending close', async () => {
  const { service, ledger, state } = setup();
  await service.expose({ port: 4000 }, op);
  await service.close(4000, op);
  state.report = natReport({ availability: { portproxy: false }, portproxy: [] });
  await service.reconcile();
  assert.equal(ledger.get(4000).state, 'close_pending');
});

test('TTL expiry and app stop without a helper also stay pending until confirmed', async () => {
  const { service, ledger, state } = setup();
  await service.expose({ port: 4000, ttlMs: 60_000 }, op);
  await service.expose({ port: 4001, owner: 'app:web' }, op);
  state.t += 61_000;
  await service.sweepExpired();
  await service.closeForApp('web');
  assert.equal(ledger.get(4000).state, 'close_pending');
  assert.equal(ledger.get(4000).closeRequestedBy, 'system:ttl');
  assert.equal(ledger.get(4001).closeRequestedBy, 'system:app-stop:web');
  state.report = natReport({ availability: { portproxy: true }, portproxy: [] });
  await service.reconcile();
  assert.deepEqual(ledger.history().map((e) => e.closedBy).sort(), ['system:app-stop:web', 'system:ttl']);
});

test('executor-backed close still closes immediately', async () => {
  const { service, ledger } = setup({ executor: fakeExecutor() });
  await service.expose({ port: 4000 }, op);
  const r = await service.close(4000, op);
  assert.equal(r.closeState, 'closed');
  assert.equal(ledger.open().length, 0);
});

test('manual backend: commands are scoped, never Public, and the state is pending_manual', async () => {
  const { service, ledger } = setup();
  const r = await service.expose({ port: 4000 }, op);
  assert.equal(r.entry.state, 'pending_manual');
  assert.equal(ledger.get(4000).state, 'pending_manual');
  const fw = r.commands.find((c) => /New-NetFirewallRule/.test(c));
  assert.match(fw, /-Protocol TCP -LocalPort 4000/);
  assert.match(fw, /-Profile Private,Domain/);
  assert.match(fw, /-RemoteAddress LocalSubnet/);
  assert.doesNotMatch(r.commands.join('\n'), /Public/);
  assert.match(r.commands[0], /connectaddress=172\.20\.0\.2/);
});

test('mirrored: per-port Hyper-V rule is scoped; the broad switch is only an alternative flagged broader', async () => {
  const { service } = setup({ report: natReport({ networkingMode: 'mirrored' }) });
  const r = await service.expose({ port: 4000 }, op);
  assert.equal(r.entry.backend, 'wsl-mirrored');
  assert.equal(r.entry.state, 'pending_manual');
  assert.match(r.commands.join('\n'), /-Profiles Private,Domain -RemoteAddresses LocalSubnet/);
  assert.doesNotMatch(r.commands.join('\n'), /DefaultInboundAction|Public/);
  assert.equal(r.alternatives[0].broader, true);
  assert.match(r.alternatives[0].command, /DefaultInboundAction Allow/);
});

test('linux backend: nothing without a firewall, a command with ufw', async () => {
  const none = setup({ report: { platform: 'linux', listeners: [] }, executor: { detectFirewall: async () => null } });
  assert.equal((await none.service.expose({ port: 4000 }, op)).entry.state, 'active');
  const ufw = setup({ report: { platform: 'linux', listeners: [] }, executor: { detectFirewall: async () => 'ufw' } });
  const r = await ufw.service.expose({ port: 4000 }, op);
  assert.equal(r.entry.state, 'pending_manual');
  assert.match(r.commands[0], /ufw allow/);
});

test('backend selection follows the report and honours the override', () => {
  assert.equal(selectBackendKind(natReport()), 'wsl-nat');
  assert.equal(selectBackendKind(natReport({ networkingMode: 'mirrored' })), 'wsl-mirrored');
  assert.equal(selectBackendKind(natReport({ networkingMode: 'virtioproxy' })), 'manual');
  assert.equal(selectBackendKind({ platform: 'linux' }), 'linux');
  assert.equal(selectBackendKind({ platform: 'macos' }), 'manual');
  assert.equal(selectBackendKind({ platform: 'linux' }, 'manual'), 'manual');
  assert.equal(createBackend('manual').kind, 'manual');
});

test('duplicate exposure of a port is rejected', async () => {
  const { service } = setup();
  await service.expose({ port: 4000 }, op);
  assert.equal((await service.expose({ port: 4000 }, op)).error, 'already-exposed');
});

test('ledger persists across instances', async () => {
  const file = nextFile();
  const a = createExposureLedger({ file });
  a.put({ port: 4000, backend: 'manual', owner: 'user', createdBy: 'user', reason: '', createdAt: 'x', state: 'active' });
  assert.equal(createExposureLedger({ file }).get(4000).owner, 'user');
});

async function withServer(service, fn) {
  assert.equal(auth.setPassword('test-password-for-exposure').ok, true);
  const token = auth.createSession();
  const headers = {
    cookie: `cr_session=${encodeURIComponent(token)}`,
    [auth.AUTH_CSRF_HEADER]: auth.getCsrfTokenForSessionToken(token),
    'content-type': 'application/json',
  };
  const app = express();
  app.use(express.json());
  registerPortExposureRoutes(app, { service });
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, headers);
  } finally { server.close(); }
}

test('REST: requires auth, enforces blocks server-side, operator can close', async () => {
  const { service } = setup({ executor: fakeExecutor() });
  await withServer(service, async (base, headers) => {
    assert.equal((await fetch(`${base}/api/port-exposures`)).status, 401);
    const blocked = await fetch(`${base}/api/port-exposures`, { method: 'POST', headers, body: JSON.stringify({ port: 9222 }) });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error, 'port-denylisted');
    const ok = await fetch(`${base}/api/port-exposures`, { method: 'POST', headers, body: JSON.stringify({ port: 4000, reason: 'demo' }) });
    assert.equal(ok.status, 200);
    const list = await (await fetch(`${base}/api/port-exposures`, { headers })).json();
    assert.equal(list.exposures[0].port, 4000);
    assert.equal(list.policy.agentMode, 'ask');
    const missing = await fetch(`${base}/api/port-exposures/5555`, { method: 'DELETE', headers });
    assert.equal(missing.status, 404);
    const del = await fetch(`${base}/api/port-exposures/4000`, { method: 'DELETE', headers });
    assert.equal(del.status, 200);
  });
});
