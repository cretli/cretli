import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SPA_PANELS, SPA_ROUTE_QUERY_KEYS, parseSpaRoute, buildSpaPath } from '../lib/spa-routes.js';
import { MAIN_PANELS } from '../app_front/app/appShell/panelRegistry.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('Devices registers in routes, offline allowlist, shell, lazy loader and router', () => {
  assert.ok(SPA_PANELS.includes('devices') && MAIN_PANELS.includes('devices'));
  assert.deepEqual(SPA_ROUTE_QUERY_KEYS.devices, []);
  assert.equal(parseSpaRoute('/devices').panel, 'devices');
  assert.equal(buildSpaPath({ panel: 'devices' }), '/devices');
  assert.match(read('public/sw-routes.js'), /'devices'/);
  assert.match(read('public/index.html'), /class="tab" data-panel="devices"/);
  assert.match(read('public/index.html'), /id="devices-panel"[\s\S]*id="devices-root"/);
  assert.match(read('app_front/app/appShell/lazyPanelModules.js'), /devices: \(\) => import\([^)]*features\/devices\/index\.js/);
  assert.match(read('app_front/app/appShell/panelLoader.js'), /initDevicesPanel/);
  assert.match(read('app_front/app/appShell/panelRouter.js'), /refreshDevicesPanel/);
  assert.match(read('app_front/app/appShell/runtime.js'), /refreshDevicesPanel/);
});
