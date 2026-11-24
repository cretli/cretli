import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEVICE_MCP_TOOLS, setDeviceToolsService } from '../lib/mcp/builtin/device-tools.js';
import { CRETILI_MCP_TOOL_DEFS } from '../lib/mcp/builtin/catalog.js';
import { MCP_DEVICE_TOOL_NAMES } from '../lib/mcp/mcp-tool-names.js';
import { createDevicesService } from '../lib/devices/service.js';
import { createDevicesStore } from '../lib/devices/store.js';

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-devtools-')), 'devices.json');
const service = createDevicesService({
  store: createDevicesStore({ file }),
  probe: async () => ({ status: 'reachable', detail: 'ok', hardware: { gpu: 'G' } }),
  getAdbPath: () => 'adb',
});
setDeviceToolsService(service);
const g = service.create({ name: 'Global', platform: 'macos', kind: 'chrome-cdp', host: '10.0.0.2', port: 9222 }).device;
const w = service.create({ name: 'WsA', platform: 'macos', kind: 'chrome-cdp', host: '10.0.0.3', port: 9222, workspace: '/ws/a' }).device;
const tool = (n) => DEVICE_MCP_TOOLS.find((t) => t.name === n);

test('device tools have strict schemas and correct mutation classification', () => {
  for (const name of Object.values(MCP_DEVICE_TOOL_NAMES)) {
    const def = CRETILI_MCP_TOOL_DEFS.find((d) => d.name === name);
    assert.ok(def, name);
    assert.equal(def.inputSchema.additionalProperties, false);
    assert.equal(tool(name).readOnly, name !== 'device_run');
  }
  assert.deepEqual(Object.keys(tool('device_status').inputSchema.properties), ['id']);
  assert.deepEqual(Object.keys(tool('device_list').inputSchema.properties), []);
});

test('device_list honours workspace scope', async () => {
  const a = await tool('device_list').handler({}, { workspaceFolder: '/ws/a' });
  assert.deepEqual(a.structuredContent.devices.map((d) => d.id).sort(), [g.id, w.id].sort());
  const b = await tool('device_list').handler({}, { workspaceFolder: '/ws/b' });
  assert.deepEqual(b.structuredContent.devices.map((d) => d.id), [g.id]);
});

test('device_status returns a structured result and refuses out-of-scope or unknown ids', async () => {
  const ok = await tool('device_status').handler({ id: g.id }, {});
  assert.equal(ok.structuredContent.status, 'reachable');
  assert.deepEqual(ok.structuredContent.hardware, { gpu: 'G' });
  const hidden = await tool('device_status').handler({ id: w.id }, { workspaceFolder: '/ws/b' });
  assert.equal(hidden.structuredContent.error, 'device-not-found');
  assert.equal((await tool('device_status').handler({ id: 'nope' }, {})).structuredContent.ok, false);
});

test('device_run is refused by real MCP plan/read-only policy', async () => {
  const { resolveMcpPlanToolDecision, getBuiltinMcpMutatingTools } = await import('../lib/mcp/mcp-policy.js');
  const { MCP_PLAN_MODE_OPEN_TOOLS } = await import('../lib/mcp/mcp-tool-names.js');
  assert.ok(getBuiltinMcpMutatingTools().includes('device_run'));
  assert.ok(!MCP_PLAN_MODE_OPEN_TOOLS.includes('device_run'));
  for (const mode of ['plan', 'ask']) {
    assert.equal(resolveMcpPlanToolDecision({ server: { id: (await import('../lib/mcp/mcp-config.js')).BUILTIN_CRETILI_SERVER_ID }, toolName: 'device_run', mode }).deny, true);
    assert.equal(resolveMcpPlanToolDecision({ server: { id: (await import('../lib/mcp/mcp-config.js')).BUILTIN_CRETILI_SERVER_ID }, toolName: 'device_runs', mode }).deny, false);
  }
});

test('MCP device_run creates a chat card, waits 25 seconds, and retrieves the same run after a decision', async (t) => {
  const { createDeviceRunsService } = await import('../lib/devices/runs.js');
  const { createRunHistory } = await import('../lib/devices/run-history.js');
  const { setDeviceRunsToolsService } = await import('../lib/mcp/builtin/device-tools.js');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'device-mcp-run-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); setDeviceRunsToolsService(null); });
  fs.writeFileSync(path.join(workspace, 'test.cjs'), 'console.log("{}")');
  const runs = createDeviceRunsService({
    devices: { list: () => ({ devices: [{ id: 'd', name: 'Phone', platform: 'android' }] }), status: async () => ({ ok: true, status: 'reachable' }) },
    history: createRunHistory({ file: path.join(workspace, 'runs.json') }),
  });
  setDeviceRunsToolsService(runs);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const args = { id: 'd', scriptPath: 'test.cjs' }, ctx = { workspaceFolder: workspace, session: { chatId: 'chat-measure' } };
  const pending = tool('device_run').handler(args, ctx);
  while (!runs.consent.list('chat-measure').length) await new Promise((resolve) => setImmediate(resolve));
  const [card] = runs.consent.list('chat-measure');
  assert.equal(card.chatId, 'chat-measure');
  t.mock.timers.tick(25000);
  const response = await pending;
  assert.equal(response.structuredContent.error, 'consent-pending');
  assert.equal(response.structuredContent.prompts[0].id, card.id);
  runs.consent.resolve(card.id, 'deny', { chatId: 'chat-measure' });
  await new Promise((resolve) => setImmediate(resolve));
  const retry = await tool('device_run').handler(args, ctx);
  assert.equal(retry.structuredContent.run.error, 'consent-denied');
  assert.equal(runs.history.list({ workspace }).length, 1);
});
