import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { after } from 'node:test';
after(removeIsolatedDataDir);
import {
  REVIEW_VERIFY_IDS,
  isReviewVerifyInFlight,
  runReviewVerify,
} from '../lib/sdk/sdk-review-verify.js';
import { BRIDGE_VERIFY_TIMEOUT_MS, isBridgeVerifyToolName } from '../lib/remote-api-client.js';

const root = path.resolve(import.meta.dirname, '..');
const [idA, idB] = REVIEW_VERIFY_IDS;

test('concurrent identical verify calls share one run and one dataDir', async () => {
  const first = runReviewVerify({ ids: [idA, idB], projectRoot: root });
  assert.equal(isReviewVerifyInFlight({ projectRoot: root }), true);
  const second = runReviewVerify({ ids: [idB, idA], projectRoot: path.join(root, 'tests', '..') });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.ok(fs.existsSync(b.dataDir));
  assert.equal(isReviewVerifyInFlight({ projectRoot: root }), false);
  const third = await runReviewVerify({ ids: [idA, idB], projectRoot: root });
  assert.notEqual(third.dataDir, a.dataDir);
});

test('different ids run separately; an error settles and clears the entry', async () => {
  const [a, b] = await Promise.all([
    runReviewVerify({ ids: [idA], projectRoot: root }),
    runReviewVerify({ ids: [idB], projectRoot: root }),
  ]);
  assert.notEqual(a.dataDir, b.dataDir);
  const bad = await runReviewVerify({ ids: ['no-such-id'], projectRoot: root });
  assert.equal(bad.ok, false);
  assert.equal(isReviewVerifyInFlight({ projectRoot: root }), false);
});

test('explicit catalog bypasses the in-flight map', async () => {
  const [a, b] = await Promise.all([
    runReviewVerify({ ids: ['x'], projectRoot: root, catalog: { x: 'tests/missing-a.test.js' } }),
    runReviewVerify({ ids: ['x'], projectRoot: root, catalog: { x: 'tests/missing-a.test.js' } }),
  ]);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.notEqual(a.dataDir, b.dataDir);
});

test('[] and the explicit full id list share one run; different roots do not', async () => {
  const [a, b] = await Promise.all([
    runReviewVerify({ ids: [], projectRoot: root }),
    runReviewVerify({ ids: [...REVIEW_VERIFY_IDS], projectRoot: root }),
  ]);
  assert.equal(a.dataDir, b.dataDir);
  const other = path.join(root, 'tests');
  const first = runReviewVerify({ ids: [idA], projectRoot: root });
  const second = runReviewVerify({ ids: [idA], projectRoot: other });
  assert.equal(isReviewVerifyInFlight({ projectRoot: other }), true);
  const [c, d] = await Promise.all([first, second]);
  assert.notEqual(c.dataDir, d.dataDir);
});

test('no production caller passes timeoutMs to runReviewVerify', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js') || full.endsWith('sdk-review-verify.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/runReviewVerify\s*\(/g)) {
        // Balanced-paren slice of the full call expression.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < text.length; end += 1) {
          if (text[end] === '(') depth += 1;
          if (text[end] === ')' && (depth -= 1) === 0) break;
        }
        if (/timeoutMs/.test(text.slice(m.index, end + 1))) offenders.push(full);
      }
    }
  };
  walk(path.join(root, 'lib'));
  assert.deepEqual(offenders, []);
});

test('per-call timeout applies to the builtin delegation_verify only', () => {
  assert.ok(BRIDGE_VERIFY_TIMEOUT_MS >= 30000);
  const entry = 'mcp__cretli_builtincretl__delegation_verify';
  assert.equal(isBridgeVerifyToolName(entry), true);
  assert.equal(isBridgeVerifyToolName(entry.slice('mcp__'.length)), true);
  assert.equal(isBridgeVerifyToolName('mcp__cretli_builtincretl__delegation_show'), false);
  assert.equal(isBridgeVerifyToolName('mcp__ext_server__delegation_verify'), false);
  assert.equal(isBridgeVerifyToolName(`mcp__cretli_bridge__${entry}`), false);
});

test('delegation_show reports verify_running for the delegation execution folder', async () => {
  const { DELEGATION_MCP_TOOLS } = await import('../lib/mcp/builtin/delegation-tools.js');
  const show = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_show');
  const row = (executionFolder) => ({
    id: 'dddddddd-1111-2222-3333-444444444444',
    status: 'completed',
    parentChatId: 'chat-1',
    report: 'ok',
    executionFolder,
    executor: { transport: 'opencode', model: 'm' },
  });
  const call = (executionFolder) => show.handler(
    { delegation_id: 'dddddddd-1111-2222-3333-444444444444' },
    {
      client: { getDelegation: async () => row(executionFolder) },
      session: { chatId: 'chat-1', workspaceFolder: '/tmp/other-workspace' },
    },
  );
  const pending = runReviewVerify({ ids: [idA], projectRoot: root });
  const sameFolder = await call(root);
  const otherFolder = await call('/tmp/not-the-verify-root');
  await pending;
  assert.equal(sameFolder.structuredContent.verify_running, true);
  assert.equal(otherFolder.structuredContent.verify_running, false);
  assert.equal(sameFolder.structuredContent.verify_recorded, false);
  assert.match(sameFolder.content[0].text, /verify_recorded=false verify_running=true/);
  const after = await call(root);
  assert.equal(after.structuredContent.verify_running, false);
});

test('delegation_show: verify_recorded follows the attempt result, independent of verify_running', async () => {
  const { DELEGATION_MCP_TOOLS } = await import('../lib/mcp/builtin/delegation-tools.js');
  const show = DELEGATION_MCP_TOOLS.find((tool) => tool.name === 'delegation_show');
  const id = 'eeeeeeee-1111-2222-3333-444444444444';
  const verifyResult = (dataDir) => ({
    status: 'passed', exitCode: 0, verdict: 'PASS', source: 'delegation_verify', dataDir,
    attemptId: 'attempt-1', recordedAt: '2026-10-07T00:00:00.000Z',
  });
  const call = (row) => show.handler(
    { delegation_id: id },
    {
      client: { getDelegation: async () => ({
        id, status: 'completed', parentChatId: 'chat-1', report: 'ok', attemptId: 'attempt-1',
        executionFolder: root, executor: { transport: 'opencode', model: 'm' }, ...row,
      }) },
      session: { chatId: 'chat-1', workspaceFolder: '/tmp/other-workspace' },
    },
  );
  const recorded = await call({ verifyResult: verifyResult('/tmp/shared-data-dir') });
  assert.equal(recorded.structuredContent.verify_recorded, true);
  assert.equal(recorded.structuredContent.verify_running, false);
  assert.match(recorded.content[0].text, /verify_recorded=true verify_running=false/);
  assert.match(recorded.content[0].text, /data_dir=\/tmp\/shared-data-dir/);
  // Attempt reset clears the result.
  const reset = await call({ verifyResult: null });
  assert.equal(reset.structuredContent.verify_recorded, false);
  // Own fresh result while another run in the same folder is still in flight.
  const pending = runReviewVerify({ ids: [idA], projectRoot: root });
  const both = await call({ verifyResult: verifyResult('/tmp/shared-data-dir') });
  await pending;
  assert.equal(both.structuredContent.verify_recorded, true);
  assert.equal(both.structuredContent.verify_running, true);

});

test('importing the client path has no side effects (exits on its own)', async () => {
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.execPath, ['-e', "import('./lib/remote-api-client.js').then(() => process.stdout.write('ok'))"], {
    cwd: root, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'ok');
});


test('a shared run executes each selected runner only once', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-count-'));
  fs.mkdirSync(path.join(fixture, 'tests'));
  const filename = path.join(fixture, 'tests', 'mcp-chat-history-format.test.js');
  fs.writeFileSync(filename, `
    const fs = require('node:fs');
    const path = require('node:path');
    const marker = path.join(process.env.CRETLI_DATA_DIR, 'run-count');
    fs.appendFileSync(marker, 'run\\n');
    setTimeout(() => console.log('finished'), 100);
  `);
  try {
    const [first, second] = await Promise.all([
      runReviewVerify({ ids: [idA], projectRoot: fixture }),
      runReviewVerify({ ids: [idA], projectRoot: fixture }),
    ]);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first, second);
    assert.equal(fs.readFileSync(path.join(second.dataDir, 'run-count'), 'utf8'), 'run\n');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('a rejected execution clears its entry and the next call runs again', async () => {
  const original = fs.mkdtempSync;
  let first;
  let second;
  try {
    fs.mkdtempSync = () => { throw new Error('fixture allocation failure'); };
    first = runReviewVerify({ ids: [idA], projectRoot: root });
    second = runReviewVerify({ ids: [idA], projectRoot: root });
  } finally {
    fs.mkdtempSync = original;
  }
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(isReviewVerifyInFlight({ projectRoot: root }), false);
  assert.equal((await runReviewVerify({ ids: [idA], projectRoot: root })).ok, true);
});
