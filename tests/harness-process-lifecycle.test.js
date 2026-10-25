/**
 * Provider `processLifecycle` hook: the opencode plugin exposes it, the
 * memory monitor collects process state through it, and the core runner starts
 * and stops a fake provider in order with failures isolated per provider.
 */
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  getBuiltinHarnessProvider,
  listProcessLifecycleProviders,
} from '../lib/agent-harness/builtin-harness-providers.ts';
import { listBuiltinProcessLifecycles } from '../lib/agent-harness/builtin-process-lifecycles.ts';
import {
  beginProcessLifecycleStop,
  finishProcessLifecycleStop,
  startProcessLifecycles,
} from '../lib/agent-harness/process-lifecycle-runner.ts';
import {
  evaluateMemoryMonitor,
  formatMemoryMonitorReport,
  parsePsOutput,
  resolveMemoryMonitorConfig,
} from '../lib/memory-monitor.js';

// OpenCode is a repo plugin (harnesses/opencode), loaded by the helper above.
const OPENCODE_HARNESS_PROVIDER = /** @type {any} */ (getBuiltinHarnessProvider('opencode'));

function fakeProvider(id, calls, overrides = {}) {
  return {
    processLifecycle: {
      id,
      label: id.toUpperCase(),
      start: async () => { calls.push(`${id}:start`); return { summary: `${id} ready` }; },
      beginStop: () => { calls.push(`${id}:begin`); return { signaled: 1 }; },
      finishStop: async () => { calls.push(`${id}:finish`); return { ok: true, remaining: [] }; },
      ...overrides,
    },
  };
}

test('the opencode plugin exposes processLifecycle and core lists it', () => {
  const hook = OPENCODE_HARNESS_PROVIDER.processLifecycle;
  assert.ok(hook);
  assert.equal(hook.id, 'opencode');
  for (const member of ['start', 'beginStop', 'finishStop', 'getStats', 'listInternalPorts']) {
    assert.equal(typeof hook[member], 'function', member);
  }
  assert.ok(hook.monitor);
  assert.deepEqual(listProcessLifecycleProviders().map((p) => p.id), ['deepseek', 'opencode']);
  assert.equal(OPENCODE_HARNESS_PROVIDER.origin, 'builtin-optional');
  assert.equal(listBuiltinProcessLifecycles()[0], hook, 'light registry shares the plugin hook');
});

test('the memory monitor reads process state through the hook', () => {
  const config = resolveMemoryMonitorConfig({ CRETLI_MEMORY_MONITOR_MAX_OPENCODE: '1' });
  assert.equal(config.maxOpenCodeProcesses, 1);
  const processes = parsePsOutput([
    '  500  1  1000 opencode serve --port=4101',
    '  501  1  1000 opencode serve --port=4102',
  ].join('\n'));
  const evaluation = evaluateMemoryMonitor({ now: 1, config, host: {}, processes, registry: {} });
  assert.equal(evaluation.opencodeTotal, 2);
  assert.equal(evaluation.foreign.length, 2);
  assert.ok(evaluation.triggered.includes('opencode-count-high'));
  assert.ok(evaluation.episodeAlerts.some((alert) => alert.type === 'opencode-count-high'));
  const report = formatMemoryMonitorReport({ at: 'now', config, evaluation, alerts: [], warnings: [], terminations: [] });
  assert.match(report, /opencode serve total: 2/);
  const entries = OPENCODE_HARNESS_PROVIDER.processLifecycle.monitor.listExecutors({
    4101: { instanceKey: 'k', opencodePid: 500, opencodeStartedAt: '1', serverPid: 1, serverStartedAt: '1', port: 4101 },
  });
  assert.equal(entries.length, 1);
});

test('core starts providers in order and stops them phase by phase', async () => {
  const calls = [];
  const providers = [fakeProvider('a', calls), fakeProvider('b', calls)];
  const logs = [];
  await startProcessLifecycles(providers, { log: (line) => logs.push(line) });
  const phaseOne = beginProcessLifecycleStop(providers, { signal: 'SIGTERM' });
  const events = [];
  await finishProcessLifecycleStop(providers, phaseOne, {
    signal: 'SIGTERM',
    record: (event, detail) => events.push([event, detail]),
  });
  assert.deepEqual(calls, ['a:start', 'b:start', 'a:begin', 'b:begin', 'a:finish', 'b:finish']);
  assert.deepEqual(logs, ['[cretli] A startup sweep: a ready', '[cretli] B startup sweep: b ready']);
  assert.deepEqual(events.map(([event]) => event), ['shutdown-a', 'shutdown-b']);
  assert.deepEqual(events[0][1], { signal: 'SIGTERM', signaled: 1, ok: true, remaining: [] });
});

test('a failing provider hook does not stop the others', async () => {
  const calls = [];
  const errors = [];
  const providers = [
    fakeProvider('bad', calls, {
      start: async () => { throw new Error('boom'); },
      beginStop: () => { throw new Error('begin'); },
      finishStop: async () => ({ ok: false, remaining: [1, 2] }),
    }),
    fakeProvider('good', calls),
  ];
  const warns = [];
  await startProcessLifecycles(providers, { log() {}, warn: (...args) => warns.push(args.join(' ')) });
  const phaseOne = beginProcessLifecycleStop(providers, { signal: 'SIGINT', error: (line) => errors.push(line) });
  await finishProcessLifecycleStop(providers, phaseOne, {
    signal: 'SIGINT', record() {}, error: (line) => errors.push(line),
  });
  assert.match(warns[0], /BAD startup sweep failed/);
  assert.deepEqual(calls, ['good:start', 'good:begin', 'good:finish']);
  assert.ok(errors.some((line) => /phase-1 signal error: begin/.test(line)));
  assert.ok(errors.some((line) => /shutdown incomplete; 2 process\(es\)/.test(line)));
});

test('server.js and the monitor name no harness; composition roots stay light', () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('lib/memory-monitor.js'), /opencode/i);
  // Neither imports a harness module: the lifecycle arrives through the registry / provider list.
  for (const file of ['server.js', 'lib/memory-monitor.js']) {
    assert.doesNotMatch(read(file), /from\s+['"][^'"]*(opencode|harnesses\/)/, `${file} must not import opencode`);
    assert.doesNotMatch(read(file), /import\(\s*['"][^'"]*(opencode|harnesses\/)/, `${file} must not import opencode`);
  }
  assert.match(read('server.js'), /CRETLI_OPENCODE_INSTANCE_FOLDER/);
  for (const file of ['lib/agent-harness/builtin-harness-backends.ts', 'lib/mcp/adapters/index.js']) {
    assert.doesNotMatch(read(file), /from\s+['"][^'"]*builtin-harness-providers/, file);
  }
});
