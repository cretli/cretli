/**
 * Qwen native context/compaction settings.json generation.
 *
 * Cretli owns the isolated Qwen HOME, so the harness's own settings.json is
 * written with clearContextOnIdle + autoCompactThreshold + cache control.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-qwen-context-'));
const previousDataDir = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = dataDir;

try {
  const {
    DEFAULT_QWEN_AUTO_COMPACT_THRESHOLD,
    DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE,
    DEFAULT_QWEN_ENABLE_CACHE_CONTROL,
    QWEN_CONTEXT_SETTINGS_ENV,
    resolveQwenContextSettings,
    resolveQwenSettingsPath,
    writeQwenSettingsFile,
  } = await import('../lib/qwen/qwen-context-settings.js');

  // Documented defaults.
  const resolvedDefaults = resolveQwenContextSettings({}, {});
  assert.equal(resolvedDefaults.autoCompactThreshold, 0.85);
  assert.deepEqual(resolvedDefaults.clearContextOnIdle, {
    toolResultsThresholdMinutes: 60,
    toolResultsNumToKeep: 5,
    toolResultsTotalCharsThreshold: 500_000,
  });
  assert.equal(resolvedDefaults.enableCacheControl, true);
  assert.equal(resolvedDefaults.autoCompactThreshold, DEFAULT_QWEN_AUTO_COMPACT_THRESHOLD);
  assert.equal(resolvedDefaults.enableCacheControl, DEFAULT_QWEN_ENABLE_CACHE_CONTROL);
  assert.deepEqual(resolvedDefaults.clearContextOnIdle, DEFAULT_QWEN_CLEAR_CONTEXT_ON_IDLE);

  // Written file carries the keys and falls back to the documented defaults.
  const written = writeQwenSettingsFile({ settings: {}, env: {} });
  const expectedPath = resolveQwenSettingsPath();
  assert.equal(written.path, expectedPath);
  assert.ok(expectedPath.endsWith(path.join('qwen-home', '.qwen', 'settings.json')));
  const onDisk = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  assert.deepEqual(onDisk.context.clearContextOnIdle, {
    toolResultsThresholdMinutes: 60,
    toolResultsNumToKeep: 5,
    toolResultsTotalCharsThreshold: 500_000,
  });
  assert.equal(onDisk.context.autoCompactThreshold, 0.85);
  assert.equal(onDisk.model.generationConfig.enableCacheControl, true);

  // Settings override wins over defaults.
  const fromSettings = writeQwenSettingsFile({
    settings: {
      qwenContextSettings: {
        autoCompactThreshold: 0.7,
        clearContextOnIdle: { toolResultsThresholdMinutes: 30, toolResultsNumToKeep: 3 },
        enableCacheControl: false,
      },
    },
    env: {},
  });
  assert.equal(fromSettings.resolved.autoCompactThreshold, 0.7);
  assert.equal(fromSettings.resolved.clearContextOnIdle.toolResultsThresholdMinutes, 30);
  assert.equal(fromSettings.resolved.clearContextOnIdle.toolResultsNumToKeep, 3);
  assert.equal(fromSettings.resolved.enableCacheControl, false);
  assert.equal(fromSettings.document.context.autoCompactThreshold, 0.7);
  assert.equal(fromSettings.document.model.generationConfig.enableCacheControl, false);

  // Env JSON override wins over settings, and unrelated keys survive.
  fs.writeFileSync(expectedPath, JSON.stringify({
    ...JSON.parse(fs.readFileSync(expectedPath, 'utf8')),
    customKey: { keep: true },
  }, null, 2));
  process.env[QWEN_CONTEXT_SETTINGS_ENV] = JSON.stringify({
    autoCompactThreshold: 0.5,
    clearContextOnIdle: { toolResultsTotalCharsThreshold: 250_000 },
  });
  const fromEnv = writeQwenSettingsFile({ settings: { qwenContextSettings: { autoCompactThreshold: 0.9 } } });
  assert.equal(fromEnv.resolved.autoCompactThreshold, 0.5);
  assert.equal(fromEnv.resolved.clearContextOnIdle.toolResultsTotalCharsThreshold, 250_000);
  assert.deepEqual(fromEnv.document.customKey, { keep: true });
  delete process.env[QWEN_CONTEXT_SETTINGS_ENV];

  // Invalid values fall back instead of throwing.
  const invalid = resolveQwenContextSettings({
    qwenContextSettings: {
      autoCompactThreshold: 5,
      clearContextOnIdle: { toolResultsNumToKeep: 0, toolResultsTotalCharsThreshold: 'nope' },
    },
  }, {});
  assert.equal(invalid.autoCompactThreshold, 0.85);
  assert.equal(invalid.clearContextOnIdle.toolResultsNumToKeep, 5);
  assert.equal(invalid.clearContextOnIdle.toolResultsTotalCharsThreshold, 500_000);
} finally {
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('qwen-context-settings.test.js OK');
