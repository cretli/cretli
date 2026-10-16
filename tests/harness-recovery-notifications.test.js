import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import {
  listHarnessUsageLimits, listHarnessRecoveryNotices, noteHarnessUsageLimit,
} from '../lib/harness-usage-limits.js';
import { publishHarnessRecoveryNotices } from '../lib/notifications/harness-recovery-producer.js';
import { normalizeNotificationCenterPreferences as normalizeServer } from '../lib/notifications/notification-preferences.js';
import { normalizeNotificationCenterPreferences as normalizeClient } from '../app_front/features/notifications/notificationStore.js';

const now = Date.now();
const file = path.join(ISOLATED_DATA_DIR, 'harness-usage-limits.json');
const expired = new Date(now - 1000).toISOString();
const rows = [
  { harness: 'claude', source: 'rate-limit-event', code: 'rate_limit_five_hour', resetSource: 'provider', resetAt: expired },
  { harness: 'codex', model: 'example-model', message: 'Usage limit reached', code: 'usage_limit', resetSource: 'provider-message', resetAt: expired },
  { harness: 'qwen', message: '429 quota exhausted', code: 'usage_limit', resetSource: 'fallback-ttl', resetAt: expired },
  { harness: 'deepseek', message: 'Insufficient balance', code: 'insufficient_balance', resetAt: expired },
  { harness: 'opencode', code: 'model_unavailable', resetAt: expired },
  { harness: 'cursor', code: 'usage_limit', message: 'usage limit', resetAt: new Date(now + 60_000).toISOString() },
];
writeFileSync(file, JSON.stringify(rows));
after(removeIsolatedDataDir);

test('startup retains expired notices; active-list reads cannot consume them', () => {
  assert.equal(listHarnessUsageLimits().length, 1);
  assert.equal(listHarnessRecoveryNotices({ now }).length, 3);
});

test('publishes for Claude, Codex and other harnesses once, with honest fallback wording', async () => {
  const notices = [];
  const pushes = [];
  const options = { now, preferences: { harnessRecovery: true },
    publish: async (row) => { notices.push(row); return { created: true }; },
    push: async (row) => pushes.push(row),
  };
  assert.equal(await publishHarnessRecoveryNotices(options), 3);
  assert.equal(await publishHarnessRecoveryNotices(options), 0);
  assert.equal(pushes.length, 3);
  assert.match(notices[0].body, /provider's stated reset/);
  assert.match(notices[1].body, /codex \(example-model\)/);
  assert.match(notices[2].body, /not been confirmed/);
  assert.equal(new Set(notices.map((row) => row.fingerprint)).size, 3);
  assert.equal(JSON.parse(readFileSync(file)).length, 3);
});

test('failed publish retries; disabling consumes pending notices without a backlog', async () => {
  noteHarnessUsageLimit({ harness: 'codex', message: 'usage limit', resetAt: now + 100_000 });
  const future = now + 200_000;
  await assert.rejects(publishHarnessRecoveryNotices({ now: future, preferences: { harnessRecovery: true }, publish: async () => { throw new Error('disk failed'); } }));
  assert.ok(listHarnessRecoveryNotices({ now: future }).length > 0);
  let published = false;
  await publishHarnessRecoveryNotices({ now: future, preferences: { harnessRecovery: false }, publish: async () => { published = true; } });
  assert.equal(published, false);
  assert.equal(listHarnessRecoveryNotices({ now: future }).length, 0);
});

test('preference survives normalization on client and server', () => {
  for (const harnessRecovery of [true, false]) {
    assert.deepEqual(normalizeServer({ harnessRecovery }), normalizeClient({ harnessRecovery }));
    assert.equal(normalizeServer({ harnessRecovery }).harnessRecovery, harnessRecovery);
  }
});

test('a new lockout recorded during delivery survives acknowledgement', async () => {
  noteHarnessUsageLimit({ harness: 'claude', message: 'session limit', resetAt: now + 300_000 });
  await publishHarnessRecoveryNotices({ now: now + 400_000, preferences: { harnessRecovery: true },
    publish: async () => {
      noteHarnessUsageLimit({ harness: 'claude', message: 'session limit', resetAt: now + 800_000 });
      return { created: true };
    },
    push: async () => {},
  });
  assert.ok(listHarnessUsageLimits().some((row) => row.harness === 'claude' && Date.parse(row.resetAt) === now + 800_000));
});

test('a deduplicated persisted notification does not send another push', async () => {
  noteHarnessUsageLimit({ harness: 'qwen', message: 'usage limit', resetAt: now + 500_000 });
  let pushed = false;
  await publishHarnessRecoveryNotices({ now: now + 600_000, preferences: { harnessRecovery: true },
    publish: async () => ({ created: false }),
    push: async () => { pushed = true; },
  });
  assert.equal(pushed, false);
  assert.equal(listHarnessRecoveryNotices({ now: now + 600_000 }).length, 0);
});

test('a Codex usage-limit row with an upsell message still gets a recovery notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cretli-recovery-codex-'));
  try {
    const expired = new Date(Date.now() - 1000).toISOString();
    const codexMessage = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/codex/settings/usage), visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
    writeFileSync(path.join(dir, 'harness-usage-limits.json'), JSON.stringify([
      { harness: 'codex', model: '', message: codexMessage, code: 'usage_limit', resetSource: 'fallback-ttl', resetAt: expired },
      { harness: 'deepseek', model: '', message: 'Insufficient Balance', code: 'insufficient_balance', resetAt: expired },
      { harness: 'legacy', model: '', message: codexMessage, resetAt: expired },
      { harness: 'legacy-balance', model: '', message: 'Insufficient Balance', resetAt: expired },
    ]));
    const notices = listHarnessRecoveryNotices({ now: Date.now(), dataDir: dir });
    const harnesses = notices.map((row) => row.harness).sort();
    assert.deepEqual(harnesses, ['codex', 'legacy']);
    assert.equal(harnesses.includes('deepseek'), false, 'a genuine balance row is not a recovery notice');
    assert.equal(harnesses.includes('legacy-balance'), false, 'a code-less balance row is not a recovery notice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
