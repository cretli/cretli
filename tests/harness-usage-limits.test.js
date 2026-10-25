import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isInsufficientBalanceMessage,
  isModelUnavailableMessage,
  isUsageLimitMessage,
  noteHarnessUsageLimit,
  noteUnclassifiedRunError,
  normalizeFailureSignature,
  redactFailureText,
  getHarnessUsageLimit,
  listHarnessUsageLimits,
  readHarnessUsageLimitHistory,
  clearHarnessUsageLimit,
  selectUsageLimitMessage,
} from '../lib/harness-usage-limits.js';
import { classifyDelegationFailure } from '../lib/delegation-failure-class.js';
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

// Qwen token-plan reset timestamps omit the year but include UTC explicitly.
{
  const qwenDir = mkdtempSync(path.join(tmpdir(), 'cretli-qwen-usage-limit-'));
  try {
    const message = '429 Your token-plan 1-month quota has been exhausted. The quota will reset at 11-04 16:00:00 UTC.';
    assert.equal(noteHarnessUsageLimit({ harness: 'qwen', model: 'qwen3.8-max', message, dataDir: qwenDir }), true);
    const locked = getHarnessUsageLimit({ harness: 'qwen', model: 'qwen3.8-max', dataDir: qwenDir });
    const now = new Date();
    let year = now.getUTCFullYear();
    let expectedResetAt = Date.UTC(year, 10, 4, 16, 0, 0);
    if (expectedResetAt <= now.getTime()) expectedResetAt = Date.UTC(++year, 10, 4, 16, 0, 0);
    assert.equal(locked?.resetAt, new Date(expectedResetAt).toISOString());
    assert.equal(locked?.resetSource, 'provider-message');
  } finally {
    rmSync(qwenDir, { recursive: true, force: true });
  }
}

// The Qwen quota often surfaces only as assistant prose while the run error is
// the generic fallback. The adapter forwards both as `messages`, and the
// lockout must use the provider's clock instead of the TTL fallback.
{
  const qwenDir = mkdtempSync(path.join(tmpdir(), 'cretli-qwen-usage-limit-candidates-'));
  try {
    const prose = 'Quota exhausted: Your token-plan 1-month quota has been exhausted. The quota will reset at 11-04 16:00:00 UTC.';
    assert.equal(noteHarnessUsageLimit({
      harness: 'qwen',
      model: 'qwen3.8-max',
      message: 'Qwen run failed',
      messages: ['Qwen run failed', prose],
      dataDir: qwenDir,
    }), true);
    const locked = getHarnessUsageLimit({ harness: 'qwen', model: 'qwen3.8-max', dataDir: qwenDir });
    const now = new Date();
    let year = now.getUTCFullYear();
    let expectedResetAt = Date.UTC(year, 10, 4, 16, 0, 0);
    if (expectedResetAt <= now.getTime()) expectedResetAt = Date.UTC(++year, 10, 4, 16, 0, 0);
    assert.equal(locked?.resetAt, new Date(expectedResetAt).toISOString());
    assert.equal(locked?.resetSource, 'provider-message');
  } finally {
    rmSync(qwenDir, { recursive: true, force: true });
  }
}

// --- Codex: account-wide usage limit, never an empty balance ----------------
// A real Codex limit carries an upsell ("...to purchase more credits or try
// again at 1:01 PM"). That phrase must not classify the account as out of
// credit: the row stays a usage limit, keeps the harness-wide scope a Codex
// plan window requires, and uses the stated clock (or the 1h TTL without one).
{
  const codexMessage = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/codex/settings/usage?utm_source=chatgpt), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:01 PM.";
  assert.equal(isInsufficientBalanceMessage(codexMessage), false, 'the upsell is not a no-balance message');
  const codexDir = mkdtempSync(path.join(tmpdir(), 'cretli-codex-usage-limit-'));
  try {
    assert.equal(noteHarnessUsageLimit({
      harness: 'codex',
      model: 'gpt-5-codex',
      message: codexMessage,
      dataDir: codexDir,
    }), true);
    const locked = getHarnessUsageLimit({ harness: 'codex', model: 'gpt-5-codex', dataDir: codexDir });
    assert.equal(locked?.code, 'usage_limit');
    assert.equal(locked?.model, '', 'a Codex plan window is account-wide');
    assert.equal(locked?.resetSource, 'provider-message');
    const parts = new Intl.DateTimeFormat('en-CA', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(locked.resetAt));
    const clock = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    assert.equal(`${clock.hour}:${clock.minute}`, '13:01', 'the stated clock drives the reset');
    const sibling = getHarnessUsageLimit({ harness: 'codex', model: 'sibling-model', dataDir: codexDir });
    assert.equal(sibling?.model, '', 'the account-wide lockout also covers sibling models');
    assert.equal(sibling?.code, 'usage_limit');
  } finally {
    rmSync(codexDir, { recursive: true, force: true });
  }

  // Without a stated clock the row keeps the 1h usage-limit TTL, not 6h.
  const codexTtlDir = mkdtempSync(path.join(tmpdir(), 'cretli-codex-usage-limit-ttl-'));
  try {
    const beforeTtl = Date.now();
    assert.equal(noteHarnessUsageLimit({
      harness: 'codex',
      model: 'gpt-5-codex',
      message: "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits.",
      dataDir: codexTtlDir,
    }), true);
    const locked = getHarnessUsageLimit({ harness: 'codex', model: 'gpt-5-codex', dataDir: codexTtlDir });
    const ttlDelta = new Date(locked.resetAt).getTime() - beforeTtl;
    assert.equal(locked.code, 'usage_limit');
    assert.ok(ttlDelta > 59 * 60 * 1000 && ttlDelta <= 61 * 60 * 1000, 'clock-less codex keeps the 1h TTL');
  } finally {
    rmSync(codexTtlDir, { recursive: true, force: true });
  }
}

// The delegation classifier keeps a Codex quota harness-wide, even though the
// phrase that used to trigger the balance branch is gone.
{
  const codexMessage = "You've hit your usage limit. Upgrade to Pro, visit https://chatgpt.com/codex/settings/usage to purchase more credits.";
  const failure = classifyDelegationFailure({ harness: 'codex', error: codexMessage });
  assert.equal(failure.failureClass, 'quota');
  assert.equal(failure.scope, 'harness');
  assert.equal(failure.harnessWide, true);
  assert.equal(classifyDelegationFailure({ harness: 'deepseek', error: 'Insufficient Balance' }).scope, 'harness');
}

// A rejected model id is not a quota problem, but it must lock that one model
// out of automatic picks (CodeBuddy `400 model [x] service info not found`).
{
  const unavailableText = '400 model [hy3-preview] service info not found (8dad662a/373a8938)';
  assert.equal(isModelUnavailableMessage(unavailableText), true);
  assert.equal(isModelUnavailableMessage('The model `x` does not exist: model_not_found'), true);
  assert.equal(isModelUnavailableMessage('file not found'), false);
  assert.equal(isModelUnavailableMessage('Your current subscription plan does not yet include access to GLM-5.3-Highspeed'), true);
  assert.equal(isModelUnavailableMessage("The 'auto' model is not supported when using Codex with a ChatGPT account."), true);
  assert.equal(isModelUnavailableMessage('Tool workspace_watcher_show not found in agent cli.'), false);
  assert.equal(isModelUnavailableMessage('MCP service info not found'), false, 'needs the model in the message');
  assert.equal(
    isModelUnavailableMessage('429 rate limit: model [x] is not available right now'),
    false,
    'usage-limit wording is classified as a limit, never as an unavailable model',
  );
  assert.equal(isUsageLimitMessage(unavailableText), false);
  const unavailableDir = mkdtempSync(path.join(tmpdir(), 'cretli-model-unavailable-'));
  try {
    assert.equal(noteHarnessUsageLimit({ harness: 'codebuddy', message: unavailableText, dataDir: unavailableDir }), false,
      'no model id: must not lock the whole harness');
    assert.equal(getHarnessUsageLimit({ harness: 'codebuddy', model: 'hy3', dataDir: unavailableDir }), null);
    assert.equal(
      noteUnclassifiedRunError({ harness: 'codebuddy', message: unavailableText, dataDir: unavailableDir }),
      true,
      'without a model id the rejection stays visible in the unclassified log',
    );
    assert.equal(
      noteUnclassifiedRunError({ harness: 'codebuddy', model: 'hy3-preview', message: unavailableText, dataDir: unavailableDir }),
      false,
      'with a model id the lockout is the record',
    );
    assert.equal(noteHarnessUsageLimit({
      harness: 'codebuddy', model: 'hy3-preview', message: unavailableText, dataDir: unavailableDir,
    }), true);
    const locked = getHarnessUsageLimit({ harness: 'codebuddy', model: 'hy3-preview', dataDir: unavailableDir });
    assert.equal(locked?.code, 'model_unavailable');
    assert.ok(new Date(locked.resetAt).getTime() - Date.now() > 23 * 60 * 60 * 1000);
    assert.equal(getHarnessUsageLimit({ harness: 'codebuddy', model: 'hy3', dataDir: unavailableDir }), null,
      'sibling models stay pickable');
    assert.equal(existsSync(path.join(unavailableDir, 'usage', 'plan-limits.jsonl')), false,
      'a rejected model id is not a plan-limit reading');
  } finally {
    rmSync(unavailableDir, { recursive: true, force: true });
  }
}

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

// --- Regression: the message with a reset clock wins over the clock-less one ---
// A real Claude run surfaced both `Claude rate limit reached. Try again later.`
// (generic) and `You've hit your session limit · resets 1:50am (Europe/Warsaw)`
// (provider prose). The lockout must use 1:50 Europe/Warsaw, never the 1h TTL.
{
  const resetDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-reset-clock-'));
  try {
    const withoutClock = 'Claude rate limit reached. Try again later.';
    const withClock = "You've hit your session limit · resets 1:50am (Europe/Warsaw)";
    assert.equal(
      selectUsageLimitMessage([withoutClock, withClock]),
      withClock,
      'the candidate carrying a parseable reset clock must win',
    );
    assert.equal(selectUsageLimitMessage([withoutClock]), withoutClock, 'no clock: the first candidate stays');
    assert.equal(
      selectUsageLimitMessage([withClock, withoutClock]),
      withClock,
      'candidate order must not hide the clock',
    );
    assert.equal(
      selectUsageLimitMessage(['quota exhausted', 'quota exhausted · resets 9:05pm (America/New_York)']),
      'quota exhausted · resets 9:05pm (America/New_York)',
      'the selection stays harness-agnostic',
    );

    const clockModel = `test-reset-clock-${process.pid}`;
    assert.equal(noteHarnessUsageLimit({
      harness: 'claude',
      model: clockModel,
      message: withoutClock,
      messages: [withoutClock, withClock],
      dataDir: resetDir,
    }), true);
    const locked = getHarnessUsageLimit({ harness: 'claude', model: clockModel, dataDir: resetDir });
    assert.ok(locked, 'the run must lock the claude model');
    const clockParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(locked.resetAt));
    const clock = Object.fromEntries(clockParts.map(({ type, value }) => [type, value]));
    assert.equal(
      `${clock.hour}:${clock.minute}`,
      '01:50',
      'resetAt must be the stated 1:50am Europe/Warsaw, not the TTL fallback',
    );

    // No candidate states a clock: the conservative TTL fallback stays.
    const ttlModel = `test-reset-ttl-${process.pid}`;
    const beforeTtl = Date.now();
    assert.equal(noteHarnessUsageLimit({
      harness: 'claude',
      model: ttlModel,
      message: withoutClock,
      dataDir: resetDir,
    }), true);
    const ttlLock = getHarnessUsageLimit({ harness: 'claude', model: ttlModel, dataDir: resetDir });
    const ttlDelta = new Date(ttlLock.resetAt).getTime() - beforeTtl;
    assert.ok(ttlDelta > 59 * 60 * 1000 && ttlDelta <= 61 * 60 * 1000, 'clock-less keeps the 1h TTL');
  } finally {
    rmSync(resetDir, { recursive: true, force: true });
  }
}

// --- OpenAI/Codex states its window reset as "try again at <clock>" ---
// The same message also mentions purchasing credits, so the balance path used
// to hold the whole harness for a synthetic 6h even though the provider named
// the moment its 5-hour window reopens. The stated clock must win, and a bare
// duration ("in 20 minutes") must never be read as a wall clock.
{
  const retryDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-retry-clock-'));
  const durationDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-retry-duration-'));
  try {
    const message = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), "
      + 'visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 1:01 PM.';
    assert.equal(noteHarnessUsageLimit({ harness: 'codex', model: 'auto', message, dataDir: retryDir }), true);
    const row = getHarnessUsageLimit({ harness: 'codex', model: 'gpt-6-luna', dataDir: retryDir });
    assert.equal(row.model, '', 'a Codex account window blocks the whole harness');
    assert.equal(row.resetSource, 'provider-message', 'the stated retry clock beats the 6h balance TTL');
    const parts = new Intl.DateTimeFormat('en-CA', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(row.resetAt));
    const clock = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    assert.equal(`${clock.hour}:${clock.minute}`, '13:01', 'resetAt is the stated 1:01 PM clock');

    assert.equal(noteHarnessUsageLimit({
      harness: 'codex', model: 'auto', message: "You’ve hit your usage limit. Try again in 20 minutes.", dataDir: durationDir,
    }), true);
    const durationRow = getHarnessUsageLimit({ harness: 'codex', model: 'auto', dataDir: durationDir });
    assert.equal(durationRow.resetSource, 'fallback-ttl', 'a duration is not a wall clock');
  } finally {
    rmSync(retryDir, { recursive: true, force: true });
    rmSync(durationDir, { recursive: true, force: true });
  }
}

// --- An account-wide plan window locks the whole harness ---
// A Claude `five_hour` / `seven_day` rejection is one window shared by every
// model: scoping the lockout to the model the SDK named left the sibling models
// selectable while the provider rejected them all. A family window keeps its
// model scope.
{
  const windowDir = mkdtempSync(path.join(tmpdir(), 'cretli-limits-account-window-'));
  try {
    const resetAt = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    assert.equal(noteHarnessUsageLimit({
      harness: 'claude', model: 'claude-sonnet-5-5::effort=low', source: 'rate-limit-event',
      status: 'rejected', resetAt, rateLimitType: 'five_hour', authMode: 'subscription',
      code: 'rate_limit_five_hour', dataDir: windowDir,
    }), true);
    const row = listHarnessUsageLimits(windowDir).find((entry) => entry.harness === 'claude');
    assert.equal(row.model, '', 'an account-wide window locks the harness, not the named model');
    assert.equal(row.code, 'rate_limit_five_hour');
    assert.equal(
      getHarnessUsageLimit({ harness: 'claude', model: 'claude-opus-5-5::effort=low', dataDir: windowDir })?.code,
      'rate_limit_five_hour',
      'a sibling Claude model is blocked too',
    );

    assert.equal(noteHarnessUsageLimit({
      harness: 'claude', model: 'claude-sonnet-5-5::effort=low', source: 'rate-limit-event',
      status: 'rejected', resetAt, rateLimitType: 'seven_day_sonnet', authMode: 'subscription', dataDir: windowDir,
    }), true);
    const family = listHarnessUsageLimits(windowDir).find((entry) => entry.rateLimitType === 'seven_day_sonnet');
    assert.equal(family.model, 'claude-sonnet-5-5::effort=low', 'a family window keeps its model scope');
  } finally {
    rmSync(windowDir, { recursive: true, force: true });
  }
}

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

// --- Unclassified failures: stable, private, aggregating signatures ---
{
  assert.notEqual(
    normalizeFailureSignature('Provider error code 123'),
    normalizeFailureSignature('Provider error code 456'),
    'ordinary numbers carry meaning and must not collapse into one signature',
  );
  const privateText = 'Bearer super-secret-token api_key=abc123 at /home/alice/private/app.js via https://example.test/request?id=7';
  const redacted = redactFailureText(privateText);
  assert.doesNotMatch(redacted, /super-secret-token|abc123|alice|example\.test/);

  const dir = mkdtempSync(path.join(tmpdir(), 'cretli-unclassified-store-'));
  try {
    const file = path.join(dir, 'usage', 'unclassified-errors.jsonl');
    const first = { harness: 'sdk', model: 'cursor-fast', message: privateText, dataDir: dir };
    assert.equal(noteUnclassifiedRunError(first), true);
    assert.equal(noteUnclassifiedRunError(first), false, 'repeat updates the aggregate instead of adding a row');
    let rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.ok(rows[0].firstSeenAt);
    assert.ok(rows[0].lastSeenAt);
    assert.doesNotMatch(JSON.stringify(rows[0]), /super-secret-token|abc123|alice|example\.test/);

    const oldMessage = 'Legacy transport failure';
    const oldAt = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify({ ts: oldAt, harness: 'codex', model: 'gpt-5', signature: 'legacy', message: oldMessage })}\n`, 'utf8');
    assert.equal(noteUnclassifiedRunError({ harness: 'codex', model: 'gpt-5', message: oldMessage, dataDir: dir }), false);
    rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows[0].count, 2, 'legacy row migrates from count=1 before aggregation');
    assert.equal(rows[0].firstSeenAt, oldAt);
    assert.ok(rows[0].lastSeenAt);

    const corrupt = '{"valid":true}\nnot-json\n';
    writeFileSync(file, corrupt, 'utf8');
    assert.equal(noteUnclassifiedRunError({ harness: 'sdk', message: 'another failure', dataDir: dir }), false);
    assert.equal(readFileSync(file, 'utf8'), corrupt, 'a corrupt store must not be overwritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

assert.equal(readIfExists(realLimitsFile), realLimitsBefore, 'suite must not write the repo data/harness-usage-limits.json');
assert.equal(readIfExists(realHistoryFile), realHistoryBefore, 'suite must not append to the repo data/usage/limits.jsonl');

removeIsolatedDataDir();
console.log('harness-usage-limits.test.js OK');

// latest:true returns the active row that clears last (resume waits for max(resetAt)).
{
  const dir = mkdtempSync(path.join(tmpdir(), 'cretli-latest-limit-'));
  try {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 3 * 3_600_000).toISOString();
    writeFileSync(path.join(dir, 'harness-usage-limits.json'), JSON.stringify([
      { harness: 'claude', model: 'claude-sonnet-4', resetAt: soon, code: 'usage_limit' },
      { harness: 'claude', model: '', resetAt: later, code: 'usage_limit' },
    ]));
    assert.equal(getHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4', dataDir: dir }).resetAt, soon);
    assert.equal(getHarnessUsageLimit({ harness: 'claude', model: 'claude-sonnet-4', dataDir: dir, latest: true }).resetAt, later);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- repeated_fast_fail ------------------------------------------------------
{
  const {
    noteFastProviderFailure, classifyFastProviderFailure,
    REPEATED_FAST_FAIL_TTL_MS, FAST_FAIL_WINDOW_MS,
  } = await import('../lib/harness-usage-limits.js');
  const { isWorkspaceWatcherOrchestratorModelUsageLimited } = await import('../lib/workspace-watcher-orchestrator.js');
  const T0 = Date.now();
  const snap = (over = {}) => ({
    runId: `r-${Math.random()}`, harness: 'fastfail', model: 'ff-model', status: 'error', errorCode: '',
    errorSource: 'provider', errorMessage: 'Provider exploded with mystery code 77',
    durationMs: 800, durationKnown: true, outputTokens: 0, usageKnown: true, outputSeen: false,
    errorStage: 'unknown', explicitProviderRejectionEvidence: false, ...over,
  });
  const fresh = () => mkdtempSync(path.join(tmpdir(), 'cretli-fastfail-'));
  const run = async (dir, s, at = T0, extra = {}) => noteFastProviderFailure(s, { dataDir: dir, now: () => at, publish: async () => {}, ...extra });
  const locked = (dir, model = 'ff-model', at = T0 + 1000) => getHarnessUsageLimit({ harness: 'fastfail', model, dataDir: dir, now: at });

  {
    const dir = fresh();
    try {
      const published = [];
      const publish = async (item) => { published.push(item); };
      const first = await run(dir, snap(), T0, { publish });
      assert.equal(first.locked, false);
      assert.equal(locked(dir), null, 'one fast failure alone does not lock');
      const second = await run(dir, snap(), T0 + 5000, { publish });
      assert.equal(second.locked, true);
      const row = locked(dir, 'ff-model', T0 + 6000);
      assert.equal(row?.code, 'repeated_fast_fail');
      assert.equal(locked(dir, 'other-model', T0 + 6000), null, 'sibling model stays pickable');
      // model_pick and the orchestrator both see the model as excluded.
      const limits = listHarnessUsageLimits(dir, T0 + 6000);
      assert.equal(isWorkspaceWatcherOrchestratorModelUsageLimited('fastfail', 'ff-model', limits), true);
      assert.equal(isWorkspaceWatcherOrchestratorModelUsageLimited('fastfail', 'other-model', limits), false);
      const pick = selectModelPick({
        role: 'implement',
        harnesses: [{ id: 'fastfail', enabled: true, ready: true, can_delegate: true }],
        modelsByHarness: { fastfail: { favorites_configured: true, items: [
          { id: 'ff-model', label: 'A', available: true, roles: ['implement'] },
          { id: 'other-model', label: 'B', available: true, roles: ['implement'] },
        ] } },
        usageLimits: limits,
      });
      assert.equal(pick.ok, true);
      assert.equal(pick.model ?? pick.pick?.model, 'other-model');
      // Notification exactly once per episode, even on a third failure.
      await run(dir, snap(), T0 + 8000, { publish });
      assert.equal(published.length, 1, 'one notification per episode');
      // TTL is shorter than model_unavailable, and the model returns after expiry.
      assert.ok(REPEATED_FAST_FAIL_TTL_MS < 24 * 60 * 60 * 1000);
      assert.ok(locked(dir, 'ff-model', T0 + 8000 + REPEATED_FAST_FAIL_TTL_MS - 1000));
      assert.equal(locked(dir, 'ff-model', T0 + 8000 + REPEATED_FAST_FAIL_TTL_MS + 1000), null, 'model returns after TTL');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = fresh();
    try {
      const a = await run(dir, snap({ usageKnown: false, outputTokens: null, explicitProviderRejectionEvidence: true, errorStage: 'before_generation' }));
      assert.equal(a.variant, 'adapter_confirmed_rejection');
      const b = await run(dir, snap(), T0 + 1000);
      assert.equal(b.variant, 'zero_output_tokens', 'both evidence variants are recorded distinctly');
      assert.equal(b.locked, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  // Exclusions: each must never lock, even when repeated.
  const exclusions = {
    'user cancel': { status: 'cancelled', errorSource: 'cancellation' },
    'plan_guard_cancelled': { errorCode: 'plan_guard_cancelled' },
    'final-report cancel': { errorMessage: 'Run cancelled after final report' },
    'tool not found': { errorMessage: 'Tool workspace_watcher_show not found in agent cli.' },
    '401': { errorMessage: 'Request failed with status 401' },
    'cursor_auth_error': { errorCode: 'cursor_auth_error' },
    'qwen_auth': { errorCode: 'qwen_auth' },
    'classified usage limit': { errorMessage: 'You have hit your usage limit. Try again later.' },
    'classified model_unavailable': { errorMessage: 'Model [x] is not available right now.' },
    'local tool error': { errorSource: 'local_tool' },
    'permission error': { errorSource: 'permission' },
    'missing program': { errorMessage: 'spawn qwen ENOENT' },
    'missing model id': { model: '' },
    'durationKnown=false': { durationKnown: false, durationMs: null },
    'unknown origin': { errorSource: '' },
    'long run': { durationMs: 120000 },
    'output seen': { outputSeen: true },
    'usageKnown=false without proof': { usageKnown: false, outputTokens: null },
    'usageKnown=false with outputSeen=false but no stage proof': { usageKnown: false, outputTokens: null, errorStage: 'unknown' },
    'nonzero output tokens': { outputTokens: 12 },
  };
  for (const [name, over] of Object.entries(exclusions)) {
    const dir = fresh();
    try {
      assert.equal(classifyFastProviderFailure(snap(over)).ok, false, `${name}: not a fast failure`);
      await run(dir, snap(over));
      const r = await run(dir, snap(over), T0 + 1000);
      assert.equal(r.locked, false, `${name}: must not lock`);
      assert.equal(locked(dir, over.model === '' ? '' : 'ff-model'), null, `${name}: no lockout row`);
      assert.equal(listHarnessUsageLimits(dir, T0 + 2000).length, 0, `${name}: store empty`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  {
    const dir = fresh();
    try {
      await run(dir, snap({ errorMessage: 'mystery A' }));
      const r = await run(dir, snap({ errorMessage: 'mystery B' }), T0 + 1000);
      assert.equal(r.locked, false, 'two different messages are two signatures');
      // Window: the second failure arrives after the window expired.
      const r2 = await run(dir, snap({ errorMessage: 'mystery A' }), T0 + FAST_FAIL_WINDOW_MS + 1000);
      assert.equal(r2.locked, false, 'outside the window the earlier failure no longer counts');
      // Same run reported twice is one failure.
      const dup = snap({ runId: 'same' });
      await run(dir, dup, T0 + 10 * FAST_FAIL_WINDOW_MS);
      const d = await run(dir, dup, T0 + 10 * FAST_FAIL_WINDOW_MS + 1);
      assert.equal(d.locked, false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}
