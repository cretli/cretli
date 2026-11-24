import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { takeoverAncestors, takeoverPids } from '../app_front/features/apps/takeoverPids.js';

const conflicts = [
  { port: 5173, listener: { pid: 4242, command: 'node', ancestors: [{ pid: 4000, command: 'tsx watch' }, { pid: 3000, command: 'npm' }] } },
  { port: 5174, listener: { pid: 4243, command: 'node', ancestors: [{ pid: 4000, command: 'tsx watch' }, { pid: 3000, command: 'npm' }] } },
];

test('the confirmed PID set is every listener plus every ancestor, deduplicated', () => {
  assert.deepEqual([...takeoverPids(conflicts)].sort(), [3000, 4000, 4242, 4243]);
  assert.deepEqual(takeoverPids([{ listener: { pid: 7 } }]), [7]);
  assert.deepEqual(takeoverAncestors(conflicts).map((a) => a.pid), [3000, 4000]);
});

test('the takeover dialog submits the complete set and its strings exist in en and pl', () => {
  const src = fs.readFileSync(new URL('../app_front/features/apps/appsPanel.js', import.meta.url), 'utf8');
  assert.match(src, /\{ pids: takeoverPids\(d\.conflicts\) \}/);
  assert.match(src, /takeoverAncestors\(d\.conflicts\)/);
  assert.ok(en.apps.takeoverAncestorsHint && pl.apps.takeoverAncestorsHint);
});
