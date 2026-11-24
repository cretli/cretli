import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import * as auth from '../lib/auth.js';
import { registerDevicesRoutes } from '../lib/routes/devices-routes.js';
import { createDeviceRunsService } from '../lib/devices/runs.js';
import { createRunHistory } from '../lib/devices/run-history.js';

test('REST starts at 202, authenticated consent resumes, API/chat scope cannot cross', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'device-routes-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'test.cjs'), 'console.log(JSON.stringify({metrics:{score:1},screenshots:["UE5H"]}))');
  const devices = { list: () => ({ devices: [{ id: 'd', name: 'Phone', platform: 'android' }] }), status: async () => ({ ok: true, status: 'reachable' }) };
  const runs = createDeviceRunsService({ devices, history: createRunHistory({ file: path.join(workspace, 'runs.json') }), createProxy: async () => ({ url: 'ws://127.0.0.1:1/private', hardware: { cpuCores: 8, dpr: 2 }, close: async () => {} }) });
  assert.equal(auth.setPassword('device-consent-test').ok, true);
  const token = auth.createSession(), csrf = auth.getCsrfTokenForSessionToken(token);
  const app = express(); app.use(express.json()); registerDevicesRoutes(app, { runs, service: devices });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, { method, headers: { cookie: 'cr_session=' + token, [auth.AUTH_CSRF_HEADER]: csrf, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(base + '/api/devices/run-consents')).status, 401);
  assert.equal((await fetch(base + '/api/devices/run-consents/missing', { method: 'POST' })).status, 401);
  const start = await call('POST', '/api/devices/d/runs?workspaceFolder=' + encodeURIComponent(workspace), { scriptPath: 'test.cjs' });
  assert.equal(start.status, 202); assert.equal(start.body.run.status, 'awaiting-consent');
  const pending = (await call('GET', '/api/devices/run-consents')).body.prompts;
  assert.equal(pending.length, 1);
  assert.equal((await call('POST', '/api/devices/chat-run-consents/' + pending[0].id, { decision: 'once', chatId: 'c' })).status, 403);
  assert.equal((await call('POST', '/api/devices/run-consents/' + pending[0].id, { decision: 'once' })).status, 200);
  let recorded;
  for (let n = 0; n < 100; n++) {
    recorded = runs.history.get(start.body.run.id, workspace);
    if (recorded.status === 'success' || recorded.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(recorded.status, 'success'); assert.equal(recorded.metrics.score, 1);
  const scope = '?workspaceFolder=' + encodeURIComponent(workspace);
  const listed = await call('GET', '/api/devices/runs' + scope);
  assert.equal(listed.body.runs.length, 1);
  const compared = await call('GET', '/api/devices/runs/compare' + scope + '&before=' + recorded.id + '&after=' + recorded.id);
  assert.equal(compared.body.deltas.score.delta, 0);
  const image = await fetch(base + '/api/devices/runs/' + recorded.id + '/screenshots/' + recorded.screenshots[0] + scope, { headers: { cookie: 'cr_session=' + token } });
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(await image.text(), 'PNG');
  assert.equal((await call('GET', '/api/devices/chat-run-consents')).status, 400);
  const chatCard = runs.consent.request({ chatId: 'c', deviceId: 'd', hash: 'new', scriptPath: 'test.cjs' });
  assert.equal((await call('POST', '/api/devices/run-consents/' + chatCard.id, { decision: 'once' })).status, 403);
  assert.equal((await call('POST', '/api/devices/chat-run-consents/' + chatCard.id, { chatId: 'other', decision: 'once' })).status, 403);
  assert.equal((await call('POST', '/api/devices/chat-run-consents/' + chatCard.id, { chatId: 'c', decision: 'deny' })).status, 200);
  assert.equal(await chatCard.outcome, 'deny');
});
