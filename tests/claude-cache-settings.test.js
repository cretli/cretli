/**
 * Claude opt-in cache/compaction env mapping.
 *
 * Settings options map to the (unverified) Claude Code env vars; defaults stay
 * off so an existing setup is unchanged.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-claude-cache-'));
const previousDataDir = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = dataDir;
const cacheEnvKeys = ['ENABLE_PROMPT_CACHING_1H', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'DISABLE_AUTO_COMPACT'];
const previousEnv = Object.fromEntries(cacheEnvKeys.map((key) => [key, process.env[key]]));
for (const key of cacheEnvKeys) delete process.env[key];

const configPath = path.join(dataDir, 'config.json');

try {
  const {
    CLAUDE_CACHE_ENV,
    applyClaudeCacheEnv,
    buildClaudeCacheEnvOverlay,
    normalizeClaudeAutocompactPct,
    resolveClaudeCacheSettings,
  } = await import('../lib/claude/claude-cache-settings.js');
  const { buildClaudeProcessEnv } = await import('../lib/claude/claude-api-key.js');

  // Defaults stay off and leave the process env untouched.
  assert.deepEqual(resolveClaudeCacheSettings({}), {
    promptCaching1h: false,
    autocompactPctOverride: null,
    disableAutoCompact: false,
  });
  assert.deepEqual(buildClaudeCacheEnvOverlay({}), {});
  const passthrough = { ENABLE_PROMPT_CACHING_1H: 'operator-value' };
  applyClaudeCacheEnv(passthrough, {});
  assert.equal(passthrough.ENABLE_PROMPT_CACHING_1H, 'operator-value');

  // Settings map to the exact env vars.
  const overlay = buildClaudeCacheEnvOverlay({
    claudePromptCaching1h: true,
    claudeAutocompactPctOverride: 75,
    claudeDisableAutoCompact: true,
  });
  assert.deepEqual(overlay, {
    [CLAUDE_CACHE_ENV.promptCaching1h]: '1',
    [CLAUDE_CACHE_ENV.autocompactPctOverride]: '75',
    [CLAUDE_CACHE_ENV.disableAutoCompact]: '1',
  });

  // Percentage normalization rejects out-of-range/non-numeric input.
  assert.equal(normalizeClaudeAutocompactPct(75), 75);
  assert.equal(normalizeClaudeAutocompactPct('50'), 50);
  assert.equal(normalizeClaudeAutocompactPct(0), null);
  assert.equal(normalizeClaudeAutocompactPct(101), null);
  assert.equal(normalizeClaudeAutocompactPct('abc'), null);
  assert.equal(normalizeClaudeAutocompactPct(''), null);

  // The settings reach the built Claude subprocess env.
  fs.writeFileSync(configPath, JSON.stringify({
    claudeAuthMode: 'api-key',
    claudeApiKey: 'sk-ant-test',
    claudePromptCaching1h: true,
    claudeAutocompactPctOverride: 80,
    claudeDisableAutoCompact: true,
  }, null, 2));
  const env = buildClaudeProcessEnv();
  assert.equal(env.ENABLE_PROMPT_CACHING_1H, '1');
  assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80');
  assert.equal(env.DISABLE_AUTO_COMPACT, '1');

  // With the options off, the env stays clean.
  fs.writeFileSync(configPath, JSON.stringify({ claudeAuthMode: 'api-key', claudeApiKey: 'sk-ant-test' }, null, 2));
  const cleanEnv = buildClaudeProcessEnv();
  assert.equal(cleanEnv.ENABLE_PROMPT_CACHING_1H, undefined);
  assert.equal(cleanEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.equal(cleanEnv.DISABLE_AUTO_COMPACT, undefined);
} finally {
  for (const key of cacheEnvKeys) {
    if (typeof previousEnv[key] === 'string') process.env[key] = previousEnv[key];
    else delete process.env[key];
  }
  if (typeof previousDataDir === 'string') process.env.CRETLI_DATA_DIR = previousDataDir;
  else delete process.env.CRETLI_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log('claude-cache-settings.test.js OK');
