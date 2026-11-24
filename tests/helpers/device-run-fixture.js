import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeviceRunsService } from '../../lib/devices/runs.js';
import { createRunConsentRegistry } from '../../lib/devices/run-consent.js';
import { createRunHistory } from '../../lib/devices/run-history.js';
import { fakeDeviceCdp } from './fake-device-cdp.js';

export async function setup(t, options = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'device-run-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'measure.mjs'), 'console.log(JSON.stringify({metrics:{time:12}}))');
  const fake = await fakeDeviceCdp(); t.after(() => fake.close());
  if (options.fakeDeviceHost) {
    fake.device.host = options.fakeDeviceHost;
    options.proxyOptions = { resolveEndpoint: async () => 'ws://127.0.0.1:' + fake.port + '/browser' };
  }
  const devices = { list: () => ({ devices: [fake.device] }), status: async (_id, opts) => { assert.equal(opts.passive, true); return { ok: true, status: options.status || 'reachable' }; } };
  const history = createRunHistory({ file: path.join(workspace, 'runs.json') });
  const consent = createRunConsentRegistry(options.consentOptions);
  const service = createDeviceRunsService({ devices, history, consent, ...options });
  return { workspace, fake, history, consent, service };
}
export function approve(consent, chatId = '') { const [card] = consent.list(chatId); assert.ok(card); assert.equal(consent.resolve(card.id, 'once', { chatId }).ok, true); return card; }

