/**
 * public/sw-quiet-hours.js must mirror lib/push-quiet-hours.js for key cases.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  isQuietHoursActive,
  normalizeQuietHours,
  resolveQuietState,
} from '../lib/push-quiet-hours.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'public', 'sw-quiet-hours.js'), 'utf8');
const context = { self: {} };
vm.createContext(context);
vm.runInContext(source, context);
const sw = context.self.cretliQuietHours;
assert.ok(sw, 'sw-quiet-hours.js must expose cretliQuietHours');

const wrapCfg = { enabled: true, start: '22:00', end: '07:00' };
const noon = { getHours: () => 12, getMinutes: () => 0 };
const late = { getHours: () => 23, getMinutes: () => 15 };

assert.equal(sw.isQuietHoursActive(noon, wrapCfg), isQuietHoursActive(noon, wrapCfg));
assert.equal(sw.isQuietHoursActive(late, wrapCfg), isQuietHoursActive(late, wrapCfg));

const equalCfg = normalizeQuietHours({ enabled: true, start: '10:00', end: '10:00' });
assert.equal(sw.isQuietHoursActive(noon, equalCfg), isQuietHoursActive(noon, equalCfg));

const dstClock = { getHours: () => 3, getMinutes: () => 30 };
const dstCfg = { enabled: true, start: '03:00', end: '04:00' };
assert.equal(sw.isQuietHoursActive(dstClock, dstCfg), isQuietHoursActive(dstClock, dstCfg));

assert.deepEqual(
  sw.resolveQuietState(late, wrapCfg).active,
  resolveQuietState(late, wrapCfg).active,
);

assert.equal(
  JSON.stringify(sw.normalizeQuietHours({ enabled: true, start: '9:00', end: '17:00' })),
  JSON.stringify(normalizeQuietHours({ enabled: true, start: '9:00', end: '17:00' })),
);

const swSource = readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
assert.match(swSource, /importScripts\('\/sw-quiet-hours\.js'\)/);
assert.match(swSource, /CACHE_NAME = 'cretli-v29'/);

console.log('sw-quiet-hours.test.js: ok');
