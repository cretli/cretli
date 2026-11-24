import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const dir = new URL('../extensions/cretli-chrome/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));

test('MV3 manifest: optional host permissions only, no <all_urls>, no downloads', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  assert.ok(!manifest.permissions.includes('downloads'));
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'scripting', 'storage']);
});

test('referenced files exist and the popup carries the kill switch', () => {
  for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
    'content-script.js', 'popup.js', 'options.js', 'domains.js']) {
    assert.ok(existsSync(new URL(file, dir)), file);
  }
  assert.match(readFileSync(new URL('popup.html', dir), 'utf8'), /id="kill"/);
  assert.match(readFileSync(new URL('popup.js', dir), 'utf8'), /type: 'kill'/);
  assert.ok(!/chrome\.downloads/.test(readFileSync(new URL('service-worker.js', dir), 'utf8')));
});
