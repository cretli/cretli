import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  armChatUsageLimitPause,
  armDelegationUsageLimitPause,
  buildPauseRecord,
  cancelParentDelegationUsageLimitPauses,
  cancelSubjectUsageLimitPauses,
  CHAIN_GAP_MS,
  nextChain,
  normalizePauseRecord,
} from '../lib/usage-limit-paused.js';
import { listWakeups, loadWakeups, saveWakeups } from '../lib/persist/wakeups-persist.js';
import { registerUsageLimitResumeRoutes } from '../lib/routes/usage-limit-resume-routes.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const LIMIT = { resetAt: '2026-10-19T15:00:00Z', resetSource: 'fallback-ttl', code: 'usage_limit', model: '' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ulp-'));
const deps = (dataDir, over = {}) => ({
  dataDir,
  now: () => NOW,
  settings: { usageLimitResume: { enabled: true } },
  getLimit: () => LIMIT,
  resolveContext: () => ({ context: 'legacy_ad_hoc' }),
  ...over,
});
const chatInput = (chat = { id: 'c1' }) => ({ chat, harness: 'claude', model: 'sonnet', subjectModel: 'sonnet-4' });

test('chat error arms one record; re-arming keeps one row; chat stores empty attempt and room model', () => {
  const dataDir = tmp();
  for (let i = 0; i < 3; i += 1) armChatUsageLimitPause(chatInput(), deps(dataDir));
  const rows = loadWakeups({ dataDir });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subjectAttemptId, '');
  assert.equal(rows[0].subjectModel, 'sonnet-4');
  assert.equal(rows[0].resetSource, 'fallback-ttl'); // stored verbatim
  assert.equal(rows[0].state, 'armed');
});

test('disabled feature or missing limit arms nothing', () => {
  const dataDir = tmp();
  assert.equal(armChatUsageLimitPause(chatInput(), deps(dataDir, { settings: {} })), null);
  assert.equal(armChatUsageLimitPause(chatInput(), deps(dataDir, { settings: { usageLimitResume: { enabled: false } } })), null);
  assert.equal(armChatUsageLimitPause(chatInput(), deps(dataDir, { getLimit: () => null })), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'wakeups.json')), false);
});

test('delegation child, Scout and automatic chats arm no chat pause', () => {
  const dataDir = tmp();
  armChatUsageLimitPause(chatInput({ id: 'a', delegationId: 'd1' }), deps(dataDir));
  armChatUsageLimitPause(chatInput({ id: 'b', pickPurpose: 'scout' }), deps(dataDir));
  armChatUsageLimitPause(chatInput({ id: 'c' }), deps(dataDir, { resolveContext: () => ({ context: 'automatic' }) }));
  assert.equal(loadWakeups({ dataDir }).length, 0);
});

test('delegation pause stores attempt and executor model, no message or prompt text', () => {
  const dataDir = tmp();
  const rec = armDelegationUsageLimitPause({
    id: 'd1', attemptId: 'att-1', parentChatId: 'p1', leafId: 'leaf1',
    executor: { transport: 'codex', model: 'gpt-x' },
    error: 'SECRET provider body', sourceText: 'SECRET prompt',
  }, deps(dataDir));
  assert.equal(rec.subjectAttemptId, 'att-1');
  assert.equal(rec.subjectModel, 'gpt-x');
  assert.equal(rec.parentChatId, 'p1');
  assert.equal(rec.leafId, 'leaf1');
  assert.ok(!fs.readFileSync(path.join(dataDir, 'wakeups.json'), 'utf8').includes('SECRET'));
});

test('nextChain: 0 after the gap, previous + 1 inside it', () => {
  const prev = { state: 'resumed', chain: 1, lastResumeAt: new Date(NOW - 1000).toISOString() };
  assert.equal(nextChain({ previousRecord: prev, pausedAt: new Date(NOW).toISOString() }), 2);
  const stale = { ...prev, lastResumeAt: new Date(NOW - CHAIN_GAP_MS - 1).toISOString() };
  assert.equal(nextChain({ previousRecord: stale, pausedAt: new Date(NOW).toISOString() }), 0);
  assert.equal(nextChain({ previousRecord: { ...prev, state: 'armed' }, pausedAt: new Date(NOW).toISOString() }), 0);
  assert.equal(nextChain({}), 0);
});

test('chain is carried into a re-armed pause after a resume', () => {
  const dataDir = tmp();
  saveWakeups([{
    ...buildPauseRecord({ subjectType: 'chat', subjectId: 'c1', harness: 'claude', model: 'sonnet', resetAt: '2026-10-19T08:00:00Z', pausedAt: '2026-10-19T07:00:00Z', chain: 0 }),
    state: 'resumed', lastResumeAt: new Date(NOW - 60000).toISOString(),
  }], { dataDir, now: NOW });
  const rec = armChatUsageLimitPause(chatInput(), deps(dataDir));
  assert.equal(rec.chain, 1);
});

test('normalizePauseRecord returns null for unknown or partial rows', () => {
  assert.equal(normalizePauseRecord(null), null);
  assert.equal(normalizePauseRecord({ kind: 'other' }), null);
  assert.equal(normalizePauseRecord({ kind: 'usage_limit_resume', id: 'x' }), null);
  const rec = buildPauseRecord({ subjectType: 'chat', subjectId: 'c', harness: 'claude', model: 'm', resetAt: 'r', pausedAt: 'p' });
  assert.equal(normalizePauseRecord(rec).id, rec.id);
});

test('new run / Stop / retry cancel the armed record of that subject only', () => {
  const dataDir = tmp();
  armChatUsageLimitPause(chatInput(), deps(dataDir));
  armChatUsageLimitPause(chatInput({ id: 'c2' }), deps(dataDir));
  assert.equal(cancelSubjectUsageLimitPauses({ subjectType: 'chat', subjectId: 'c1', reason: 'new_run' }, { dataDir }), 1);
  assert.equal(cancelSubjectUsageLimitPauses({ subjectType: 'chat', subjectId: 'c1', reason: 'new_run' }, { dataDir }), 0);
  assert.equal(listWakeups({ state: 'armed' }, { dataDir }).length, 1);
});

test('sibling delegation cancels same-leaf pause; another leaf is untouched', () => {
  const dataDir = tmp();
  const mk = (id, leafId) => armDelegationUsageLimitPause({
    id, attemptId: 'a', parentChatId: 'p', leafId, executor: { transport: 'codex', model: 'm' },
  }, deps(dataDir));
  mk('d1', 'leafA');
  mk('d2', 'leafB');
  assert.equal(cancelParentDelegationUsageLimitPauses({ parentChatId: 'p', leafId: 'leafA' }, { dataDir }), 1);
  const armed = listWakeups({ state: 'armed' }, { dataDir });
  assert.deepEqual(armed.map((r) => r.subjectId), ['d2']);
});

test('REST: list, 403 for widget/MCP, idempotent cancel', async () => {
  const dataDir = tmp();
  const rec = armChatUsageLimitPause(chatInput(), deps(dataDir));
  const app = express();
  app.use((req, _res, next) => { if (req.headers['x-widget']) req.widgetAccess = true; next(); });
  registerUsageLimitResumeRoutes(app, { dataDir });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/usage/limit-resume`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].subjectModel, 'sonnet-4');
    assert.equal((await fetch(`${base}/api/usage/limit-resume`, { headers: { 'x-widget': '1' } })).status, 403);
    const url = `${base}/api/usage/limit-resume/${encodeURIComponent(rec.id)}/cancel`;
    const first = await (await fetch(url, { method: 'POST' })).json();
    const second = await (await fetch(url, { method: 'POST' })).json();
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.item.state, 'cancelled');
    assert.equal((await fetch(`${base}/api/usage/limit-resume/nope/cancel`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});
