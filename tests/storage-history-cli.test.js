import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistantRec, makeTempDir, userRec } from './fixtures/storage-history-synthetic.js';
import { createStorageWorkerHost } from '../lib/storage/worker-host.js';
import { createChatHistoryStore } from '../lib/storage/chat-history-store.js';
import { WRITE_GATE_TEST_EXEMPTION } from '../lib/storage/maintenance-coordinator.js';
import { readSdkHistoryStreamText } from '../lib/sdk/sdk-history-stream-coalesce.ts';

const CLI = fileURLToPath(new URL('../scripts/storage-history-migrate.mjs', import.meta.url));
const HANDLERS = fileURLToPath(new URL('../lib/storage/chat-history-store.js', import.meta.url));
const CHAT = 'cccccccc-1111-4000-8000-000000000001';
let work;
let legacyDir;

before(() => {
  work = makeTempDir('cretli-hist-cli-');
  legacyDir = path.join(work, 'legacy');
  fs.mkdirSync(legacyDir);
  const doc = {
    v: 1, chatId: CHAT, cursorSessionId: 'sess', headSeq: 3, updatedAt: '2026-10-05T00:00:00.000Z',
    events: [{ seq: 1, rec: { ...userRec('q'), clientSeq: 1 } }, { seq: 2, rec: assistantRec('answer so far ') }, { seq: 3, rec: assistantRec('and more') }],
  };
  fs.writeFileSync(path.join(legacyDir, `${CHAT}.json`), JSON.stringify(doc, null, 2));
});

after(() => fs.rmSync(work, { recursive: true, force: true }));

/** @param {string[]} args */
function cli(args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('storage-history-migrate CLI', () => {
  it('plans by default, applies only with an explicit confirmation, verifies and exports a rollback', () => {
    const planRun = cli(['import', '--legacy-dir', legacyDir, '--dataset-generation', 'generation-cli-1', '--min-quiet-ms', '0']);
    assert.equal(planRun.status, 0, planRun.stderr);
    const plan = JSON.parse(planRun.stdout);
    assert.equal(plan.mode, 'plan');
    assert.equal(fs.existsSync(path.join(work, 'staging')), false, 'plan writes nothing');

    const unconfirmed = cli(['import', '--legacy-dir', legacyDir, '--dataset-generation', 'generation-cli-1', '--staging-out', path.join(work, 'staging'), '--apply', '--min-quiet-ms', '0']);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /cli_usage/);

    const applied = cli(['import', '--legacy-dir', legacyDir, '--dataset-generation', 'generation-cli-1', '--staging-out', path.join(work, 'staging'), '--apply', '--confirm-plan', plan.planHash, '--min-quiet-ms', '0']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).validation.logicalCompare, 'ok');
    assert.equal(cli(['verify-import', '--staging-dir', path.join(work, 'staging'), '--legacy-dir', legacyDir]).status, 0);
    assert.doesNotMatch(applied.stdout + planRun.stdout, /answer so far/, 'reports carry no conversation text');

    const storeCopy = path.join(work, 'store');
    fs.mkdirSync(storeCopy);
    fs.copyFileSync(path.join(work, 'staging', 'cretli-store.sqlite'), path.join(storeCopy, 'cretli-store.sqlite'));
    const rollbackPlan = JSON.parse(cli(['rollback', '--store-dir', storeCopy]).stdout);
    assert.equal(rollbackPlan.mode, 'plan');
    const rolled = cli(['rollback', '--store-dir', storeCopy, '--legacy-out', path.join(work, 'rolled'), '--apply', '--confirm-plan', rollbackPlan.planHash]);
    assert.equal(rolled.status, 0, rolled.stderr);
    assert.equal(cli(['verify-rollback', '--export-dir', path.join(work, 'rolled'), '--store-dir', storeCopy]).status, 0);
    assert.equal(
      fs.readFileSync(path.join(work, 'rolled', 'legacy-chat-history', `${CHAT}.json`), 'utf8'),
      fs.readFileSync(path.join(legacyDir, `${CHAT}.json`), 'utf8'));
  });

  it('exits 2 on a refused plan, 1 on usage errors and 64 without a command', () => {
    const bad = path.join(work, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, `${CHAT}.json`), '{');
    const run = cli(['import', '--legacy-dir', bad, '--dataset-generation', 'generation-cli-1', '--min-quiet-ms', '0']);
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).refusals[0].code, 'legacy_invalid_json');
    assert.equal(cli(['frobnicate']).status, 1);
    assert.equal(cli([]).status, 64);
  });

  it('documents the producer boundary: the first delta of a new producer never merges into an imported stream tail', async () => {
    const dir = path.join(work, 'boundary');
    fs.mkdirSync(dir);
    const dbDir = path.join(dir, 'db');
    fs.mkdirSync(dbDir);
    fs.copyFileSync(path.join(work, 'staging', 'cretli-store.sqlite'), path.join(dbDir, 'cretli-store.sqlite'));
    const host = createStorageWorkerHost({ dbDir, handlersPath: HANDLERS, writeGate: WRITE_GATE_TEST_EXEMPTION });
    await host.start();
    try {
      const store = createChatHistoryStore({ host });
      const identity = { datasetGeneration: 'generation-cli-1', chatId: CHAT, chatEpoch: 'legacy-import' };
      const { result } = await store.appendEvents({ ...identity, producerId: 'run:1:attempt:1', commandId: 'c1', events: [{ clientSeq: 1, rec: assistantRec(' continued', 'delta') }] });
      assert.equal(result.accepted[0].seq, 4, 'new event after the imported tail (legacy would have merged into seq 3)');
      const page = await store.readLatest({ ...identity, limit: 10 });
      assert.equal(readSdkHistoryStreamText(page.events.at(-2).rec), 'and more', 'imported tail untouched');
      assert.equal(page.events.length, 4);
    } finally {
      await host.close({ timeoutMs: 2000 });
    }
  });
});
