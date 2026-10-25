import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const { saveSettings, loadSettings } = await import('../lib/persist/settings.js');
const CONFIG = path.join(ISOLATED_DATA_DIR, 'config.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('saveSettings rotates the last 3 backups', () => {
  for (let i = 1; i <= 5; i += 1) saveSettings({ v: i });
  assert.equal(read(CONFIG).v, 5);
  assert.equal(read(`${CONFIG}.bak`).v, 4);
  assert.equal(read(`${CONFIG}.bak.1`).v, 3);
  assert.equal(read(`${CONFIG}.bak.2`).v, 2);
  assert.equal(fs.existsSync(`${CONFIG}.bak.3`), false);
});

test('empty write over a large config is refused unless allowEmpty', () => {
  saveSettings({ a: 1, b: 2, c: 3, d: 4 });
  assert.throws(() => saveSettings({}), { code: 'SETTINGS_EMPTY_WRITE_REFUSED' });
  assert.equal(Object.keys(loadSettings()).length, 4);
  saveSettings({}, { allowEmpty: true });
  assert.deepEqual(loadSettings(), {});
  assert.equal(Object.keys(read(`${CONFIG}.bak`)).length, 4);
});

test('empty write over a small config still works', () => {
  saveSettings({ a: 1 });
  saveSettings({});
  assert.deepEqual(loadSettings(), {});
});

test('saveSettings throws under node --test when config path is the real data/', () => {
  // The child must throw before any write, so the real data/ is never touched.
  const code = `
    const { saveSettings } = await import(${JSON.stringify(new URL('../lib/persist/settings.js', import.meta.url).href)});
    try { saveSettings({ x: 1 }); console.log('NOERR'); } catch (e) { console.log(e.code); }
  `;
  const env = { ...process.env, NODE_TEST_CONTEXT: 'child-v8' };
  delete env.CRETLI_DATA_DIR;
  delete env.CURSOR_REMOTE_DATA_DIR;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.match(res.stdout, /SETTINGS_REAL_DATA_DIR_IN_TEST/, res.stdout + res.stderr);
});
