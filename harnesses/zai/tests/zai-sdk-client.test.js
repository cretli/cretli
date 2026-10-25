import { removeIsolatedDataDir, ISOLATED_DATA_DIR } from '../../../tests/helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { streamZaiSdkCompletion } from '../zai-sdk-client.js';
import { invalidateZaiSdkAvailability, isZaiSdkAvailable, resolveZaiPythonExecutable } from '../zai-sdk-runtime.js';

const previousCwd = process.cwd();
const previousPython = process.env.ZAI_PYTHON_BIN;
const previousKey = process.env.ZAI_SDK_API_KEY;
const managedPython = join(ISOLATED_DATA_DIR, 'data/zai-sdk-venv/bin/python');
const configuredPython = join(ISOLATED_DATA_DIR, 'custom-python');

/** Simulate an interpreter with the SDK installed without calling an external API. */
function writeInterpreter(executable, marker) {
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, `#!${process.execPath}
if (process.argv[2] === '-c') process.exit(0);
if (process.argv[2] !== '-u' || !process.argv[3].endsWith('zai_sdk_worker.py')) process.exit(1);
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.model !== 'test-model') process.exit(1);
  process.stdout.write(JSON.stringify({ deltaText: ${JSON.stringify(marker)}, finishReason: 'stop' }) + '\\n');
});
`, { mode: 0o755 });
}

try {
  process.chdir(ISOLATED_DATA_DIR);
  process.env.ZAI_SDK_API_KEY = 'fixture-zai-sdk-api-key';
  delete process.env.ZAI_PYTHON_BIN;
  writeInterpreter(managedPython, 'managed');
  writeInterpreter(configuredPython, 'configured');
  for (const [configured, expectedPython, expectedText] of [
    [undefined, managedPython, 'managed'],
    [configuredPython, configuredPython, 'configured'],
  ]) {
    if (configured) process.env.ZAI_PYTHON_BIN = configured;
    else delete process.env.ZAI_PYTHON_BIN;
    invalidateZaiSdkAvailability();
    assert.equal(resolveZaiPythonExecutable(), expectedPython);
    assert.equal(isZaiSdkAvailable(), true);
    const events = [];
    for await (const event of streamZaiSdkCompletion({
      model: 'test-model', messages: [{ role: 'user', content: 'Hello' }], timeoutMs: 5000,
    })) events.push(event);
    assert.equal(events.length, 1);
    assert.equal(events[0].deltaText, expectedText);
    assert.equal(events[0].finishReason, 'stop');
  }
} finally {
  process.chdir(previousCwd);
  if (previousPython === undefined) delete process.env.ZAI_PYTHON_BIN;
  else process.env.ZAI_PYTHON_BIN = previousPython;
  if (previousKey === undefined) delete process.env.ZAI_SDK_API_KEY;
  else process.env.ZAI_SDK_API_KEY = previousKey;
  invalidateZaiSdkAvailability();
  removeIsolatedDataDir();
}

console.log('zai-sdk-client.test.js OK');
