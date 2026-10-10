/**
 * DeepSeek Harness native compaction policy: the generated cordis patch lowers
 * the stock 0.8 threshold, and the value is configurable.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-deepseek-compaction-'));
const previousDataDir = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = dataDir;

try {
  const {
    DEEPSEEK_COMPACTION_DEFAULTS,
    DEEPSEEK_COMPACTION_ENV,
    resolveDeepSeekCompactionConfig,
  } = await import('../lib/deepseek/deepseek-compaction-config.js');
  const { writeDeepSeekRuntimePatch } = await import('../lib/deepseek/dsh-runtime-patch.js');

  // Documented default lowers DSH's stock 0.8 threshold.
  const defaults = resolveDeepSeekCompactionConfig({}, {});
  assert.equal(defaults.thresholdRatio, 0.5);
  assert.equal(defaults.retainRatio, 0.16);
  assert.equal(defaults.thresholdRatio, DEEPSEEK_COMPACTION_DEFAULTS.thresholdRatio);
  assert.ok(defaults.thresholdRatio < 0.8, 'threshold is below the DSH stock 0.8');

  // Settings and env override; env wins.
  const fromSettings = resolveDeepSeekCompactionConfig({
    deepseekCompaction: { thresholdRatio: 0.6, retainRatio: 0.2 },
  }, {});
  assert.equal(fromSettings.thresholdRatio, 0.6);
  assert.equal(fromSettings.retainRatio, 0.2);

  const fromEnv = resolveDeepSeekCompactionConfig(
    { deepseekCompaction: { thresholdRatio: 0.6 } },
    {
      [DEEPSEEK_COMPACTION_ENV.thresholdRatio]: '0.4',
      [DEEPSEEK_COMPACTION_ENV.retainRatio]: '0.1',
    },
  );
  assert.equal(fromEnv.thresholdRatio, 0.4);
  assert.equal(fromEnv.retainRatio, 0.1);

  // Invalid values fall back; retainRatio is clamped below thresholdRatio.
  const invalid = resolveDeepSeekCompactionConfig({
    deepseekCompaction: { thresholdRatio: 2, retainRatio: 0.9 },
  }, {});
  assert.equal(invalid.thresholdRatio, 0.5);
  assert.equal(invalid.retainRatio, 0.16);

  // Generated patch carries the lowered compaction row.
  const patchPath = writeDeepSeekRuntimePatch();
  const patch = fs.readFileSync(patchPath, 'utf8');
  assert.match(patch, /- id: compaction-basic/);
  assert.match(patch, /thresholdRatio: 0\.5/);
  assert.match(patch, /retainRatio: 0\.16/);
  assert.match(patch, /- id: llm-deepseek/);
  assert.match(patch, /cretli-dsh-runtime/);

  const customPatchPath = writeDeepSeekRuntimePatch({ compaction: { thresholdRatio: 0.25, retainRatio: 0.1 } });
  const customPatch = fs.readFileSync(customPatchPath, 'utf8');
  assert.match(customPatch, /thresholdRatio: 0\.25/);
  assert.match(customPatch, /retainRatio: 0\.1/);
} finally {
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('deepseek-compaction-config.test.js OK');
