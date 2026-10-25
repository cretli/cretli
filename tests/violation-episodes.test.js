/**
 * Violation-episode registry: open/ack/reopen/close, unknown handling, persistence, retention, redaction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createViolationEpisodeRegistry, VIOLATION_EPISODES_FILE } from '../lib/self-check/violation-episodes.js';

function setup(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-episodes-'));
  const clock = { t: 1000 };
  const sent = [];
  const make = () => createViolationEpisodeRegistry({
    dataDir, now: () => clock.t, publish: async (n) => { sent.push(n); }, ...extra,
  });
  return { dataDir, clock, sent, make };
}
const V = (over = {}) => ({ type: 'fast-errors', scope: 'srv1', status: 'violated', message: 'boom', ...over });

test('first violation opens once; repeats only bump the counter', async () => {
  const { make, sent } = setup();
  const reg = make();
  assert.deepEqual((await reg.report([V()])).map((e) => e.event), ['opened']);
  assert.deepEqual((await reg.report([V(), V()])).map((e) => e.event), ['suppressed', 'suppressed']);
  assert.equal(sent.length, 1);
  assert.equal(reg.get('fast-errors', 'srv1').count, 3);
});

test('ack silences; occurrence after ack reopens with exactly one new notification, even in the same ms', async () => {
  const { make, sent } = setup();
  const reg = make();
  await reg.report([V()]);
  assert.equal(reg.ack('fast-errors', 'srv1').acked, true);
  assert.equal(reg.get('fast-errors', 'srv1').state, 'acked');
  assert.equal(sent.length, 1);
  const ev = await reg.report([V()]); // same clock value as the ACK
  assert.deepEqual(ev.map((e) => e.event), ['reopened']);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].fingerprint, sent[1].fingerprint);
  assert.deepEqual((await reg.report([V()])).map((e) => e.event), ['suppressed']);
  assert.equal(sent.length, 2);
});

test('stale ack (older version) loses the race and the episode stays open', async () => {
  const { make } = setup();
  const reg = make();
  await reg.report([V()]);
  await reg.report([V()]);
  assert.deepEqual(reg.ack('fast-errors', 'srv1', 1), { acked: false, reason: 'stale_version' });
  assert.equal(reg.get('fast-errors', 'srv1').state, 'open');
  assert.equal(reg.ack('fast-errors', 'srv1', 2).acked, true);
});

test('unknown never opens or closes', async () => {
  const { make, sent } = setup();
  const reg = make();
  assert.deepEqual(await reg.report([V({ status: 'unknown' })]), []);
  assert.equal(reg.get('fast-errors', 'srv1'), null);
  await reg.report([V()]);
  assert.deepEqual(await reg.report([V({ status: 'unknown' })]), []);
  assert.equal(reg.get('fast-errors', 'srv1').state, 'open');
  assert.equal(sent.length, 1);
});

test('ok closes; a later violation is a new episode with a new fingerprint', async () => {
  const { make, sent } = setup();
  const reg = make();
  await reg.report([V()]);
  assert.deepEqual((await reg.report([V({ status: 'ok' })])).map((e) => e.event), ['closed']);
  assert.deepEqual((await reg.report([V()])).map((e) => e.event), ['opened']);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].fingerprint, sent[1].fingerprint);
});

test('restart preserves state; retention drops old closed episodes only', async () => {
  const { make, clock, dataDir } = setup({ closedRetentionMs: 5000 });
  let reg = make();
  await reg.report([V(), V({ scope: 'srv2' }), V({ scope: 'srv3' })]);
  reg.ack('fast-errors', 'srv2');
  await reg.report([V({ scope: 'srv3', status: 'ok' })]);
  reg = make();
  assert.equal(reg.get('fast-errors', 'srv1').state, 'open');
  assert.equal(reg.get('fast-errors', 'srv2').state, 'acked');
  assert.equal(reg.get('fast-errors', 'srv3').state, 'closed');
  clock.t += 6000;
  reg = make();
  assert.equal(reg.get('fast-errors', 'srv3'), null);
  assert.equal(reg.get('fast-errors', 'srv1').state, 'open');
  assert.ok(fs.existsSync(path.join(dataDir, VIOLATION_EPISODES_FILE)));
});

test('no secrets, paths or URLs in stored fields or notification', async () => {
  const { make, sent, dataDir } = setup();
  const reg = make();
  const secret = `${'sk-ant-'}api03-abcdefghijklmnopqrstuvwxyz0123456789`;
  await reg.report([
    V({ message: `failed at /home/someone/app/x.js calling https://example.com/a?token=${secret} key ${secret}` }),
    V({ scope: '/home/someone/project' }),
    V({ type: 'https://evil.example/x' }),
  ]);
  const stored = fs.readFileSync(path.join(dataDir, VIOLATION_EPISODES_FILE), 'utf8');
  const out = stored + JSON.stringify(sent);
  for (const bad of ['/home/someone', 'example.com', secret, 'evil.example']) assert.ok(!out.includes(bad), bad);
  assert.equal(reg.list().length, 1);
});
