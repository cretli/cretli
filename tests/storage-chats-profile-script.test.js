import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticChats, tempDir } from './fixtures/storage-chats-helpers.js';

const SCRIPT = fileURLToPath(new URL('../scripts/profile-chat-fields.mjs', import.meta.url));

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1', ...env } });
}

describe('profile-chat-fields script', () => {
  it('profiles a synthetic copy, reports numbers and field names only, and checks counter parity', () => {
    const dir = tempDir('cretli-profile-script-');
    try {
      const chats = syntheticChats(300).map((c, i) => ({ ...c, title: `SECRET-TITLE-${i}`, workspaceFolder: c.workspaceFolder ? `/SECRET/path${c.workspaceFolder}` : undefined }));
      const file = path.join(dir, 'copy.json');
      fs.writeFileSync(file, JSON.stringify({ chats }));
      const out = path.join(dir, 'report.json');
      const res = run(['--input', file, '--out', out]);
      assert.equal(res.status, 0, res.stderr);
      const report = JSON.parse(res.stdout);
      assert.equal(report.chats, 300);
      assert.equal(report.counterParity.countersMatchGroupBy, true);
      assert.equal(report.counterParity.totalMatches && report.counterParity.archivedMatches && report.counterParity.rootsMatch, true);
      assert.ok(report.recordBytes.p95 > 0 && report.topology.maxForkDepth >= 0);
      assert.ok(report.fields.title.placement.column === 300);
      assert.ok(!/SECRET|c0000/.test(res.stdout), 'no chat content, name, path or id in the report');
      assert.equal(fs.readFileSync(out, 'utf8'), `${res.stdout.trimEnd()}\n`);
      assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('requires an explicit input and refuses the active runtime data directory', () => {
    assert.notEqual(run([]).status, 0);
    const dir = tempDir('cretli-profile-active-');
    try {
      const dataDir = path.join(dir, 'active-data');
      fs.mkdirSync(dataDir);
      const live = path.join(dataDir, 'chats.json');
      fs.writeFileSync(live, JSON.stringify({ chats: syntheticChats(3) }));
      const refused = run(['--input', live], { CRETLI_DATA_DIR: dataDir });
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /active runtime data directory/);
      assert.equal(refused.stdout, '');
      // A symlink into the data directory is the same file.
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(live, link);
      assert.notEqual(run(['--input', link], { CRETLI_DATA_DIR: dataDir }).status, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
