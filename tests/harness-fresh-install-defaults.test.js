/**
 * Fresh-install harness defaults (v0.6 "Harnessy"): a new install that finishes or
 * skips first-run setup enables the recommended harnesses plus its chosen one; an
 * existing install and an explicit enabledHarnesses choice are never changed.
 */
import './helpers/default-optional-harnesses.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { applySettingsPatch } from '../lib/routes/settings-routes.js';
import {
  RECOMMENDED_HARNESSES,
  freshInstallEnabledHarnesses,
  getHarnessTier,
  listEnabledHarnesses,
} from '../lib/harness-enabled.js';

const patch = (body, settings) => applySettingsPatch({ body }, settings);

test('tiers: recommended set, experimental Antigravity, everything else available', () => {
  assert.deepEqual([...RECOMMENDED_HARNESSES].sort(), ['claude', 'codex', 'deepseek', 'openrouter']);
  assert.equal(getHarnessTier('antigravity'), 'experimental');
  assert.equal(getHarnessTier('qwen'), 'available');
  assert.equal(getHarnessTier('cursor'), 'available', 'the cursor alias resolves to sdk');
});

test('fresh install: completing first-run setup enables the recommended harnesses plus the chosen one', async () => {
  const settings = {};
  await patch({ firstRunSetupDismissed: true, defaultNewChatHarness: 'qwen' }, settings);
  assert.equal(settings.firstRunSetupDismissed, true);
  const enabled = listEnabledHarnesses(settings.enabledHarnesses);
  for (const id of [...RECOMMENDED_HARNESSES, 'qwen']) assert.ok(enabled.includes(id), `${id} enabled`);
  assert.equal(enabled.includes('mistral'), false, 'other harnesses stay one switch away');
});

test('fresh install: skipping first-run setup still applies the recommended set', async () => {
  const settings = {};
  await patch({ firstRunSetupDismissed: true }, settings);
  assert.deepEqual([...settings.enabledHarnesses].sort(), freshInstallEnabledHarnesses().sort());
});

test('existing install: nothing changes when first-run setup was already done', async () => {
  const settings = { firstRunSetupDismissed: true };
  await patch({ firstRunSetupDismissed: true }, settings);
  assert.equal(settings.enabledHarnesses, undefined, 'every harness stays enabled');
});

test('an explicit enabledHarnesses choice is never overwritten', async () => {
  const settings = { enabledHarnesses: ['mistral'] };
  await patch({ firstRunSetupDismissed: true }, settings);
  assert.deepEqual(settings.enabledHarnesses, ['mistral']);
  const sameRequest = {};
  await patch({ enabledHarnesses: ['zai'], firstRunSetupDismissed: true }, sameRequest);
  assert.deepEqual(sameRequest.enabledHarnesses, ['zai'], 'a choice in the same request wins');
});
