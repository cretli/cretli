import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_ROOT, alive, makeWorld, cli, applyArgs, opDirOf, codes, mode, assertNoLeaks, cleanupWorlds } from './fixtures/offline-snapshot-helpers.js';

// Synthetic data roots only. Exclusions are exact top-level names; the plan must not enter them.

afterEach(cleanupWorlds);

const OWNER = 54321;
const NATIVE = ['dsh-home', 'zai-sdk-venv', 'tmp', 'claude-api-home', 'codebuddy-home', 'qwen-home', 'cursor-share',
  'scout-test-snapshots', 'codex-home', 'claude-home', 'npm-cache'];
const CANARY = 'NATIVE-HOME-CANARY-9';

function chownTree(dir, uid) {
  fs.lchownSync(dir, uid, uid);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) chownTree(p, uid);
    else fs.lchownSync(p, uid, uid);
  }
}

describe('offline snapshot source inventory', () => {
  it('excludes every native home / venv / cache / scratch dir by exact name; user-state look-alikes stay in scope', async () => {
    const w = await makeWorld();
    for (const n of NATIVE) {
      fs.mkdirSync(path.join(w.data, n));
      fs.writeFileSync(path.join(w.data, n, 'x.txt'), CANARY);
    }
    // A symlinked excluded name is never lstat'ed, walked or copied.
    fs.rmSync(path.join(w.data, 'dsh-home'), { recursive: true });
    const outside = fs.mkdtempSync(path.join(w.root, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), CANARY);
    fs.symlinkSync(outside, path.join(w.data, 'dsh-home'));
    fs.writeFileSync(path.join(w.data, 'webpack-cli-watch-lock.json'), CANARY);
    fs.writeFileSync(path.join(w.data, 'client-debug.log'), CANARY);
    fs.chmodSync(path.join(w.data, 'client-debug.log'), 0o666);
    // Look-alikes are user state: not skipped.
    for (const n of ['tmp-notes.json', 'runtime-home.json', 'dsh-home-notes.json', 'tmp.json']) fs.writeFileSync(path.join(w.data, n), '{}');
    const plan = await cli(w);
    assert.equal(plan.code, 0, plan.stdout);
    assert.ok(!codes(plan.json).includes('SYMLINK_IN_SOURCE'));
    for (const n of [...NATIVE, 'webpack-cli-watch-lock.json', 'client-debug.log']) assert.ok(plan.json.source.excludedPresent.includes(n), n);
    assert.equal(plan.json.contentsRead, false);
    const res = await cli(w, await applyArgs(w));
    assert.equal(res.json.state, 'published', res.stdout);
    const op = opDirOf(w);
    const listing = execFileSync('tar', ['-tzf', path.join(op, `${path.basename(op)}.tar.gz`)]).toString();
    const entries = listing.split('\n').map((l) => l.replace(/^\.?\/?(data\/)?/, ''));
    const has = (n) => entries.some((l) => l === n || l.startsWith(`${n}/`));
    for (const n of [...NATIVE, 'webpack-cli-watch-lock.json', 'client-debug.log']) assert.ok(!has(n), n);
    for (const n of ['tmp-notes.json', 'runtime-home.json', 'dsh-home-notes.json', 'tmp.json']) assert.ok(has(n), n);
    assertNoLeaks(w, res);
    assert.ok(!execFileSync('tar', ['-xzOf', path.join(op, `${path.basename(op)}.tar.gz`)]).toString().includes(CANARY));
  });

  it('a symlink in canonical state is refused; the report is aggregated with sanitized top-level exemplars only', async () => {
    const w = await makeWorld();
    fs.mkdirSync(path.join(w.data, 'usage'));
    for (let i = 0; i < 6; i += 1) fs.symlinkSync('/etc/hostname', path.join(w.data, i < 3 ? `link-${i}.json` : `usage/deep ${i}.json`));
    const plan = await cli(w);
    const r = plan.json.refusals.find((x) => x.code === 'SYMLINK_IN_SOURCE');
    assert.equal(r.detail.count, 6);
    assert.ok(r.detail.examples.length <= 3);
    assert.ok(r.detail.examples.every((e) => /^[A-Za-z0-9._?-]+$/.test(e)));
    assert.equal(plan.json.refusals.filter((x) => x.code === 'SYMLINK_IN_SOURCE').length, 1);
    assert.ok(alive(w.pid));
  });

  it('a world-writable canonical file is refused (no chmod performed)', async () => {
    const w = await makeWorld();
    const f = path.join(w.data, 'settings.json');
    fs.chmodSync(f, 0o666);
    const plan = await cli(w);
    assert.ok(codes(plan.json).includes('SOURCE_WRITABLE_BY_OTHERS'));
    assert.equal(mode(f), 0o666);
  });
});

describe('offline snapshot data owner', () => {
  it('declaring an owner that does not match the data root is refused', async () => {
    const w = await makeWorld();
    const plan = await cli(w, ['--data-owner-uid', String(process.getuid() + 1)]);
    assert.ok(codes(plan.json).includes('DATA_OWNER_MISMATCH'));
    assert.equal(plan.json.dataRoot.ownerRelation, 'same-uid');
  });

  it('a data root owned by another uid is accepted only when exactly that uid is declared; metadata only', async (t) => {
    if (!IS_ROOT) return t.skip('needs root to create files owned by another uid');
    const w = await makeWorld();
    chownTree(w.data, OWNER);
    const before = fs.statSync(w.data);
    const undeclared = await cli(w);
    const bad = undeclared.json.refusals.find((r) => r.code === 'DATA_ROOT_INVALID');
    assert.equal(bad.detail.ownerRelation, 'undeclared-other-uid');
    const mismatch = await cli(w, ['--data-owner-uid', String(OWNER + 1)]);
    assert.ok(codes(mismatch.json).includes('DATA_OWNER_MISMATCH'));
    const ok = await cli(w, ['--data-owner-uid', String(OWNER)]);
    assert.equal(ok.code, 0, ok.stdout);
    assert.equal(ok.json.dataRoot.ownerRelation, 'declared-other-uid');
    assert.equal(ok.json.dataRoot.uid, OWNER);
    assert.equal(ok.json.contentsRead, false);
    // The tool never changes ownership or mode of the data root.
    const after = fs.statSync(w.data);
    assert.equal(after.uid, before.uid);
    assert.equal(after.mode, before.mode);
    // The owner binding is part of the confirmed fingerprint.
    const same = await makeWorld();
    assert.notEqual((await cli(same)).json.fingerprint, ok.json.fingerprint);
  });

  it('refuses unexpected owners, group/world writes and a changed binding; a declared owner passes a full apply', async (t) => {
    if (!IS_ROOT) return t.skip('needs root to create files owned by another uid');
    const w = await makeWorld();
    chownTree(w.data, OWNER);
    const flags = ['--data-owner-uid', String(OWNER)];
    // Foreign data root must not be group-writable.
    fs.chmodSync(w.data, 0o775);
    assert.ok(codes((await cli(w, flags)).json).includes('DATA_ROOT_PERMS'));
    fs.chmodSync(w.data, 0o755);
    // A file owned by some third uid is unexpected.
    fs.lchownSync(path.join(w.data, 'settings.json'), OWNER + 7, OWNER + 7);
    assert.ok(codes((await cli(w, flags)).json).includes('SOURCE_UNEXPECTED_OWNER'));
    fs.lchownSync(path.join(w.data, 'settings.json'), OWNER, OWNER);
    // Group-writable canonical file under a foreign owner.
    fs.chmodSync(path.join(w.data, 'settings.json'), 0o664);
    assert.ok(codes((await cli(w, flags)).json).includes('SOURCE_WRITABLE_BY_OTHERS'));
    fs.chmodSync(path.join(w.data, 'settings.json'), 0o644);
    // Confirm, then the owner changes before apply: the stored fingerprint no longer matches.
    const args = await applyArgs(w, flags, flags);
    fs.chownSync(w.data, OWNER + 1, OWNER + 1);
    const changed = await cli(w, args);
    assert.ok(codes(changed.json).includes('DATA_OWNER_MISMATCH'));
    assert.ok(codes(changed.json).includes('IDENTITY_FINGERPRINT_MISMATCH'));
    assert.ok(alive(w.pid));
    fs.chownSync(w.data, OWNER, OWNER);
    const res = await cli(w, await applyArgs(w, flags, flags));
    assert.equal(res.json.state, 'published', res.stdout);
    assert.equal(fs.statSync(w.data).uid, OWNER);
    assertNoLeaks(w, res);
  });
});
