import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isUsageLimitMessage,
  noteHarnessUsageLimit,
  getHarnessUsageLimit,
  readHarnessUsageLimitHistory,
  clearHarnessUsageLimit,
} from '../lib/harness-usage-limits.js';
import { selectModelPick } from '../lib/model-role-profiles.js';
import { resolveDataPath, resolveProjectPath } from '../lib/runtime-paths.js';

// --- Real-data guard ---------------------------------------------------------
// `harness-usage-limits.js` resolves its default file once at import time.
// The 2026-09 leak (`opencode / test-usage-limit-<pid>`) happened when that
// module was imported while CRETLI_DATA_DIR still pointed at the repo `data/`.
// The isolated helper must therefore win the import race; assert that here and
// verify the repo store is byte-identical before/after this suite.
assert.equal(resolveDataPath(), ISOLATED_DATA_DIR, 'default data dir must be the isolated one');
assert.ok(
  resolveDataPath('harness-usage-limits.json').startsWith(ISOLATED_DATA_DIR),
  'default limits file must live under the isolated data dir',
);
const realLimitsFile = resolveProjectPath('data', 'harness-usage-limits.json');
const realHistoryFile = resolveProjectPath('data', 'usage', 'limits.jsonl');
const readIfExists = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const realLimitsBefore = readIfExists(realLimitsFile);
const realHistoryBefore = readIfExists(realHistoryFile);

assert.equal(isUsageLimitMessage('Usage limit reached for 5 hour.'), true);
assert.equal(isUsageLimitMessage('429 quota has been exhausted'), true);
assert.equal(isUsageLimitMessage('permission denied'), false);

const model = `test-usage-limit-${process.pid}`;
assert.equal(noteHarnessUsageLimit({
  harness: 'opencode',
  model,
  message: 'Usage limit reached. Your limit will reset at 2099-01-02 03:04:05',
}), true);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model })?.usage, undefined);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model })?.model, model);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model: `${model}::effort=high` })?.model, model);

// --- History is append-only and carries a short code, never the message text ---
const history = readHarnessUsageLimitHistory({ harness: 'opencode' });
assert.equal(history.length, 1);
assert.equal(history[0].harness, 'opencode');
assert.equal(history[0].model, model);
assert.equal(history[0].source, 'error-text');
assert.equal(typeof history[0].code, 'string');
assert.equal(Number.isFinite(Date.parse(history[0].resetAt)), true);
assert.ok(Date.parse(history[0].resetAt) > Date.now());
assert.equal(
  JSON.stringify(history[0]).includes('limit will reset'),
  false,
  'raw error text must not be persisted in history',
);

// Range filtering drops rows outside [from, to].
assert.equal(
  readHarnessUsageLimitHistory({ harness: 'opencode', from: '2098-01-01', to: '2098-12-31' }).length,
  0,
);
assert.equal(
  readHarnessUsageLimitHistory({ harness: 'opencode', from: '2000-01-01', to: '2100-12-31' }).length,
  1,
);

// --- Structured rate-limit events create a lockout with the matching source ---
assert.equal(noteHarnessUsageLimit({
  harness: 'claude',
  model: 'claude-sonnet-4-5::effort=high',
  source: 'rate-limit-event',
  status: 'rejected',
  resetAt: '2099-01-01T00:00:00.000Z',
  code: 'rate_limit_five_hour',
}), true);
const claudeHistory = readHarnessUsageLimitHistory({ harness: 'claude' });
assert.equal(claudeHistory.length, 1);
assert.equal(claudeHistory[0].source, 'rate-limit-event');
assert.equal(claudeHistory[0].code, 'rate_limit_five_hour');
assert.equal(claudeHistory[0].model, 'claude-sonnet-4-5');

// A warning window is advisory only and must not lock the model out.
assert.equal(noteHarnessUsageLimit({
  harness: 'claude',
  model: 'claude-sonnet-4-5',
  source: 'rate-limit-event',
  status: 'allowed_warning',
  resetAt: '2099-01-01T00:00:00.000Z',
}), false);
assert.equal(readHarnessUsageLimitHistory({ harness: 'claude' }).length, 1);

// --- Manual unlock ---
assert.ok(getHarnessUsageLimit({ harness: 'opencode', model }));
assert.equal(clearHarnessUsageLimit('opencode', model), 1);
assert.equal(getHarnessUsageLimit({ harness: 'opencode', model }), null);
assert.equal(clearHarnessUsageLimit('opencode', model), 0);
assert.equal(clearHarnessUsageLimit('claude'), 1);
assert.equal(getHarnessUsageLimit({ harness: 'claude' }), null);

const picked = selectModelPick({
  role: 'implement',
  harnesses: [{ id: 'opencode', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: {
    opencode: {
      favorites_configured: true,
      items: [{ id: model, label: 'Limited', available: false, roles: ['implement'] }],
    },
  },
});
assert.equal(picked.ok, false);
assert.equal(picked.code, 'MODEL_UNAVAILABLE');

// --- Dedupe: a repeated active incident must not append another history row ---
const dedupeDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-dedupe-'));
try {
  const candidate = {
    harness: 'claude',
    model: 'claude-dedupe',
    source: 'rate-limit-event',
    status: 'rejected',
    resetAt: '2099-06-01T00:00:00.000Z',
    code: 'rate_limit_five_hour',
    dataDir: dedupeDir,
  };
  assert.equal(noteHarnessUsageLimit(candidate), true);
  assert.equal(noteHarnessUsageLimit(candidate), true);
  assert.equal(readHarnessUsageLimitHistory({ harness: 'claude', dataDir: dedupeDir }).length, 1);

  // The same harness/model with a different resetAt is a genuinely new incident.
  assert.equal(noteHarnessUsageLimit({ ...candidate, resetAt: '2099-07-01T00:00:00.000Z' }), true);
  assert.equal(readHarnessUsageLimitHistory({ harness: 'claude', dataDir: dedupeDir }).length, 2);
} finally {
  rmSync(dedupeDir, { recursive: true, force: true });
}

// --- Retention: every 100 appends the history is trimmed atomically ---
const retentionDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-retention-'));
try {
  const usageDir = path.join(retentionDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  const historyFile = path.join(usageDir, 'limits.jsonl');
  const oldRow = {
    ts: '2020-01-01T00:00:00.000Z',
    harness: 'claude',
    model: 'ancient',
    resetAt: '2020-01-01T01:00:00.000Z',
    source: 'error-text',
    code: 'usage_limit',
  };
  writeFileSync(historyFile, `${JSON.stringify(oldRow)}\n`, 'utf8');
  for (let i = 0; i < 99; i += 1) {
    assert.equal(noteHarnessUsageLimit({
      harness: 'claude',
      model: `retention-${i}`,
      source: 'rate-limit-event',
      status: 'rejected',
      resetAt: '2099-01-01T00:00:00.000Z',
      dataDir: retentionDir,
    }), true);
  }
  // The 100th append triggers the retention pass and drops the out-of-window row.
  assert.equal(noteHarnessUsageLimit({
    harness: 'claude',
    model: 'retention-final',
    source: 'rate-limit-event',
    status: 'rejected',
    resetAt: '2099-01-01T00:00:00.000Z',
    dataDir: retentionDir,
  }), true);

  const remaining = readHarnessUsageLimitHistory({ harness: 'claude', dataDir: retentionDir });
  assert.equal(remaining.some((row) => row.model === 'ancient'), false);
  assert.equal(remaining.length, 100);
} finally {
  rmSync(retentionDir, { recursive: true, force: true });
}

assert.equal(readIfExists(realLimitsFile), realLimitsBefore, 'suite must not write the repo data/harness-usage-limits.json');
assert.equal(readIfExists(realHistoryFile), realHistoryBefore, 'suite must not append to the repo data/usage/limits.jsonl');

removeIsolatedDataDir();
console.log('harness-usage-limits.test.js OK');
