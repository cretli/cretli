/**
 * Unit tests for the harness package update plan, npm commands and route.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';

import {
  buildNpmUpdateCommands,
  planHarnessPackageUpdate,
} from '../lib/harness-package-update.js';
import { registerHarnessVersionsRoutes } from '../lib/routes/harness-versions-routes.js';

const inventory = {
  harnesses: [{
    harness: 'claude',
    installPrefix: path.join('optional-packages', 'claude-agent-sdk'),
    packages: [
      { name: '@acme/agent-sdk', installed: '0.3.1', latest: '0.3.9', declaredSpec: '0.3.1', canUpdate: true },
      { name: '@acme/sdk', installed: '0.93.0', latest: '0.133.0', declaredSpec: '^0.93.0', canUpdate: true },
    ],
  }, {
    harness: 'codex',
    packages: [
      { name: '@acme/codex-sdk', installed: '1.0.0', latest: '1.2.0', declaredSpec: '^1.0.0', canUpdate: true },
      { name: '@acme/codex', installed: '1.0.0', latest: '1.2.0', canUpdate: false, requiredBy: '@acme/codex-sdk' },
      { name: '@acme/current', installed: '2.0.0', latest: '2.0.0', declaredSpec: '^2.0.0', canUpdate: true },
      { name: '@acme/unchecked', installed: '2.0.0', latest: null, declaredSpec: '^2.0.0', canUpdate: true },
    ],
  }],
};

test('plan keeps only declared packages with a newer checked version', () => {
  assert.equal(planHarnessPackageUpdate(inventory, 'nope'), null);
  const plan = planHarnessPackageUpdate(inventory, 'Codex');
  assert.equal(plan.installPrefix, '');
  assert.deepEqual(plan.targets, [
    { name: '@acme/codex-sdk', from: '1.0.0', to: '1.2.0', exact: false },
  ]);
});

test('npm commands keep the pin style and the isolated prefix', () => {
  const commands = buildNpmUpdateCommands(planHarnessPackageUpdate(inventory, 'claude'), '/srv/app');
  const prefix = path.join('/srv/app', 'optional-packages', 'claude-agent-sdk');
  assert.deepEqual(commands, [{
    cwd: '/srv/app',
    args: ['install', '--no-audit', '--no-fund', '--save-exact', '--ignore-scripts', '--prefix', prefix, '@acme/agent-sdk@0.3.9'],
  }, {
    cwd: '/srv/app',
    args: ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', prefix, '@acme/sdk@0.133.0'],
  }]);
  const root = buildNpmUpdateCommands(planHarnessPackageUpdate(inventory, 'codex'), '/srv/app');
  assert.deepEqual(root, [{ cwd: '/srv/app', args: ['install', '--no-audit', '--no-fund', '@acme/codex-sdk@1.2.0'] }]);
});

/**
 * @param {object} ctx
 * @param {(base: string) => Promise<void>} run
 */
async function withApp(ctx, run) {
  const app = express();
  app.use(express.json());
  registerHarnessVersionsRoutes(app, ctx);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    await run(`http://127.0.0.1:${server.address().port}/api/harness/packages/update`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * @param {string} url
 * @param {object} body
 */
async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('POST /api/harness/packages/update runs npm and returns a forced re-check', async () => {
  const ran = [];
  const seen = [];
  const ctx = {
    projectRoot: '/srv/app',
    isManagedInstall: () => false,
    inventory: async (options) => {
      seen.push(options);
      return inventory;
    },
    runNpm: async (command) => { ran.push(command.args.at(-1)); },
  };
  await withApp(ctx, async (url) => {
    const done = await post(url, { harness: 'codex' });
    assert.equal(done.status, 200);
    assert.equal(done.body.restartRequired, true);
    assert.deepEqual(done.body.updated, [{ name: '@acme/codex-sdk', from: '1.0.0', to: '1.2.0' }]);
    assert.deepEqual(ran, ['@acme/codex-sdk@1.2.0']);
    assert.deepEqual(seen.at(-1), { persist: true, check: true, force: true });
    assert.equal((await post(url, { harness: 'unknown' })).status, 400);
    assert.equal((await post(url, {})).status, 400);
  });
});

test('POST /api/harness/packages/update refuses managed installs, empty plans and npm failures', async () => {
  const ran = [];
  const base = {
    inventory: async () => inventory,
    runNpm: async () => { ran.push(1); },
  };
  await withApp({ ...base, isManagedInstall: () => true }, async (url) => {
    assert.equal((await post(url, { harness: 'codex' })).status, 409);
  });
  const current = { harnesses: [{ harness: 'codex', packages: [inventory.harnesses[1].packages[2]] }] };
  await withApp({ ...base, isManagedInstall: () => false, inventory: async () => current }, async (url) => {
    assert.equal((await post(url, { harness: 'codex' })).status, 409);
  });
  assert.equal(ran.length, 0);
  const failing = { ...base, isManagedInstall: () => false, runNpm: async () => { throw new Error('ERESOLVE'); } };
  await withApp(failing, async (url) => {
    const failed = await post(url, { harness: 'codex' });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.error, 'ERESOLVE');
    // The in-flight guard is released after a failure.
    assert.equal((await post(url, { harness: 'codex' })).status, 500);
  });
});
