import assert from 'node:assert/strict';
import net from 'node:net';
import { createLanReachability, probeTcp } from '../lib/server-health/lan-reachability.js';
import { createLoadSnapshotProvider } from '../lib/server-health/load-snapshot.js';

// Real TCP probe: open listener -> true, closed port -> false.
const listener = net.createServer().listen(0, '127.0.0.1');
await new Promise((resolve) => listener.once('listening', resolve));
const { port } = listener.address();
assert.equal(await probeTcp('127.0.0.1', port), true);
await new Promise((resolve) => listener.close(resolve));
assert.equal(await probeTcp('127.0.0.1', port), false);

// Cached reachability reports only after a sample and lists dead addresses.
let clock = 1_000_000;
const alive = { '192.0.2.10': false, '192.0.2.11': true };
const lan = createLanReachability({
  hosts: ['192.0.2.10', '192.0.2.11'],
  port: 3011,
  probe: async (host) => alive[host],
  now: () => clock,
  cacheMs: 1000,
});
assert.deepEqual(lan.get().unreachable, []);
await lan.refresh();
assert.deepEqual(lan.get().unreachable, ['192.0.2.10']);
alive['192.0.2.10'] = true;
clock += 5000;
lan.get();
await lan.refresh();
assert.deepEqual(lan.get().unreachable, []);

// Snapshot adds lanUnreachable only for a configured, dead address.
const base = {
  getEventLoopLag: () => ({ p50: 1, p99: 2, max: 3 }),
  env: {},
  readProcesses: async () => '',
  readDisk: async () => ({ path: '/x', freeMb: 999999 }),
};
const dead = createLanReachability({ hosts: ['192.0.2.10'], port: 3011, probe: async () => false });
await dead.refresh();
const down = createLoadSnapshotProvider({ ...base, lanReachability: dead }).get();
assert.ok(down.alarms.includes('lanUnreachable'));
assert.deepEqual(down.lan.unreachable, ['192.0.2.10']);

const none = createLoadSnapshotProvider({ ...base, lanReachability: createLanReachability({ hosts: [], port: 3011 }) }).get();
assert.ok(!none.alarms.includes('lanUnreachable'));
assert.equal(none.lan, undefined);
console.log('lan-reachability ok');
