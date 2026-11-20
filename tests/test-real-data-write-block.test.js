import './helpers/isolated-data-dir.js';
// The block keys off a test-process marker; set it so the test also passes when run as plain `node`.
process.env.CRETLI_TEST = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './helpers/temp-dir.js';
import { assertDataWriteAllowed, resolveProjectPath } from '../lib/runtime-paths.js';
import { spawnSync } from 'node:child_process';
import { backupChatsBeforeWrite, isChatShrink, KEEP_PRE_SHRINK } from '../lib/persist/chats-shrink-backup.js';

test('a test-process write into the (fake) real data dir throws', () => {
  const root = makeTempDir('cretli-fake-root-');
  const target = path.join(root, 'data', 'chats.json');
  assert.throws(() => assertDataWriteAllowed(target, { projectRoot: root, env: { NODE_TEST_CONTEXT: 'child' } }), { code: 'CRETLI_TEST_REAL_DATA_WRITE' });
  assert.throws(() => assertDataWriteAllowed(target, { projectRoot: root, env: { CRETLI_TEST: '1' } }), { code: 'CRETLI_TEST_REAL_DATA_WRITE' });
  // Not a test process, or a path outside the real data dir: allowed.
  assert.doesNotThrow(() => assertDataWriteAllowed(target, { projectRoot: root, env: {} }));
  assert.doesNotThrow(() => assertDataWriteAllowed(path.join(root, 'data-other', 'x.json'), { projectRoot: root, env: { CRETLI_TEST: '1' } }));
  assert.doesNotThrow(() => assertDataWriteAllowed(path.join(root, 'tmp.json'), { projectRoot: root, env: { CRETLI_TEST: '1' } }));
});

test('resolving the real project data dir throws under a test process', () => {
  const root = resolveProjectPath();
  const run = (env) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./lib/runtime-paths.js'); m.resolveDataPath('x.json'); console.log('ok');"], {
      cwd: root,
      env: { ...process.env, NODE_TEST_CONTEXT: '', CRETLI_TEST: '', CRETLI_DATA_DIR: '', CURSOR_REMOTE_DATA_DIR: '', ...env },
      encoding: 'utf8',
    });
  const blocked = run({ CRETLI_TEST: '1' });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /CRETLI_TEST_REAL_DATA_WRITE/);
  assert.equal(run({ CRETLI_TEST: '1', CRETLI_DATA_DIR: makeTempDir('cretli-guard-') }).status, 0);
  assert.equal(run({}).status, 0);
});

test('chats.json is backed up before a shrinking write, rotated to 5, plus a daily copy', () => {
  assert.equal(isChatShrink(100, 79), true);
  assert.equal(isChatShrink(100, 81), false);
  assert.equal(isChatShrink(10_000, 9_800), true); // > 100 dropped
  assert.equal(isChatShrink(10, 20), false);
  const dir = makeTempDir('cretli-shrink-');
  const file = path.join(dir, 'chats.json');
  fs.writeFileSync(file, JSON.stringify({ chats: new Array(10) }));
  const quiet = backupChatsBeforeWrite(file, 10, 9, { now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(quiet.preShrink, null);
  assert.ok(quiet.daily, 'daily copy created');
  assert.equal(backupChatsBeforeWrite(file, 10, 9, { now: new Date('2026-01-01T05:00:00Z') }).daily, null);
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    for (let i = 0; i < 7; i += 1) {
      const r = backupChatsBeforeWrite(file, 10, 2, { now: new Date(Date.UTC(2026, 0, 1, 0, 0, i + 1)) });
      assert.ok(r.preShrink);
    }
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 7);
  const kept = fs.readdirSync(dir).filter((n) => n.includes('.pre-shrink-'));
  assert.equal(kept.length, KEEP_PRE_SHRINK);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, kept[0]), 'utf8')).chats.length, 10);
});
