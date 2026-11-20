import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { readSystemAutostart } from '../lib/autostart/system-autostart-status.js';
import { registerAutostartRoutes } from '../lib/routes/autostart-routes.js';

const options = {
  pid: 42, root: '/repo', platform: 'linux',
  read: () => '0::/system.slice/cretli.service\n',
  command: () => 'node /repo/scripts/cretli-supervisor.mjs',
};

test('system autostart reads enabled state independently of WSL login environment', async () => {
  for (const [state, enabled] of [['enabled', true], ['enabled-runtime', true], ['disabled', false], ['static', null]]) {
    const result = await readSystemAutostart({ ...options,
      run: async () => ({ stdout: `MainPID=42\nUnitFileState=${state}\n` }) });
    assert.deepEqual(result, { enabled });
  }
});

test('a foreign checkout, PID or user unit cannot be reported as this system autostart', async () => {
  const run = async () => ({ stdout: 'MainPID=42\nUnitFileState=enabled\n' });
  assert.equal(await readSystemAutostart({ ...options, run, command: () => 'node /other/scripts/cretli-supervisor.mjs' }), null);
  assert.equal(await readSystemAutostart({ ...options, run, read: () => '0::/user.slice/cretli.service\n' }), null);
  assert.equal(await readSystemAutostart({ ...options, run: async () => ({ stdout: 'MainPID=43\nUnitFileState=enabled\n' }) }), null);
  assert.equal(await readSystemAutostart({ ...options, run: async () => { throw new Error('Unavailable'); } }), null);
});

test('the API reports system autostart before probing Windows and refuses mutation', async () => {
  let enabled = true, probes = 0, writes = 0, stale = false;
  const app = express(); app.use(express.json());
  registerAutostartRoutes(app, {
    supervisor: () => ({ active: true, stale, pid: 42 }),
    systemAutostart: async ({ pid }) => { assert.equal(pid, 42); return { enabled }; },
    adapter: { status: async () => { probes++; return { supported: false, platform: 'unsupported' }; },
      install: async () => { writes++; }, uninstall: async () => { writes++; } },
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/settings/autostart`;
  try {
    let response = await fetch(url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    let data = await response.json();
    assert.equal(data.managedExternally, true); assert.equal(data.installed, true); assert.equal(data.platform, 'systemd');
    enabled = false;
    data = await (await fetch(url)).json(); assert.equal(data.installed, false); assert.equal(data.externalEnabled, false);
    for (const enabled of [true, false]) {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, confirm: true }) });
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'system-managed');
    }
    assert.equal(probes, 0); assert.equal(writes, 0);
    stale = true;
    data = await (await fetch(url)).json();
    assert.equal(data.managedExternally, false); assert.equal(data.supported, false); assert.equal(probes, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
