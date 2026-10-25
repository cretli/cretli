import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { percentile } from '../lib/metrics/percentile.js';
import { createRouteTimings } from '../lib/metrics/route-timings.js';
import { classifyChildProcess, countChildProcesses } from '../lib/server-health/child-processes.js';
import { evaluateLoadAlarms, resolveLoadThresholds } from '../lib/server-health/thresholds.js';
import { createLoadSnapshotProvider } from '../lib/server-health/load-snapshot.js';

assert.equal(percentile([], 95), 0);
assert.equal(percentile([5], 99), 5);
assert.equal(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95), 95);

const timings = createRouteTimings({ samplesPerRoute: 3 });
for (const ms of [1, 2, 3, 100]) timings.record('GET /api/a', ms);
timings.record('GET /api/b', 5);
timings.record('GET /api/c', -1);
const rows = timings.summarize();
assert.equal(rows[0].route, 'GET /api/a');
assert.equal(rows[0].count, 4);
assert.equal(rows[0].p95, 100);
assert.equal(rows.length, 2);

assert.equal(classifyChildProcess('node --test tests/x.js'), 'tests');
assert.equal(classifyChildProcess('/usr/bin/claude --print'), 'claude');
assert.equal(classifyChildProcess('opencode serve'), 'opencode');
assert.equal(classifyChildProcess('npx some-mcp-server stdio'), 'mcp');
assert.equal(classifyChildProcess('sleep 1'), 'other');

const ps = ['10 1 node server', '11 10 claude --x', '12 11 node mcp-server stdio', '13 10 opencode serve', '14 10 node --test a', '15 99 claude unrelated', '16 14 sleep 1'].join('\n');
assert.deepEqual(countChildProcesses(ps, 10), { claude: 1, opencode: 1, mcp: 1, tests: 1, other: 1, total: 5 });

const th = resolveLoadThresholds({ CRETLI_HEALTH_MIN_FREE_DISK_MB: '100', CRETLI_HEALTH_ROUTE_P95_MS: 'bad' }, { childProcesses: 3 });
assert.equal(th.minFreeDiskMb, 100);
assert.equal(th.routeP95Ms, 2000);
assert.equal(th.childProcesses, 3);
assert.deepEqual(
  evaluateLoadAlarms({ eventLoopLagMs: { p99: 500 }, routeP95Ms: 1, children: { total: 4 }, disk: { freeMb: 10 }, loadAvg: [1], cpus: 1 }, th),
  ['eventLoopP99', 'childProcesses', 'lowDisk'],
);
assert.deepEqual(evaluateLoadAlarms({ disk: { freeMb: null } }, th), []);

const provider = createLoadSnapshotProvider({
  getEventLoopLag: () => ({ p50: 1, p99: 2, max: 3 }),
  routeTimings: timings,
  env: {},
  readProcesses: async () => ps.replace(/^10 1/, `${process.pid} 1`).replace(/ 10 /g, ` ${process.pid} `),
  readDisk: async () => ({ path: '/x', freeMb: 4096 }),
});
await provider.refresh();
const snap = provider.get();
assert.equal(snap.routeP95Ms, 100);
assert.equal(snap.disk.freeMb, 4096);
assert.ok(snap.children.total >= 3);
assert.ok(Array.isArray(snap.loadAvg) && snap.loadAvg.length === 3);

// Long-poll routes (MCP bridge calls wait up to minutes) stay listed but do not
// drive the interactive route p95 alarm.
timings.record('POST /api/mcp/bridge/call', 25000);
const withLongPoll = provider.get();
assert.equal(withLongPoll.routes[0].route, 'POST /api/mcp/bridge/call');
assert.equal(withLongPoll.routeP95Ms, 100);
assert.ok(!withLongPoll.alarms.includes('routeP95'));
console.log('server-load-metrics ok');
