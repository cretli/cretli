/**
 * Ownership registry + startup orphan sweep.
 *
 * The registry maps port -> owner entry. The sweep must kill only OpenCode
 * processes that belonged to a dead Cretli server, never a live server's
 * instance and never a process that is not in the registry.
 */

import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {
  createOpenCodePortOwnerEntry,
  getOpenCodePortRegistryPath,
  isCretliServerCmdline,
  isOpenCodeServeCmdline,
  normalizeOpenCodePortOwner,
  readOpenCodePortRegistry,
  reconcileOpenCodePortRegistry,
  removeOpenCodePortOwner,
  writeOpenCodePortOwner,
} from '../lib/opencode/opencode-port-registry.js';
import { chooseOpenCodeListenPort, isOpenCodePortOccupied } from '../lib/opencode/opencode-server-manager.js';

const registryPath = getOpenCodePortRegistryPath();

/**
 * @returns {void}
 */
function resetRegistryFile() {
  fs.rmSync(registryPath, { force: true });
  fs.rmSync(`${registryPath}.lock`, { recursive: true, force: true });
}

/**
 * @param {Record<string, unknown>} value
 * @returns {void}
 */
function writeRegistryFile(value) {
  fs.mkdirSync(registryPath.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Probe double. `alive` maps pid -> boolean, `starts` pid -> starttime,
 * `cmdlines` pid -> cmdline, `listeners` port -> pid, `ancestors` pid -> pids.
 * `killFails` is a Set of pids that ignore every signal.
 *
 * @returns {{
 *   probes: import('../lib/opencode/opencode-port-registry.js').OpenCodeProcessProbes,
 *   state: Record<string, unknown>,
 * }}
 */
function makeProbes() {
  const state = {
    alive: new Map(),
    starts: new Map(),
    cmdlines: new Map(),
    listeners: new Map(),
    ancestors: new Map(),
    killFails: new Set(),
    kills: [],
  };
  const probes = {
    isProcessAlive: (pid) => state.alive.get(pid) === true,
    getProcessStartTime: (pid) => state.starts.get(pid) || '',
    readProcessCmdline: (pid) => state.cmdlines.get(pid) || '',
    findListeningPid: (port) => state.listeners.get(port) || 0,
    listAncestorPids: (pid) => state.ancestors.get(pid) || [],
    killProcessTree: (pid, signal) => {
      state.kills.push(`${pid}:${signal}`);
      if (state.killFails.has(pid)) return false;
      state.alive.delete(pid);
      return true;
    },
  };
  return { probes, state };
}

/**
 * @param {ReturnType<typeof makeProbes>} fixture
 * @returns {Promise<{ result: object, removed: number[] }>}
 */
async function reconcile(fixture, registry) {
  const removed = [];
  const result = await reconcileOpenCodePortRegistry({
    registry,
    probes: fixture.probes,
    self: { pid: 999999, startedAt: 'self-start', instanceToken: 'self-token' },
    removeEntry: (port) => removed.push(port),
    killWaitMs: 0,
    sleep: async () => {},
    log: () => {},
  });
  return { result, removed };
}

/**
 * @param {{
 *   instanceKey: string,
 *   opencodePid?: number,
 *   opencodeStartedAt?: string,
 *   serverPid?: number,
 *   serverStartedAt?: string,
 *   serverInstanceToken?: string,
 * }} input
 * @returns {Record<string, unknown>}
 */
function ownerEntry(input) {
  return {
    instanceKey: input.instanceKey,
    opencodePid: input.opencodePid || 0,
    opencodeStartedAt: input.opencodeStartedAt || '',
    serverPid: input.serverPid || 0,
    serverStartedAt: input.serverStartedAt || '',
    serverInstanceToken: input.serverInstanceToken || '',
    updatedAt: '2026-10-09T00:00:00.000Z',
  };
}

// --- old / new registry format -------------------------------------------------

resetRegistryFile();
writeRegistryFile({ '4100': 'session:legacy' });
const legacyRead = readOpenCodePortRegistry();
assert.equal(legacyRead['4100'].instanceKey, 'session:legacy');
assert.equal(legacyRead['4100'].opencodePid, 0);
assert.equal(legacyRead['4100'].serverPid, 0);

const normalizedNew = normalizeOpenCodePortOwner({
  instanceKey: 'session:new',
  opencodePid: 222,
  opencodeStartedAt: '50',
  serverPid: 111,
  serverStartedAt: '100',
  serverInstanceToken: 'tok',
});
assert.deepEqual(normalizedNew, {
  instanceKey: 'session:new',
  opencodePid: 222,
  opencodeStartedAt: '50',
  serverPid: 111,
  serverStartedAt: '100',
  serverInstanceToken: 'tok',
  updatedAt: '',
});
assert.equal(normalizeOpenCodePortOwner({ instanceKey: '' }), null);
assert.equal(normalizeOpenCodePortOwner(42), null);

resetRegistryFile();
writeRegistryFile({
  '4101': ownerEntry({
    instanceKey: 'session:new',
    opencodePid: 222,
    opencodeStartedAt: '50',
    serverPid: 111,
    serverStartedAt: '100',
    serverInstanceToken: 'tok',
  }),
  'not-a-port': 'session:x',
  '4102': { nope: true },
});
const normalizedRegistry = readOpenCodePortRegistry();
assert.deepEqual(Object.keys(normalizedRegistry), ['4101']);
assert.equal(normalizedRegistry['4101'].opencodePid, 222);
// Port keys stay ports: `readInternalBrowserPorts` in server.js reads them raw.
assert.equal(typeof Object.keys(JSON.parse(fs.readFileSync(registryPath, 'utf8')))[0], 'string');

// --- dead owner, dead opencode -> entry removed --------------------------------

{
  const fixture = makeProbes();
  const { result, removed } = await reconcile(fixture, {
    '4110': ownerEntry({ instanceKey: 'dead', opencodePid: 222, opencodeStartedAt: '50', serverPid: 111, serverStartedAt: '100' }),
  });
  assert.deepEqual(removed, [4110]);
  assert.deepEqual(result.removed, [4110]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(fixture.state.kills, []);
}

// --- live foreign owner -> untouched -------------------------------------------

{
  const fixture = makeProbes();
  fixture.state.alive.set(111, true);
  fixture.state.starts.set(111, '100');
  fixture.state.alive.set(222, true);
  fixture.state.starts.set(222, '50');
  fixture.state.cmdlines.set(222, 'opencode serve --hostname=127.0.0.1 --port=4111');
  const { result, removed } = await reconcile(fixture, {
    '4111': ownerEntry({ instanceKey: 'live', opencodePid: 222, opencodeStartedAt: '50', serverPid: 111, serverStartedAt: '100' }),
  });
  assert.deepEqual(result.kept, [4111]);
  assert.deepEqual(removed, []);
  assert.deepEqual(fixture.state.kills, []);
}

// --- PID reuse: different start time -> stale entry dropped, no signal ---------

{
  const fixture = makeProbes();
  fixture.state.alive.set(222, true);
  fixture.state.starts.set(222, '999'); // recorded was 50
  fixture.state.cmdlines.set(222, 'opencode serve --hostname=127.0.0.1 --port=4112');
  const { result, removed } = await reconcile(fixture, {
    '4112': ownerEntry({ instanceKey: 'reused', opencodePid: 222, opencodeStartedAt: '50', serverPid: 111, serverStartedAt: '100' }),
  });
  assert.deepEqual(removed, [4112]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(fixture.state.kills, []);
}

// --- owner PID reused (start time mismatch) -> real orphan is killed -----------

{
  const fixture = makeProbes();
  fixture.state.alive.set(111, true);
  fixture.state.starts.set(111, '999'); // recorded was 100
  fixture.state.alive.set(222, true);
  fixture.state.starts.set(222, '50');
  fixture.state.cmdlines.set(222, 'opencode serve --hostname=127.0.0.1 --port=4113');
  const { result, removed } = await reconcile(fixture, {
    '4113': ownerEntry({ instanceKey: 'orphan', opencodePid: 222, opencodeStartedAt: '50', serverPid: 111, serverStartedAt: '100' }),
  });
  assert.deepEqual(removed, [4113]);
  assert.deepEqual(result.killed, [4113]);
  assert.deepEqual(fixture.state.kills, ['222:SIGTERM']);
}

// --- failed kill -> entry stays and no removal --------------------------------

{
  const fixture = makeProbes();
  fixture.state.alive.set(222, true);
  fixture.state.starts.set(222, '50');
  fixture.state.cmdlines.set(222, 'opencode serve --hostname=127.0.0.1 --port=4114');
  fixture.state.killFails.add(222);
  const { result, removed } = await reconcile(fixture, {
    '4114': ownerEntry({ instanceKey: 'stuck', opencodePid: 222, opencodeStartedAt: '50', serverPid: 111, serverStartedAt: '100' }),
  });
  assert.deepEqual(removed, []);
  assert.deepEqual(result.kept, [4114]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(fixture.state.kills, ['222:SIGTERM', '222:SIGKILL']);
}

// --- legacy entry: no listener -> removed --------------------------------------

{
  const fixture = makeProbes();
  const { result, removed } = await reconcile(fixture, { '4115': 'session:legacy' });
  assert.deepEqual(removed, [4115]);
  assert.deepEqual(fixture.state.kills, []);
}

// --- legacy entry: foreign listener (not opencode serve) -> kept, no signal ----

{
  const fixture = makeProbes();
  fixture.state.listeners.set(4116, 333);
  fixture.state.alive.set(333, true);
  fixture.state.cmdlines.set(333, 'nginx: worker process');
  const { result, removed } = await reconcile(fixture, { '4116': 'session:legacy' });
  assert.deepEqual(removed, []);
  assert.deepEqual(result.skipped, [4116]);
  assert.deepEqual(fixture.state.kills, []);
}

// --- legacy entry: opencode serve, dead owner -> killed + removed --------------

{
  const fixture = makeProbes();
  fixture.state.listeners.set(4117, 444);
  fixture.state.alive.set(444, true);
  fixture.state.cmdlines.set(444, 'opencode serve --hostname=127.0.0.1 --port=4117');
  fixture.state.ancestors.set(444, [1]);
  const { result, removed } = await reconcile(fixture, { '4117': 'session:legacy' });
  assert.deepEqual(removed, [4117]);
  assert.deepEqual(result.killed, [4117]);
  assert.deepEqual(fixture.state.kills, ['444:SIGTERM']);
}

// --- legacy entry: opencode serve under a live Cretli server -> kept -----------

{
  const fixture = makeProbes();
  fixture.state.listeners.set(4118, 445);
  fixture.state.alive.set(445, true);
  fixture.state.cmdlines.set(445, 'opencode serve --hostname=127.0.0.1 --port=4118');
  fixture.state.ancestors.set(445, [700, 1]);
  fixture.state.alive.set(700, true);
  fixture.state.cmdlines.set(700, '/usr/bin/node --import ./lib/register-boot-env.js /repo/server.js');
  const { result, removed } = await reconcile(fixture, { '4118': 'session:legacy' });
  assert.deepEqual(removed, []);
  assert.deepEqual(result.skipped, [4118]);
  assert.deepEqual(fixture.state.kills, []);
}

// --- legacy entry: ancestor titled `cretli` (process.title) is still live ------

{
  const fixture = makeProbes();
  fixture.state.listeners.set(4119, 447);
  fixture.state.alive.set(447, true);
  fixture.state.cmdlines.set(447, 'opencode serve --hostname=127.0.0.1 --port=4119');
  fixture.state.ancestors.set(447, [701]);
  fixture.state.alive.set(701, true);
  // process.title = 'cretli' zeroes /proc/<pid>/cmdline after the title.
  fixture.state.cmdlines.set(701, 'cretli');
  const { result, removed } = await reconcile(fixture, { '4119': 'session:legacy' });
  assert.deepEqual(removed, []);
  assert.deepEqual(result.skipped, [4119]);
  assert.deepEqual(fixture.state.kills, []);
}

// --- process without a registry entry is never touched -------------------------

{
  const fixture = makeProbes();
  fixture.state.alive.set(446, true);
  fixture.state.cmdlines.set(446, 'opencode serve --hostname=127.0.0.1 --port=4199');
  fixture.state.listeners.set(4199, 446);
  const { result } = await reconcile(fixture, {});
  assert.deepEqual(result, { kept: [], removed: [], killed: [], skipped: [] });
  assert.deepEqual(fixture.state.kills, []);
}

// --- port syntax guard ---------------------------------------------------------

assert.equal(isOpenCodeServeCmdline('opencode serve --hostname=127.0.0.1 --port=414', 414), true);
assert.equal(isOpenCodeServeCmdline('opencode serve --hostname=127.0.0.1 --port=4146', 414), false);
assert.equal(isOpenCodeServeCmdline('opencode serve --hostname=127.0.0.1 --port=4146', 4146), true);
assert.equal(isOpenCodeServeCmdline('node server.js --port=4146', 4146), false);

assert.equal(isCretliServerCmdline('node --import ./lib/register-boot-env.js /repo/server.js'), true);
assert.equal(isCretliServerCmdline('cretli'), true);
assert.equal(isCretliServerCmdline('cretli --import ./lib/register-boot-env.js server.js'), true);
assert.equal(isCretliServerCmdline('opencode serve --port=4146'), false);
assert.equal(isCretliServerCmdline('nginx: worker process'), false);

// --- busy port (foreign listener) -> next free port, nothing killed ------------

{
  const chosen = await chooseOpenCodeListenPort({
    instanceKey: 'busy-key',
    portBase: 4096,
    span: 2000,
    preferredOffset: 10,
    occupied: new Map(),
    isOccupied: (port) => port === 4106,
  });
  assert.equal(chosen.port, 4107);
  assert.deepEqual(Object.keys(chosen), ['port']);
}

// --- real TCP occupancy probe --------------------------------------------------

{
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const busyPort = typeof address === 'object' && address ? address.port : 0;
  assert.equal(await isOpenCodePortOccupied(busyPort), true);
  await new Promise((resolve) => probe.close(resolve));
  assert.equal(await isOpenCodePortOccupied(busyPort), false);
}

// --- two servers on one registry: writes merge, they do not overwrite ----------

resetRegistryFile();
writeRegistryFile({
  '4120': ownerEntry({ instanceKey: 'server-A', opencodePid: 900, opencodeStartedAt: '1', serverPid: 901, serverStartedAt: '2' }),
});
writeOpenCodePortOwner(4121, createOpenCodePortOwnerEntry({
  instanceKey: 'server-B',
  opencodePid: 910,
  opencodeStartedAt: '3',
}));
const merged = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
assert.deepEqual(Object.keys(merged).sort(), ['4120', '4121']);
assert.equal(merged['4120'].instanceKey, 'server-A');
assert.equal(merged['4121'].instanceKey, 'server-B');
assert.equal(merged['4121'].opencodePid, 910);
assert.ok(merged['4121'].serverPid > 0);

// Removing our key must not delete another server's entry.
assert.equal(removeOpenCodePortOwner(4120, 'server-B'), false);
assert.ok(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['4120']);
assert.equal(removeOpenCodePortOwner(4120, 'server-A'), true);
assert.equal(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['4120'], undefined);
assert.ok(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['4121']);

// A stale lock directory does not block a write.
fs.mkdirSync(`${registryPath}.lock`);
fs.utimesSync(`${registryPath}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
writeOpenCodePortOwner(4122, createOpenCodePortOwnerEntry({ instanceKey: 'server-C' }));
assert.ok(JSON.parse(fs.readFileSync(registryPath, 'utf8'))['4122']);
assert.equal(fs.existsSync(`${registryPath}.lock`), false);

resetRegistryFile();
removeIsolatedDataDir();
console.log('opencode-port-registry.test.js OK');
