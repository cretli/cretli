import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServerStallWatchdog } from '../lib/server-health/server-stall-watchdog.js';

const root = path.resolve(import.meta.dirname, '..');

test('server adapters persist idea incidents in a stable workspace and deduplicate signatures', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-stall-'));
  try {
    const rows = [];
    const notices = [];
    let options;
    createServerStallWatchdog({
      repoRoot: root, dataDir: directory,
      addTodo: async (dir, cwd, input) => {
        assert.equal(dir, directory);
        assert.equal(cwd, root);
        rows.push(input);
      },
      listTodos: async (dir, cwd) => {
        assert.equal(dir, directory);
        assert.equal(cwd, root);
        return { items: rows };
      },
      publishNotification: (input) => { notices.push(input); },
      createWatchdog: (input) => { options = input; return {}; },
    });
    assert.equal(options.registryPath, path.join(directory, 'stall-watchdog-registry.json'));
    assert.equal(options.thresholdMs, 3000);
    assert.equal(options.profileMs, 2000);
    await options.createTodo({ title: 'Incident', body: 'stall-signature: abc', idempotencyKey: 'incident' });
    assert.equal(rows[0].status, 'idea');
    assert.equal(await options.findTodoBySignature('abc'), rows[0]);
    assert.equal(await options.findTodoBySignature('other'), undefined);
    await options.notify({ signature: 'abc', outcome: 'created', stalledForMs: 3250 });
    assert.equal(notices[0].fingerprint, 'stall-watchdog:abc');
    assert.equal(notices[0].category, 'system');
    assert.match(notices[0].body, /3250/);
    const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(source, /onListening: \(\) => \{\s*bootListenTotal\(\);\s*if \(!delegationShutdownStarted\) stallWatchdog.start\(\)/);
    assert.match(source, /delegationShutdownStarted = true;\s*stallWatchdog.stop\(\)/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('production watchdog thresholds capture a seven-second main-thread stall and durable todo', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-stall-real-'));
  const source = `
    import fs from 'node:fs';
    import { createServerStallWatchdog } from ${JSON.stringify(path.join(root, 'lib/server-health/server-stall-watchdog.js'))};
    const directory = ${JSON.stringify(directory)};
    const todosFile = directory + '/todos.json';
    const notifications = [];
    const wd = createServerStallWatchdog({
      repoRoot: ${JSON.stringify(root)}, dataDir: directory,
      listTodos: () => ({ items: fs.existsSync(todosFile) ? JSON.parse(fs.readFileSync(todosFile)) : [] }),
      addTodo: (_dir, _cwd, input) => fs.writeFileSync(todosFile, JSON.stringify([input])),
      publishNotification: (input) => notifications.push(input),
    });
    if (!wd.start()) process.exit(2);
    await new Promise(resolve => setTimeout(resolve, 700));
    function sevenSecondHotLoop() {
      const end = performance.now() + 7000;
      while (performance.now() < end) Math.sqrt(Math.random());
    }
    sevenSecondHotLoop();
    const end = Date.now() + 6000;
    while (!notifications.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    wd.stop();
    console.log(JSON.stringify({ state: wd.getState(), notifications }));
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.state.errors, 0, result.stderr);
    assert.equal(output.state.todosCreated, 1, result.stdout + result.stderr);
    assert.equal(output.notifications.length, 1);
    const [todo] = JSON.parse(fs.readFileSync(path.join(directory, 'todos.json')));
    assert.equal(todo.status, 'idea');
    assert.match(todo.body, /sevenSecondHotLoop|\[eval1\]/);
    assert.match(todo.body, /CPU profile window: 2000 ms/);
    assert.match(todo.body, /stall-signature:/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(directory, 'stall-watchdog-registry.json')))).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
