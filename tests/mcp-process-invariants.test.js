import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMcpResourceObserver,
  detectMcpInvariantAlarms,
  measureProcessGroup,
  summarizeChildren,
} from '../lib/self-check/mcp-process-invariants.js';
import { registerHealthRoutes } from '../lib/routes/health-routes.js';

const series = (rows) => rows.map(([children, rssKb, owners, ownerless = 0], i) => ({ at: i, children, rssKb, owners, ownerless }));
const cfg = { window: 5, maxChildren: 100, maxRssKb: 10_000_000 };

test('children growing together with live owners raise no alarm', () => {
  const s = series([[2, 1000, 1], [4, 2000, 2], [6, 3000, 3], [8, 4000, 4], [10, 5000, 5]]);
  assert.deepEqual(detectMcpInvariantAlarms(s, cfg), []);
});

test('children growing with constant owners raise a growth alarm', () => {
  const s = series([[2, 1000, 2], [3, 1000, 2], [4, 1000, 2], [5, 1000, 2], [6, 1000, 2]]);
  assert.deepEqual(detectMcpInvariantAlarms(s, cfg).map((a) => a.kind), ['growth']);
});

test('constant child count with rising RSS raises an rss-growth alarm', () => {
  const s = series([[3, 200_000, 2], [3, 250_000, 2], [3, 300_000, 2], [3, 350_000, 2], [3, 400_000, 2]]);
  assert.deepEqual(detectMcpInvariantAlarms(s, cfg).map((a) => a.kind), ['rss-growth']);
});

test('threshold and persistent ownerless entries alarm; a short series does not', () => {
  assert.deepEqual(detectMcpInvariantAlarms(series([[200, 1, 1]]), cfg).map((a) => a.kind), ['threshold']);
  const own = series([[1, 1, 1, 1], [1, 1, 1, 2], [1, 1, 1, 2], [1, 1, 1, 1], [1, 1, 1, 1]]);
  assert.deepEqual(detectMcpInvariantAlarms(own, cfg).map((a) => a.kind), ['ownerless']);
  assert.deepEqual(detectMcpInvariantAlarms(series([[1, 1, 1], [9, 9, 1]]), cfg), []);
});

test('summarizeChildren groups descendants by program with total RSS', () => {
  const ps = ['10 1 100 node', '11 10 500 node', '12 11 700 npm', '13 99 900 other', '14 10 50 node'].join('\n');
  const sum = summarizeChildren(ps, 10);
  assert.equal(sum.children, 3);
  assert.equal(sum.rssKb, 1250);
  assert.deepEqual(sum.byProgram.node, { count: 2, rssKb: 550 });
});

test('unsupported platform and failing ps measure as unknown without alarm or throw', () => {
  assert.deepEqual(measureProcessGroup({ platform: 'win32' }), { state: 'unknown', reason: 'unsupported-platform' });
  const failing = measureProcessGroup({ platform: 'linux', exec: () => { throw new Error('boom'); } });
  assert.equal(failing.state, 'unknown');
  const obs = createMcpResourceObserver({ measure: () => ({ state: 'unknown', reason: 'unsupported-platform' }) });
  assert.equal(obs.sample().state, 'unknown');
  assert.equal(obs.hasAlarm(), false);
});

test('observer start is disabled by env and the timer is unref-ed', () => {
  assert.equal(createMcpResourceObserver({ env: { CRETLI_MCP_OBSERVER: '0' } }).start(), false);
  const obs = createMcpResourceObserver({ env: { CRETLI_MCP_OBSERVER_MS: '100000' } });
  assert.equal(obs.start(), true);
  obs.stop();
});

test('public /api/health exposes only a flag; details live in diagnostics', () => {
  const routes = new Map();
  registerHealthRoutes({ get: (p, h) => routes.set(p, h) }, {
    serverInstanceToken: 't', serverStartedAt: 1,
    serverDiagnostics: { snapshot: () => ({}), readRecent: () => [] },
    readMonitorAlerts: () => [],
    hasMcpResourceAlarm: () => true,
    readMcpResources: () => ({ state: 'ok', byProgram: { node: { count: 3 } }, children: 3, rssKb: 99 }),
  });
  const call = (path) => {
    const res = { body: null, status() { return this; }, json(p) { this.body = p; return this; } };
    routes.get(path)({ query: {} }, res);
    return res.body;
  };
  const health = call('/api/health');
  assert.equal(health.mcpResourceAlarm, true);
  assert.ok(!JSON.stringify(health).includes('byProgram'));
  assert.ok(!JSON.stringify(health).includes('rssKb'));
  assert.equal(call('/api/diagnostics/server').mcpResources.children, 3);
});
