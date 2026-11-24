import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDeviceRunsService, prepareScript } from '../lib/devices/runs.js';
import { createRunConsentRegistry } from '../lib/devices/run-consent.js';
import { createRunHistory } from '../lib/devices/run-history.js';

import { setup, approve } from './helpers/device-run-fixture.js';

test('path confinement, regular files, extensions and inline rejection', async (t) => {
  const { workspace } = await setup(t);
  const outside = await fs.mkdtemp(workspace + '-sibling');
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'escape.mjs'), '');
  await fs.symlink(path.join(outside, 'escape.mjs'), path.join(workspace, 'link.mjs'));
  await fs.writeFile(path.join(workspace, 'bad.js'), '');
  await fs.mkdir(path.join(workspace, 'dir.mjs'));
  for (const scriptPath of ['../escape.mjs', path.join(outside, 'escape.mjs'), '../' + path.basename(outside) + '/escape.mjs', 'link.mjs', 'bad.js', 'dir.mjs']) {
    await assert.rejects(prepareScript({ scriptPath }, workspace));
  }
  await assert.rejects(prepareScript({ scriptPath: 'measure.mjs', script: 'evil' }, workspace), /invalid-script/);
  await assert.rejects(prepareScript({ scriptText: 'evil' }, workspace), /invalid-script/);
});


for (const ext of ['mjs', 'cjs']) {
  test('real Node stdin smoke: ' + ext, async (t) => {
    const { workspace, service, consent } = await setup(t);
    await fs.writeFile(path.join(workspace, 'smoke.' + ext), ext === 'mjs' ? 'import os from "node:os"; console.log(JSON.stringify({metrics:{cores:os.cpus().length}}))' : 'const os=require("node:os"); console.log(JSON.stringify({metrics:{cores:os.cpus().length}}))');
    const r = await service.start('d', { scriptPath: 'smoke.' + ext }, { workspace });
    approve(consent); await r.completion;
    assert.equal(r.run.status, 'success'); assert.ok(r.run.metrics.cores > 0);
  });
}
test('sleep and separate-profile refusals record no metrics and do not ask consent', async (t) => {
  const { workspace, service, consent, fake, history } = await setup(t, { status: 'asleep' });
  let r = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace });
  assert.equal(r.error, 'device-asleep'); assert.equal(r.run.metrics, null);
  fake.device.separateProfile = false;
  r = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace });
  assert.equal(r.error, 'profile-not-separate'); assert.equal(r.run.metrics, null);
  assert.equal(consent.list().length, 0); assert.equal(fake.requests.length, 0);
  assert.equal(history.list({ workspace }).length, 2);
});

test('deny and fake 120-second timeout fail runs; approvals persist only per registry/hash/device', async (t) => {
  let timer, delay;
  const { workspace, service, consent } = await setup(t, { consentOptions: { setTimeoutFn: (fn, ms) => { timer = fn; delay = ms; return 1; }, clearTimeoutFn: () => {} } });
  const denied = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace });
  consent.resolve(denied.run.consentId, 'deny'); await denied.completion;
  assert.equal(denied.run.error, 'consent-denied');
  const expired = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace });
  assert.equal(delay, 120000); timer(); await expired.completion; assert.equal(expired.run.error, 'consent-timeout');
  const first = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace }); approve(consent); await first.completion;
  const second = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace }); await second.completion; assert.equal(second.run.status, 'success'); assert.equal(consent.list().length, 0);
  const fresh = createRunConsentRegistry();
  const freshCard = fresh.request({ deviceId: 'd', hash: first.run.hash }); assert.equal(fresh.list().length, 1); fresh.resolve(freshCard.id, 'deny');
  await fs.appendFile(path.join(workspace, 'measure.mjs'), '\n// changed');
  const changed = await service.start('d', { scriptPath: 'measure.mjs' }, { workspace });
  assert.notEqual(changed.run.hash, first.run.hash); assert.equal(consent.list().length, 1);
  consent.resolve(changed.run.consentId, 'deny'); await changed.completion;
});

test('all devices execute sequentially and a failed device does not stop the next', async (t) => {
  let inFlight = 0, maximum = 0, closed = 0;
  const { workspace } = await setup(t);
  const service = createDeviceRunsService({
    devices: { list: () => ({ devices: [{ id: 'bad', platform: 'android' }, { id: 'good', platform: 'android' }] }), status: async () => ({ ok: true, status: 'reachable' }) },
    history: createRunHistory({ file: path.join(workspace, 'all.json') }),
    consent: { request: () => ({ outcome: Promise.resolve('once') }) },
    createProxy: async (device) => {
      inFlight++; maximum = Math.max(maximum, inFlight);
      if (device.id === 'bad') { inFlight--; throw new Error('context-unsupported'); }
      return { url: 'ws://127.0.0.1:1/token', hardware: {}, close: async () => { inFlight--; closed++; } };
    },
  });
  const result = await service.all({ scriptPath: 'measure.mjs' }, { workspace });
  assert.deepEqual(result.runs.map((r) => r.status), ['failed', 'success']);
  assert.equal(result.runs[0].error, 'context-unsupported'); assert.equal(maximum, 1); assert.equal(closed, 1);
});
