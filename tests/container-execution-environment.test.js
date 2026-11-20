import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContainerEnvironment, sweepOrphanContainers } from '../lib/worktree/container-execution-environment.ts';
import { hostExecutionEnvironment, resolveExecutionEnvironment } from '../lib/worktree/execution-environment.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'cretli-container-test-'));
const engine = fileURLToPath(new URL('./fixtures/fake-container-engine.mjs', import.meta.url));
const state = path.join(root, 'state.json');
const log = path.join(root, 'engine.log');
await writeFile(state, JSON.stringify({ containers: {} }));
const podmanEngine = path.join(root, 'podman');
await symlink(engine, podmanEngine);
const environment = createContainerEnvironment({ engine, image: 'example/image:latest' });
const withFakeEngine = async (fn) => {
  const oldState = process.env.FAKE_CONTAINER_STATE;
  const oldLog = process.env.FAKE_CONTAINER_LOG;
  process.env.FAKE_CONTAINER_STATE = state;
  process.env.FAKE_CONTAINER_LOG = log;
  try { return await fn(); } finally {
    if (oldState === undefined) delete process.env.FAKE_CONTAINER_STATE; else process.env.FAKE_CONTAINER_STATE = oldState;
    if (oldLog === undefined) delete process.env.FAKE_CONTAINER_LOG; else process.env.FAKE_CONTAINER_LOG = oldLog;
  }
};

await withFakeEngine(async () => {
  assert.deepEqual(await createContainerEnvironment({ engine }).probe(), { available: true, version: 'fake-engine-1.0', reason: engine });
  process.env.FAKE_CONTAINER_MODE = 'error';
  assert.deepEqual(await createContainerEnvironment({ engine }).probe(), { available: false, reason: `${engine} probe failed.` });
  process.env.FAKE_CONTAINER_MODE = 'timeout';
  assert.deepEqual(await createContainerEnvironment({ engine }).probe(), { available: false, reason: `${engine} probe timed out.` });
  delete process.env.FAKE_CONTAINER_MODE;
  assert.match((await createContainerEnvironment({ engine: path.join(root, 'missing-engine') }).probe()).reason, /not installed/);
});

await withFakeEngine(async () => {
  assert.deepEqual(await environment.probe(), { available: true, version: 'fake-engine-1.0', reason: engine });
  const handle = await environment.prepare({ id: 'test-run', worktreePath: '/host/worktree' });
  const child = environment.spawn(handle, 'node', ['-e', '0'], { cwd: '/host/worktree/src', env: { SAFE_VALUE: 'not-an-argv-value' } });
  await new Promise((resolve) => child.once('close', resolve));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const create = calls.find((args) => args[0] === 'create');
  assert.ok(create.includes('--network') && create.includes('none'));
  assert.ok(create.includes('--user') || create.includes('--userns'));
  assert.ok(create.includes('--label') && create.includes('cretli.execution-environment=true'));
  assert.ok(create.includes('type=bind,src=/host/worktree,dst=/workspace'));
  const exec = calls.find((args) => args[0] === 'exec');
  assert.ok(exec.includes('--workdir') && exec.includes('/workspace/src'));
  assert.ok(!calls.flat().includes('not-an-argv-value'));
  const envFiles = await readdir(handle.envDirectory);
  assert.equal(envFiles.length, 1);
  assert.match(await readFile(path.join(handle.envDirectory, envFiles[0]), 'utf8'), /SAFE_VALUE='not-an-argv-value'/);
  await environment.stop(handle);
});

await withFakeEngine(async () => {
  const podman = createContainerEnvironment({ engine: podmanEngine, image: 'example/image:latest' });
  const handle = await podman.prepare({ id: 'podman-run', worktreePath: '/host/worktree' });
  const callsBefore = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const create = callsBefore.reverse().find((args) => args[0] === 'create');
  assert.ok(create.includes('--userns') && create.includes('keep-id'));
  await podman.stop(handle);
});

await withFakeEngine(async () => {
  const ptyEnvironment = createContainerEnvironment({ engine, image: 'example/image:latest' });
  const handle = await ptyEnvironment.prepare({ id: 'pty-run', worktreePath: '/host/worktree' });
  const terminal = ptyEnvironment.spawnPty(handle, 'node', ['-e', '0'], { cwd: '/host/worktree', cols: 80, rows: 24, env: { TERM: 'xterm' } });
  terminal.resize(100, 40);
  await new Promise((resolve) => terminal.onExit(resolve));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const exec = calls.reverse().find((args) => args[0] === 'exec');
  assert.ok(exec.includes('-t'));
  assert.equal(calls.some((args) => args[0] === 'container' && args[1] === 'resize'), false);
  await ptyEnvironment.stop(handle);
});

assert.equal(resolveExecutionEnvironment().kind, 'host');
assert.equal(resolveExecutionEnvironment({ environment: 'inherit' }), hostExecutionEnvironment);
assert.equal(resolveExecutionEnvironment({ environment: 'container', definition: { engine } }).kind, 'container');

await withFakeEngine(async () => {
  await environment.prepare({ id: 'orphan', worktreePath: '/host/worktree' });
  const currentState = JSON.parse(await readFile(state, 'utf8'));
  currentState.containers['foreign-live'] = { labels: { 'cretli.execution.owner-pid': String(process.pid), 'cretli.execution.owner-start': readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(')')[1].trim().split(/\s+/)[19] } };
  currentState.containers['dead-owner'] = { labels: { 'cretli.execution.owner-pid': '999999', 'cretli.execution.owner-start': '1' } };
  writeFileSync(state, JSON.stringify(currentState));
  const result = await sweepOrphanContainers({ engine });
  assert.ok(result.containers.includes('dead-owner'));
  assert.ok(!result.containers.includes('foreign-live'));
  assert.ok(JSON.parse(await readFile(state, 'utf8')).containers['foreign-live']);
});

await withFakeEngine(async () => {
  process.env.FAKE_CONTAINER_MODE = 'start-error';
  await assert.rejects(environment.prepare({ id: 'failed-start', worktreePath: '/host/worktree' }));
  assert.equal(JSON.parse(await readFile(state, 'utf8')).containers['cretli-failed-start'], undefined);
  delete process.env.FAKE_CONTAINER_MODE;
});

await withFakeEngine(async () => {
  const childCode = `import { createContainerEnvironment } from ${JSON.stringify(new URL('../lib/worktree/container-execution-environment.ts', import.meta.url).href)}; await createContainerEnvironment({engine:${JSON.stringify(engine)}}).prepare({id:'exit-hook',worktreePath:'/host/worktree'}); process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { env: process.env, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  assert.equal(JSON.parse(await readFile(state, 'utf8')).containers['cretli-exit-hook'], undefined);
});

await withFakeEngine(async () => {
  const handle = await environment.prepare({ id: 'hardened', worktreePath: '/host/worktree' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const create = calls.reverse().find((args) => args[0] === 'create');
  assert.ok(create.join(' ').includes('--cap-drop ALL'));
  assert.ok(create.join(' ').includes('--security-opt no-new-privileges'));
  await environment.stop(handle);
  for (const bad of ['/host/work,tree', '/host/work\ntree', 'relative/tree', '/', os.homedir()]) {
    await assert.rejects(environment.prepare({ id: 'bad-mount', worktreePath: bad }), /Unsafe|Refusing/, `refused ${JSON.stringify(bad)}`);
  }
  await assert.rejects(createContainerEnvironment({ engine, workspacePath: '/work,space' }).prepare({ id: 'bad-guest', worktreePath: '/host/worktree' }), /Unsafe/);
});

console.log('container-execution-environment.test.js OK');
