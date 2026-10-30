/**
 * Agent MCP tools for apps and ports: schemas, refusal codes, consent flow,
 * ownership and archive cleanup. Services are real; the host (ledger file, report,
 * policy, apps service) is faked.
 */
import './helpers/isolated-data-dir.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APPS_MCP_TOOLS, setAppsToolsDeps } from '../lib/mcp/builtin/apps-tools.js';
import { CRETILI_MCP_TOOL_DEFS, createCretliMcpToolHandlers } from '../lib/mcp/builtin/catalog.js';
import { MCP_APPS_TOOL_NAMES } from '../lib/mcp/mcp-tool-names.js';
import { createPortExposureService } from '../lib/port-exposure/service.js';
import { createExposeConsentRegistry } from '../lib/port-exposure/expose-consent.js';
import { createExposureLedger } from '../lib/port-exposure/ledger.js';
import { normalizePortExposurePolicy } from '../lib/port-exposure/policy.js';
import { configurePortExposureRuntime, getExposeConsentRegistry, setExposeConsentRegistry } from '../lib/port-exposure/runtime.js';
import { addChat, updateChat } from '../lib/persist/chats-persist.js';

// The registry timers are unref'd (the server has other handles); keep the loop alive for the test run.
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-apps-mcp-'));
let seq = 0;
const tool = (name) => APPS_MCP_TOOLS.find((t) => t.name === name);
const call = (name, args, chatId = 'chat-a') => tool(name).handler(args, { session: { chatId } });

/** A report where the exposure backend has nothing to do on a plain Linux host. */
const linuxReport = (listeners = []) => ({
  platform: 'linux', networkingMode: null, wslAddresses: [], listeners, portproxy: [], availability: {},
  cretli: { lanHost: '198.51.100.2', bind: '0.0.0.0', lanExposed: true }, issues: [],
});

function setup({ agentMode = 'ask', listeners = [{ address: '0.0.0.0', port: 5173, pid: 1, command: 'node' }], waitMs = 15 } = {}) {
  const report = linuxReport(listeners);
  const policy = normalizePortExposurePolicy({ agentMode });
  const ledger = createExposureLedger({ file: path.join(temp, `ledger-${seq += 1}.json`) });
  const service = createPortExposureService({
    ledger,
    getPolicy: () => policy,
    getReport: async () => report,
    executor: { async detectFirewall() { return null; } },
  });
  const consent = createExposeConsentRegistry({ waitMs });
  const apps = {
    list: () => ({ ok: true, exists: true, apps: [{ id: 'demo', name: 'Demo' }] }),
    status: async () => ({ ok: true, valid: true, errors: [], apps: [{ id: 'demo', status: 'running' }], orphans: [{ port: 1 }] }),
    start: async (id) => (id === 'demo' ? { ok: true, runId: 'r1', pid: 7, conflictCheck: 'ok' } : { ok: false, status: 404, error: 'app-not-found', message: 'nope' }),
    stop: async () => ({ ok: false, status: 409, error: 'app-not-running', message: 'not running' }),
  };
  setAppsToolsDeps({ apps: () => apps, exposure: () => service, consent: () => consent, report: async () => report, policy: () => policy });
  return { service, ledger, consent, report };
}

const errorCode = (res) => res.structuredContent?.error;

test('catalog registers the eight tools with strict schemas and correct modes', () => {
  const names = Object.values(MCP_APPS_TOOL_NAMES);
  assert.equal(names.length, 8);
  for (const name of names) {
    const def = CRETILI_MCP_TOOL_DEFS.find((d) => d.name === name);
    assert.ok(def, `${name} is in the catalog`);
    assert.equal(def.inputSchema.type, 'object');
    assert.equal(def.inputSchema.additionalProperties, false);
  }
  const mode = Object.fromEntries(APPS_MCP_TOOLS.map((t) => [t.name, t.readOnly]));
  assert.deepEqual(mode, {
    app_list: true, app_status: true, app_start: false, app_stop: false,
    port_status: true, port_expose: false, port_close: false, net_env: true,
  });
  const def = (n) => CRETILI_MCP_TOOL_DEFS.find((d) => d.name === n);
  assert.deepEqual(def('port_expose').inputSchema.required, ['port']);
  assert.deepEqual(def('app_start').inputSchema.required, ['id']);
  assert.equal(def('port_status').inputSchema.properties.port.maximum, 65535);
  assert.ok(!names.some((n) => /kill|process/.test(n)), 'no tool ends a foreign process');
});

test('mutating tools are blocked in plan mode, read tools are not', async () => {
  setup();
  const plan = createCretliMcpToolHandlers({}, { mode: 'plan', chatId: 'chat-a' });
  const blocked = await plan.port_expose({ port: 5173 });
  assert.equal(blocked.isError, true);
  assert.equal(blocked.structuredContent.code, 'PLAN_MODE_DENIED');
  assert.equal((await plan.port_status({ port: 5173 })).isError, false);
});

test('app tools pass the service answers and codes through', async () => {
  setup();
  assert.equal((await call('app_list', {})).structuredContent.apps[0].id, 'demo');
  assert.equal((await call('app_status', { id: 'demo' })).structuredContent.apps.length, 1);
  assert.equal(errorCode(await call('app_status', { id: 'ghost' })), 'app-not-found');
  assert.equal((await call('app_start', { id: 'demo' })).structuredContent.runId, 'r1');
  assert.equal(errorCode(await call('app_start', { id: 'ghost' })), 'app-not-found');
  assert.equal(errorCode(await call('app_stop', { id: 'demo' })), 'app-not-running');
  await assert.rejects(() => call('app_start', {}), /id is required/);
});

test('validation: port must be an integer in range', async () => {
  setup();
  await assert.rejects(() => call('port_expose', { port: 'x' }), /port must be an integer/);
  await assert.rejects(() => call('port_status', { port: 70000 }), /port must be an integer/);
  await assert.rejects(() => call('port_close', { port: 0 }), /port must be an integer/);
});

test('refusals: denylist, out of range and loopback-only never ask the user', async () => {
  const { consent } = setup({ listeners: [{ address: '127.0.0.1', port: 4000, pid: 1, command: 'node' }] });
  assert.equal(errorCode(await call('port_expose', { port: 9222 })), 'port-denylisted');
  assert.equal(errorCode(await call('port_expose', { port: 80 })), 'port-out-of-range');
  const loop = await call('port_expose', { port: 4000 });
  assert.equal(errorCode(loop), 'port-loopback-only');
  assert.match(loop.structuredContent.hint, /0\.0\.0\.0/);
  assert.deepEqual(consent.list('chat-a'), [], 'no card for a port that can never be exposed');
  const status = await call('port_status', { port: 4000 });
  assert.equal(status.structuredContent.blockCode, 'port-loopback-only');
  assert.equal(status.structuredContent.loopbackOnly, true);
  assert.equal(status.structuredContent.lanUrl, null);
});

test('policy never refuses with expose-denied-policy', async () => {
  setup({ agentMode: 'never' });
  const res = await call('port_expose', { port: 5173 });
  assert.equal(res.isError, true);
  assert.equal(errorCode(res), 'expose-denied-policy');
});

test('allow_in_range exposes without asking and port_status shows the LAN URL', async () => {
  const { consent, ledger } = setup({ agentMode: 'allow_in_range' });
  const res = await call('port_expose', { port: 5173, reason: 'demo' });
  assert.equal(res.isError, false, JSON.stringify(res.structuredContent));
  assert.equal(res.structuredContent.exposure.owner, 'chat:chat-a');
  assert.equal(res.structuredContent.lanUrl, 'http://198.51.100.2:5173');
  assert.deepEqual(consent.list('chat-a'), []);
  assert.equal(ledger.get(5173).owner, 'chat:chat-a');
  const status = await call('port_status', { port: 5173 });
  assert.equal(status.structuredContent.exposure.ownedByCaller, true);
  assert.equal(status.structuredContent.listening, true);
});

test('ask: pending, then once exposes and the grant is spent exactly once', async () => {
  const { consent, ledger } = setup();
  const first = await call('port_expose', { port: 5173, ttl_ms: 120000, reason: 'phone test' });
  assert.equal(errorCode(first), 'consent-pending');
  assert.equal(first.structuredContent.retry, true);
  const [card] = consent.list('chat-a');
  assert.equal(card.port, 5173);
  assert.equal(card.reason, 'phone test');
  assert.equal(consent.resolve(card.id, 'once', { chatId: 'chat-a' }).ok, true);
  const ok = await call('port_expose', { port: 5173 });
  assert.equal(ok.isError, false, JSON.stringify(ok.structuredContent));
  assert.equal(ledger.get(5173).owner, 'chat:chat-a');
  // Spent: another port needs its own card, and so would this one after closing.
  assert.equal(consent.hasOnceGrant('chat-a', 5173), false);
  await call('port_close', { port: 5173 });
  assert.equal(errorCode(await call('port_expose', { port: 5173 })), 'consent-pending');
  consent.clearChat('chat-a');
});

test('ask: a waiting call wakes on once and exposes in the same call', async () => {
  const { consent, ledger } = setup({ waitMs: 5_000 });
  const parked = call('port_expose', { port: 5173 });
  await new Promise((r) => setTimeout(r, 20));
  consent.resolve(consent.list('chat-a')[0].id, 'once');
  const res = await parked;
  assert.equal(res.isError, false, JSON.stringify(res.structuredContent));
  assert.ok(ledger.get(5173));
});

test('ask: deny gives expose-denied-user and timeout gives expose-consent-timeout', async () => {
  const { consent } = setup({ waitMs: 5_000 });
  const denied = call('port_expose', { port: 5173 });
  await new Promise((r) => setTimeout(r, 20));
  consent.resolve(consent.list('chat-a')[0].id, 'deny');
  assert.equal(errorCode(await denied), 'expose-denied-user');

  const { consent: shortLived } = setup({ waitMs: 5_000 });
  void shortLived;
  const reg = createExposeConsentRegistry({ waitMs: 5_000, timeoutMs: 40 });
  setAppsToolsDeps({ consent: () => reg });
  assert.equal(errorCode(await call('port_expose', { port: 5173 })), 'expose-consent-timeout');
});

test('port_close: only the owning chat; foreign, user and unknown exposures are refused', async () => {
  const { service, ledger } = setup({ agentMode: 'allow_in_range' });
  await call('port_expose', { port: 5173 }, 'chat-a');
  const foreign = await call('port_close', { port: 5173 }, 'chat-b');
  assert.equal(errorCode(foreign), 'close-forbidden');
  assert.ok(ledger.get(5173), 'still open');
  await service.expose({ port: 6000, owner: 'user' }, { kind: 'operator' });
  assert.equal(errorCode(await call('port_close', { port: 6000 }, 'chat-a')), 'close-forbidden');
  assert.equal(errorCode(await call('port_close', { port: 7000 }, 'chat-a')), 'not-in-ledger');
  const own = await call('port_close', { port: 5173 }, 'chat-a');
  assert.equal(own.isError, false);
  assert.equal(ledger.get(5173), null);
  await assert.rejects(() => tool('port_close').handler({ port: 5173 }, { session: {} }), /calling chat/);
});

test('archiving a chat closes its exposures and denies its cards (runtime wiring)', async () => {
  const ledger = createExposureLedger({ file: path.join(temp, `ledger-${seq += 1}.json`) });
  const policy = normalizePortExposurePolicy({ agentMode: 'allow_in_range' });
  const service = configurePortExposureRuntime({
    ledger,
    getPolicy: () => policy,
    getReport: async () => linuxReport(),
    executor: { async detectFirewall() { return null; } },
    broadcast: () => {},
  });
  const consentChanges = [];
  setExposeConsentRegistry(createExposeConsentRegistry({ waitMs: 5_000, onChange: (e) => consentChanges.push(e.chatId) }));
  try {
    const chat = addChat('sess-archive', 'Archive me', '', temp, 'm');
    const other = addChat('sess-keep', 'Keep me', '', temp, 'm');
    await service.expose({ port: 5173 }, { kind: 'agent', chatId: chat.id });
    await service.expose({ port: 5174 }, { kind: 'agent', chatId: other.id });
    const parked = getExposeConsentRegistry().request({ chatId: chat.id, port: 5175 });
    updateChat(chat.id, { archived: true });
    assert.equal(await parked, 'deny');
    assert.deepEqual(getExposeConsentRegistry().list(chat.id), []);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ledger.get(5173), null, 'archived chat exposure closed');
    assert.ok(ledger.get(5174), 'other chat untouched');
    assert.ok(consentChanges.includes(chat.id));
  } finally {
    setExposeConsentRegistry(null);
  }
});

test('net_env returns a short summary', async () => {
  setup();
  const res = await call('net_env', {});
  assert.equal(res.structuredContent.platform, 'linux');
  assert.equal(res.structuredContent.lanHost, '198.51.100.2');
  assert.equal(res.structuredContent.listenerCount, 1);
});
