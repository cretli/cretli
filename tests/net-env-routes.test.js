import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-net-env-'));
process.env.CURSOR_REMOTE_TEST_DATA_DIR = temp;
const auth = await import('../lib/auth.js');
const { registerNetEnvRoutes } = await import('../lib/routes/net-env-routes.js');
const { createNetEnvService } = await import('../lib/net-env/index.js');

test('GET /api/net-env requires a session and returns the documented report; refresh bypasses TTL', async () => {
  try {
    assert.equal(auth.setPassword('test-password-for-net-env').ok, true);
    const session = auth.createSession();
    let calls = 0;
    const service = createNetEnvService({ platform: 'linux', release: 'generic', executor: async () => { calls++; return ''; },
      getHost: () => '198.51.100.2', getBind: () => '127.0.0.1', getLanExposed: () => false });
    const app = express();
    registerNetEnvRoutes(app, { service });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/net-env`;
      assert.equal((await fetch(url)).status, 401);
      assert.equal(calls, 0);
      const headers = { cookie: `cr_session=${encodeURIComponent(session)}` };
      const response = await fetch(url, { headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const report = await response.json();
      assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'collectedAt', 'platform', 'partial', 'reasons', 'availability', 'networkingMode', 'wslAddresses', 'wslConfig', 'listeners', 'portproxy', 'cretli', 'issues'].sort());
      assert.equal(report.schemaVersion, 1);
      assert.ok(Number.isFinite(Date.parse(report.collectedAt)));
      assert.equal(report.platform, 'linux');
      assert.deepEqual(report.cretli, { lanHost: '198.51.100.2', bind: '127.0.0.1', lanExposed: false });
      assert.deepEqual(report.listeners, []);
      assert.equal(report.partial, false);
      await fetch(url, { headers });
      assert.equal(calls, 1);
      await fetch(`${url}?refresh=1`, { headers });
      assert.equal(calls, 2);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
