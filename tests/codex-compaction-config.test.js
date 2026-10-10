/**
 * Codex opt-in compaction config: default off, maps to the SDK `config`
 * (`--config key=value`) object, and reaches the built client options.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-codex-compaction-'));
const previousDataDir = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = dataDir;
const envKeys = [
  'CRETLI_CODEX_AUTO_COMPACT_TOKEN_LIMIT',
  'CRETLI_CODEX_POST_TURN_COMPACT_THRESHOLD_PERCENT',
];
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

try {
  const {
    CODEX_COMPACTION_ENV,
    buildCodexConfigObject,
    resolveCodexCompactionConfig,
  } = await import('../lib/codex/codex-compaction-config.js');
  const { buildCodexClientOptions } = await import('../lib/codex/codex-thread-options.js');

  // Default: nothing configured, empty config object.
  assert.deepEqual(resolveCodexCompactionConfig({}, {}), {});
  assert.deepEqual(buildCodexConfigObject({}), {});

  // Settings map to Codex config keys.
  const fromSettings = resolveCodexCompactionConfig({
    codexCompaction: { autoCompactTokenLimit: 200_000, postTurnCompactThresholdPercent: 80 },
  }, {});
  assert.deepEqual(buildCodexConfigObject(fromSettings), {
    model_auto_compact_token_limit: 200_000,
    model_post_turn_compact_threshold_percent: 80,
  });

  // Env override wins; invalid/out-of-range values are dropped.
  const fromEnv = resolveCodexCompactionConfig({}, {
    [CODEX_COMPACTION_ENV.autoCompactTokenLimit]: '150000',
    [CODEX_COMPACTION_ENV.postTurnCompactThresholdPercent]: '101',
  });
  assert.deepEqual(fromEnv, { autoCompactTokenLimit: 150_000 });
  assert.deepEqual(resolveCodexCompactionConfig({}, {
    [CODEX_COMPACTION_ENV.autoCompactTokenLimit]: '-1',
  }), {});

  // The built client options carry the config only when configured.
  const defaultOptions = buildCodexClientOptions({ cwd: '/tmp/codex-ws' });
  assert.equal(defaultOptions.config, undefined);

  process.env[CODEX_COMPACTION_ENV.autoCompactTokenLimit] = '250000';
  const configuredOptions = buildCodexClientOptions({ cwd: '/tmp/codex-ws' });
  assert.deepEqual(configuredOptions.config, { model_auto_compact_token_limit: 250_000 });
} finally {
  for (const key of envKeys) {
    if (typeof previousEnv[key] === 'string') process.env[key] = previousEnv[key];
    else delete process.env[key];
  }
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('codex-compaction-config.test.js OK');
