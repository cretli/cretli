import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  DEEPSEEK_INITIALIZE_TIMEOUT_MS,
  DEEPSEEK_MAX_TOKENS,
  DEEPSEEK_PROFILE,
  DEEPSEEK_RUNTIME_PATCH_PATH,
  DEEPSEEK_RUNTIME_PLUGIN_PATH,
  buildDeepSeekHarnessOptions,
} from '../lib/deepseek/deepseek-harness-options.js';
import { isDeepSeekSdkAvailable, loadDeepSeekSdk } from '../lib/deepseek/deepseek-sdk.js';

const previousHome = process.env.CRETLI_DATA_DIR;
process.env.CRETLI_DATA_DIR = '/tmp/cretli-deepseek-harness-options-test';

try {
  const inputCwd = '/tmp/deepseek-workspace';
  const inputBin = '/opt/custom/dsh/lib/bin.js';
  const actualOptions = buildDeepSeekHarnessOptions({
    cwd: inputCwd,
    model: 'deepseek-v4-pro',
    dshBin: inputBin,
  });
  assert.equal(actualOptions.profile, DEEPSEEK_PROFILE);
  assert.equal(actualOptions.cwd, inputCwd);
  assert.equal(actualOptions.provider, 'deepseek-official');
  assert.equal(actualOptions.model, 'deepseek-v4-pro');
  assert.equal(actualOptions.maxTokens, DEEPSEEK_MAX_TOKENS);
  assert.equal(actualOptions.initializeTimeoutMs, DEEPSEEK_INITIALIZE_TIMEOUT_MS);
  assert.equal(actualOptions.dshBin, inputBin);
  assert.equal(actualOptions.launch, undefined);
  assert.equal(typeof actualOptions.dshHome, 'string');
  assert.ok(String(actualOptions.dshHome).includes('dsh-home'));
  assert.equal(typeof actualOptions.env, 'object');
  assert.deepEqual(actualOptions.patches, [DEEPSEEK_RUNTIME_PATCH_PATH]);
  assert.equal(
    actualOptions.env.CRETLI_DSH_RUNTIME_PLUGIN,
    pathToFileURL(DEEPSEEK_RUNTIME_PLUGIN_PATH).href,
  );

  const sdkAvailable = await isDeepSeekSdkAvailable();
  if (sdkAvailable) {
    const sdk = await loadDeepSeekSdk();
    const harness = new sdk.DeepSeekHarness(actualOptions);
    assert.ok(harness);
    assert.equal(typeof harness.run, 'function');
    assert.equal(typeof harness.close, 'function');
    await harness.close();
  }
} finally {
  if (typeof previousHome === 'string') process.env.CRETLI_DATA_DIR = previousHome;
  else delete process.env.CRETLI_DATA_DIR;
}

console.log('deepseek-harness-options.test.js OK');
