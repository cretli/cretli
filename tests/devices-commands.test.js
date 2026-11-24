import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateConnectHelp } from '../lib/devices/commands.js';

const PRIVATE = /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)\b/;

test('macOS and Windows recipes carry the documented flags', () => {
  for (const platform of ['macos', 'windows']) {
    const h = generateConnectHelp({ platform });
    assert.match(h.connect, /--remote-debugging-port/);
    assert.match(h.connect, /--user-data-dir/);
    assert.ok(h.cleanup.length > 0);
  }
  const win = generateConnectHelp({ platform: 'windows' });
  assert.match(win.connect, /netsh interface portproxy/);
  assert.match(win.cleanup, /netsh interface portproxy delete/);
});

test('Android recipe has pair/connect/forward, cleanup and pitfall hints', () => {
  const h = generateConnectHelp({ platform: 'android', host: '192.0.2.10', port: 41000 });
  assert.match(h.connect, /adb pair/);
  assert.match(h.connect, /adb connect/);
  assert.match(h.connect, /adb -s \S+ forward/);
  assert.match(h.cleanup, /forward --remove/);
  assert.match(h.cleanup, /adb disconnect/);
  assert.ok(h.hints.length >= 4);
});

test('generated text has no private maintainer hosts or IPs and ignores injection-shaped input', () => {
  for (const platform of ['macos', 'windows', 'android']) {
    const h = generateConnectHelp({ platform });
    assert.doesNotMatch(h.connect + h.cleanup + h.hints.join(' '), PRIVATE);
  }
  const bad = generateConnectHelp({ platform: 'android', host: '1.2.3.4; rm -rf /', adbPath: '$(id)' });
  assert.ok(!bad.connect.includes('rm -rf'));
  assert.ok(!bad.connect.includes('$(id)'));
});
