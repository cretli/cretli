import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.ts';
import { clearHarnessUsageLimit } from '../lib/harness-usage-limits.js';
import { createWakeupScheduler } from '../lib/wakeup-scheduler.js';
import { USAGE_LIMIT_RESUME_KIND } from '../lib/usage-limit-paused.js';
import { createResumeAnnouncers, appendPauseChatNotice } from '../lib/usage-limit-resume-notices.js';
import {
  fingerprintResumeEpisode,
  publishUsageLimitResumeNotification,
} from '../lib/notifications/usage-limit-resume-producer.ts';
import { normalizeNotificationCenterPreferences } from '../lib/notifications/notification-preferences.ts';

void ISOLATED_DATA_DIR;

const record = (over = {}) => ({
  id: 'pause:a', kind: USAGE_LIMIT_RESUME_KIND, subjectType: 'chat', subjectId: 'c1', harness: 'claude',
  model: 'opus', state: 'resumed', reason: '', resetAt: '2026-10-19T14:30:00.000Z', ...over,
});

function recorder() {
  const published = [];
  const pushes = [];
  const seen = new Set();
  return {
    published,
    pushes,
    publish: async (n) => {
      if (seen.has(n.fingerprint)) return { created: false };
      seen.add(n.fingerprint);
      published.push(n);
      return { created: true };
    },
    push: async (p) => { pushes.push(p); },
  };
}

test('preference defaults to true on the server', () => {
  assert.equal(normalizeNotificationCenterPreferences({}).usageLimitResume, true);
  assert.equal(normalizeNotificationCenterPreferences({ usageLimitResume: false }).usageLimitResume, false);
});

test('one notification per episode state; a replay publishes nothing', async () => {
  const rec = recorder();
  const options = { preferences: { usageLimitResume: true }, publish: rec.publish, push: rec.push };
  assert.deepEqual(await publishUsageLimitResumeNotification({ record: record() }, options), { published: true });
  assert.equal((await publishUsageLimitResumeNotification({ record: record() }, options)).published, false);
  assert.equal(rec.published.length, 1);
  assert.equal(rec.pushes.length, 1);
  assert.equal(rec.published[0].category, 'system');
  assert.match(rec.published[0].actionUrl, /^\/\?panel=chat&chat=c1$/);
});

test('fingerprint differs per pause id and per state', () => {
  const a = fingerprintResumeEpisode(record());
  assert.equal(a, 'usage-limit-resume:pause:a:resumed');
  assert.notEqual(a, fingerprintResumeEpisode(record({ id: 'pause:b' })));
  assert.notEqual(a, fingerprintResumeEpisode(record({ state: 'blocked' })));
});

test('blocked start_uncertain publishes exactly one notification', async () => {
  const rec = recorder();
  const options = { preferences: {}, publish: rec.publish, push: rec.push };
  const blocked = record({ state: 'blocked', reason: 'start_uncertain' });
  await publishUsageLimitResumeNotification({ record: blocked }, options);
  await publishUsageLimitResumeNotification({ record: blocked }, options);
  assert.equal(rec.published.length, 1);
  assert.match(rec.published[0].body, /not repeated/);
});

test('states without a notification publish nothing', async () => {
  const rec = recorder();
  for (const state of ['armed', 'resuming', 'cancelled']) {
    const out = await publishUsageLimitResumeNotification({ record: record({ state }) }, { preferences: {}, publish: rec.publish, push: rec.push });
    assert.equal(out.published, false);
  }
  assert.equal(rec.published.length, 0);
});

test('preference off suppresses publishing and push', async () => {
  const rec = recorder();
  const out = await publishUsageLimitResumeNotification({ record: record() }, { preferences: { usageLimitResume: false }, publish: rec.publish, push: rec.push });
  assert.deepEqual(out, { published: false, reason: 'disabled' });
  assert.equal(rec.published.length + rec.pushes.length, 0);
});

test('a push failure never breaks the producer', async () => {
  const rec = recorder();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const out = await publishUsageLimitResumeNotification({ record: record() }, {
      preferences: {}, publish: rec.publish, push: async () => { throw new Error('push down'); },
    });
    assert.equal(out.published, true);
  } finally {
    console.warn = originalWarn;
  }
});

test('a publish failure is reported, never thrown into the scheduler tick', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const out = await publishUsageLimitResumeNotification({ record: record() }, {
      preferences: {}, publish: async () => { throw new Error('store down'); }, push: async () => {},
    });
    assert.deepEqual(out, { published: false, reason: 'publish_failed' });
  } finally {
    console.warn = originalWarn;
  }
});

// ---- chat notices -------------------------------------------------------

/** Scheduler over an in-memory store with the real announcers and a stub kind. */
function schedulerHarness({ rows, enabled = true, execute, resolveCrash }) {
  const store = rows.map((r) => ({ ...r }));
  const notices = [];
  const rec = recorder();
  const announcers = createResumeAnnouncers({
    readSettings: () => ({ enabled }),
    publish: (payload) => publishUsageLimitResumeNotification(payload, { preferences: {}, publish: rec.publish, push: rec.push }),
    appendNotice: async (chatId, text, meta) => { notices.push({ chatId, text, meta }); return { ok: true }; },
  });
  const scheduler = createWakeupScheduler({
    store: {
      list: () => store.map((r) => ({ ...r })),
      patch: (id, fields, _now, expectState) => {
        const row = store.find((r) => r.id === id);
        if (!row || (expectState && row.state !== expectState)) return null;
        Object.assign(row, fields);
        return { ...row };
      },
    },
    ...announcers,
  });
  scheduler.registerKind({
    kind: USAGE_LIMIT_RESUME_KIND,
    getSettings: () => ({ enabled, maxPerTick: 3 }),
    normalize: (row) => ({ ...row }),
    selectCandidates: ({ records }) => records.filter((r) => r.state === 'armed').map((record) => ({ record, dueAt: 0 })),
    prepare: () => ({}),
    decide: () => ({ action: 'resume', reason: '' }),
    execute: async () => (execute ? execute() : { outcome: 'resumed', reason: '' }),
    resolveCrash: async () => (resolveCrash ? resolveCrash() : { outcome: 'blocked', reason: 'start_uncertain' }),
  });
  return { scheduler, store, notices, rec };
}

const armedRow = (over = {}) => record({ state: 'armed', attempts: 0, pendingAttempt: 0, resumeRequestId: '', ...over });

test('a resumed pause appends one notice and one notification; a second tick adds nothing', async () => {
  const h = schedulerHarness({ rows: [armedRow()] });
  await h.scheduler.tick({ now: 1 });
  await h.scheduler.tick({ now: 2 });
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].chatId, 'c1');
  assert.match(h.notices[0].text, /Resumed automatically/);
  assert.equal(h.notices[0].meta.action, 'usage_limit_resume');
  assert.equal(h.rec.published.length, 1);
});

test('a start_uncertain episode appends exactly one notice and one notification', async () => {
  const h = schedulerHarness({ rows: [armedRow({ state: 'resuming', attempts: 1, pendingAttempt: 1 })] });
  await h.scheduler.tick({ now: 1 });
  await h.scheduler.tick({ now: 2 });
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].meta.level, 'warning');
  assert.match(h.notices[0].text, /not repeated/);
  assert.equal(h.rec.published.length, 1);
});

test('a delegation subject gets a notification but no chat notice', async () => {
  const h = schedulerHarness({ rows: [armedRow({ subjectType: 'delegation', subjectId: 'd1' })] });
  await h.scheduler.tick({ now: 1 });
  assert.equal(h.notices.length, 0);
  assert.equal(h.rec.published.length, 1);
});

test('a disabled feature appends and publishes nothing', async () => {
  const h = schedulerHarness({ rows: [armedRow()], enabled: false });
  await h.scheduler.tick({ now: 1 });
  assert.equal(h.notices.length, 0);
  assert.equal(h.rec.published.length, 0);
});

test('a failing notice append is logged and never breaks the tick', async () => {
  const logs = [];
  const ok = await appendPauseChatNotice({ record: record() }, {
    appendChatNotice: async () => { throw new Error('disk full'); },
    log: (event) => logs.push(event),
  });
  assert.equal(ok, false);
  assert.deepEqual(logs, ['usage-limit-resume-notice-failed']);
});

// ---- arm notice through the room kernel ---------------------------------

const QUOTA = "You've hit your session limit · resets 2:30pm";
const quotaError = { type: 'sdkRunFinished', runId: 'r1', status: 'error', lastErrorMessage: QUOTA };

function kernelWith(settings) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ulr-notice-'));
  const notices = [];
  const kernel = createAgentRoomKernel({
    transport: 'qwen',
    persistHistory: () => {},
    recordUsage: () => null,
    usageDataDir: dataDir,
    usageLimitPauseDeps: {
      settings,
      resolveContext: () => ({ context: 'legacy_ad_hoc' }),
      findChat: (id) => ({ id }),
      appendChatNotice: async (chatId, text, meta) => { notices.push({ chatId, text, meta }); return { ok: true }; },
    },
  });
  return { kernel, notices };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an armed pause appends one "paused until" notice; re-detection appends nothing', async () => {
  clearHarnessUsageLimit({ harness: 'qwen' });
  const { kernel, notices } = kernelWith({ usageLimitResume: { enabled: true } });
  const room = kernel.createRoomState({ sessionKey: 's1', chatId: 'c1', modelId: 'qwen-max' });
  kernel.broadcastRoom(room, quotaError);
  await flush();
  kernel.broadcastRoom(room, { ...quotaError, runId: 'r2' });
  await flush();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].chatId, 'c1');
  assert.match(notices[0].text, /paused until \d\d:\d\d UTC/);
  assert.equal(notices[0].meta.action, 'usage_limit_resume');
});

test('a disabled feature arms nothing and appends no notice', async () => {
  clearHarnessUsageLimit({ harness: 'qwen' });
  const { kernel, notices } = kernelWith({ usageLimitResume: { enabled: false } });
  const room = kernel.createRoomState({ sessionKey: 's2', chatId: 'c2', modelId: 'qwen-max' });
  kernel.broadcastRoom(room, quotaError);
  await flush();
  assert.equal(notices.length, 0);
});
