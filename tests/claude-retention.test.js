import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureClaudeTranscriptRetention as ensure, getClaudeTranscriptRetentionStatus as status } from '../lib/claude/claude-retention.ts';
after(removeIsolatedDataDir);
const roots = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-retention-'));
  roots.push(dataDir);
  const home = path.join(dataDir, 'claude-home');
  await fs.mkdir(home);
  const file = path.join(home, 'settings.json');
  return { dataDir, home, file, candidates: [], warn: () => {} };
}
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('both fresh homes get 365; merges preserve keys, unchanged startup preserves mtime', async () => {
  const ctx = await setup();
  await fs.writeFile(ctx.file, JSON.stringify({ theme: 'dark' }));
  const rows = await ensure(365, ctx);
  assert.deepEqual(rows.map(r => r.status), ['managed', 'managed']);
  assert.deepEqual(await read(ctx.file), { theme: 'dark', cleanupPeriodDays: 365 });
  const before = (await fs.stat(ctx.file)).mtimeMs;
  await ensure(365, ctx);
  assert.equal((await fs.stat(ctx.file)).mtimeMs, before);
  await ensure(400, ctx);
  assert.equal((await read(ctx.file)).cleanupPeriodDays, 400);
  assert.equal((await read(path.join(ctx.dataDir, 'claude-api-home/settings.json'))).cleanupPeriodDays, 400);
});

test('user values and invalid JSON survive startup and settings changes', async () => {
  for (const text of ['{"cleanupPeriodDays":15,"other":true}', '{broken', '[]']) {
    const ctx = await setup();
    await fs.writeFile(ctx.file, text);
    const expected = text.startsWith('{"') ? 'user' : 'invalid';
    assert.equal((await ensure(365, ctx))[0].status, expected);
    assert.equal((await ensure(400, ctx))[0].status, expected);
    assert.equal(await fs.readFile(ctx.file, 'utf8'), text);
  }
});

test('external paths never written; aliases to owned homes are managed; owned symlink escapes are external', async () => {
  const ctx = await setup();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-outside-'));
  roots.push(outside);
  const alias = path.join(ctx.dataDir, 'alias');
  await fs.symlink(ctx.home, alias);
  let rows = await ensure(365, { ...ctx, candidates: [outside, alias] });
  assert.equal(rows[2].status, 'external');
  assert.equal(rows[3].status, 'managed');
  await assert.rejects(fs.stat(path.join(outside, 'settings.json')), { code: 'ENOENT' });
  await fs.rm(ctx.home, { recursive: true });
  await fs.symlink(outside, ctx.home);
  rows = await ensure(400, ctx);
  assert.equal(rows[0].status, 'external');
  await assert.rejects(fs.stat(path.join(outside, 'settings.json')), { code: 'ENOENT' });
});

test('settings symlinks are never followed or overwritten', async () => {
  const ctx = await setup();
  const target = path.join(ctx.dataDir, 'outside.json');
  await fs.writeFile(target, '{}');
  await fs.symlink(target, ctx.file);
  assert.equal((await ensure(365, ctx))[0].status, 'invalid');
  assert.equal(await fs.readFile(target, 'utf8'), '{}');
});

test('rename failure records history first; retry remains managed', async () => {
  const ctx = await setup();
  await ensure(365, ctx);
  const io = { ...fs, rename: async (source, dest) => {
    if (dest === ctx.file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return fs.rename(source, dest);
  } };
  assert.equal((await ensure(400, { ...ctx, io }))[0].status, 'unwritable');
  assert.deepEqual((await read(path.join(ctx.dataDir, 'claude-retention-state.json')))[ctx.home], [365, 400]);
  assert.equal((await ensure(500, ctx))[0].status, 'managed');
  assert.equal((await read(ctx.file)).cleanupPeriodDays, 500);
});

test('concurrent edit is remerged once and user retention wins', async () => {
  for (const userValue of [false, true]) {
    const ctx = await setup();
    let calls = 0;
    const io = { ...fs, readFile: async (file, encoding) => {
      if (file === ctx.file && ++calls === 2) await fs.writeFile(file, JSON.stringify({ concurrent: true, ...(userValue ? { cleanupPeriodDays: 60 } : {}) }));
      return fs.readFile(file, encoding);
    } };
    // Seed a file so both initial and final reads pass through readFile.
    await fs.writeFile(ctx.file, '{}');
    const rows = await ensure(365, { ...ctx, io });
    assert.equal(rows[0].status, userValue ? 'user' : 'managed');
    assert.deepEqual(await read(ctx.file), { concurrent: true, cleanupPeriodDays: userValue ? 60 : 365 });
  }
});

test('repeated concurrent edits skip write and report failure; mkdir failures do not abort', async () => {
  const ctx = await setup();
  await fs.writeFile(ctx.file, '{}');
  let reads = 0;
  const io = { ...fs, readFile: async (file, encoding) => {
    if (file === ctx.file) await fs.writeFile(file, JSON.stringify({ revision: ++reads }));
    return fs.readFile(file, encoding);
  } };
  assert.equal((await ensure(365, { ...ctx, io }))[0].status, 'unwritable');
  assert.equal((await read(ctx.file)).cleanupPeriodDays, undefined);
  const denied = { ...fs, mkdir: async () => { throw Object.assign(new Error('read only'), { code: 'EROFS' }); } };
  assert.deepEqual((await ensure(365, { ...ctx, io: denied })).map(r => r.status), ['unwritable', 'unwritable']);
});

test('invalid module inputs cannot write settings', async () => {
  const ctx = await setup();
  for (const value of [null, false, '', 0, 29, 5000, 45.5]) await assert.rejects(ensure(value, ctx));
  await assert.rejects(fs.stat(ctx.file), { code: 'ENOENT' });
});

test('size is asynchronous, cached and ignores symlinks', async () => {
  const ctx = await setup();
  await fs.mkdir(path.join(ctx.home, 'projects'));
  await fs.writeFile(path.join(ctx.home, 'projects', 'session.jsonl'), '{}\n');
  await fs.symlink(ctx.dataDir, path.join(ctx.home, 'projects', 'loop'));
  await ensure(365, ctx);
  assert.equal(status(ctx)[0].projectsBytes, null);
  for (let attempt = 0; attempt < 100 && status(ctx)[0].projectsBytes === null; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(status(ctx)[0].projectsBytes, 3);
  await fs.writeFile(path.join(ctx.home, 'projects', 'session.jsonl'), 'longer');
  assert.equal(status(ctx)[0].projectsBytes, 3);
});

test('a corrupt ownership state prevents settings writes and is preserved', async () => {
  const ctx = await setup();
  const state = path.join(ctx.dataDir, 'claude-retention-state.json');
  await fs.writeFile(state, '{broken');
  const rows = await ensure(365, ctx);
  assert.deepEqual(rows.map(row => row.status), ['invalid', 'invalid']);
  assert.equal(await fs.readFile(state, 'utf8'), '{broken');
  await assert.rejects(fs.stat(ctx.file), { code: 'ENOENT' });
});
