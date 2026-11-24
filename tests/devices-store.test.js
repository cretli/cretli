import './helpers/isolated-data-dir.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevicesStore } from '../lib/devices/store.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-devices-')), 'devices.json');
const valid = { name: 'Pixel', platform: 'android', kind: 'adb-wifi', host: '192.168.1.20', port: 40123 };

test('CRUD round trip persists across store instances', () => {
  const file = tmp();
  const store = createDevicesStore({ file });
  const created = store.create(valid);
  assert.ok(created.ok);
  assert.equal(store.list().length, 1);
  assert.ok(store.update(created.device.id, { notes: 'lab phone' }).ok);
  assert.equal(createDevicesStore({ file }).get(created.device.id).notes, 'lab phone');
  assert.equal(store.remove(created.device.id), true);
  assert.equal(createDevicesStore({ file }).list().length, 0);
  assert.equal(store.remove('nope'), false);
});

test('schema-invalid entries are rejected', () => {
  const store = createDevicesStore({ file: tmp() });
  assert.equal(store.create({ ...valid, platform: 'amiga' }).ok, false);
  assert.equal(store.create({ ...valid, name: '' }).ok, false);
  assert.equal(store.create({ ...valid, port: 70000 }).ok, false);
  assert.equal(store.create({ ...valid, host: '1.2.3.4; rm -rf /' }).ok, false);
  assert.equal(store.list().length, 0);
});

test('file is written atomically (no temp files left) and never holds a pairing code', () => {
  const file = tmp();
  const store = createDevicesStore({ file });
  store.create({ ...valid, pairingCode: '123456', pairCode: '654321' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('123456') && !text.includes('654321') && !/pairing/i.test(text));
  assert.equal(JSON.parse(text).schemaVersion, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['devices.json']);
});
