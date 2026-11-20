import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { createDelegationRecord, loadDelegations } from '../lib/persist/delegations-persist.js';

const inputCount = 200;
const started = performance.now();
for (let i = 0; i < inputCount; i += 1) {
  createDelegationRecord({
    parentChatId: `parent-${i}`,
    childChatId: `child-${i}`,
    sourceKind: 'text',
    sourceText: 'bench',
  });
}
const afterWrites = performance.now();
const actualRows = loadDelegations();
const afterRead = performance.now();
assert.equal(actualRows.length >= inputCount, true);
const writeMs = afterWrites - started;
const readMs = afterRead - afterWrites;
assert.equal(writeMs < 20000, true);
assert.equal(readMs < 2000, true);

const persistUrl = new URL('../lib/persist/delegations-persist.js', import.meta.url).href;
const childScript = `
const prefix = process.env.WRITER_PREFIX;
try {
  const { createDelegationRecord } = await import(${JSON.stringify(persistUrl)});
  createDelegationRecord({
    parentChatId: prefix,
    childChatId: prefix + '-c',
    sourceKind: 'text',
    sourceText: 'multi',
  });
  console.log('ACQUIRED');
  process.exit(0);
} catch (err) {
  console.error(err.code || err.message);
  process.exit(2);
}
`;
function spawnWriter(prefix) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WRITER_PREFIX: prefix,
        CRETLI_TEST_DATA_DIR: ISOLATED_DATA_DIR,
        CURSOR_REMOTE_TEST_DATA_DIR: ISOLATED_DATA_DIR,
        CRETLI_DATA_DIR: ISOLATED_DATA_DIR,
        CURSOR_REMOTE_DATA_DIR: ISOLATED_DATA_DIR,
      },
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}
const overlapStarted = performance.now();
const writers = await Promise.all([spawnWriter('pA'), spawnWriter('pB')]);
const overlapMs = performance.now() - overlapStarted;
const afterMulti = loadDelegations();
const refused = writers.filter((row) => row.code !== 0 && /DELEGATION_OWNER_LOCKED/.test(`${row.stdout}${row.stderr}`));
assert.equal(refused.length, 2);
assert.equal(afterMulti.length, actualRows.length);
console.log(JSON.stringify({
  store: 'json',
  items: actualRows.length,
  writeMs: Math.round(writeMs),
  readMs: Math.round(readMs),
  multiProcess: {
    attempted: 2,
    refused: refused.length,
    overlapMs: Math.round(overlapMs),
    limitation: 'JSON is single-writer; a second process is refused by the owner lock',
  },
  decision: 'json-default-with-owner-lock; sqlite optional',
}));
console.log('delegation-persist-bench.test.js OK');
