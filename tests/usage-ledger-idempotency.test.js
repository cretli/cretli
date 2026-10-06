/**
 * Stage 3 (`2d05fded`): idempotent ledger, crash recovery, retention and
 * late-usage correction.
 *
 * Every test uses a throwaway data dir so the suite never touches real usage.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  applyUsageCorrections,
  commitRunStart,
  commitUsageEvent,
  deriveRunKey,
  pruneUsageRetention,
  resolveUsageDataDir,
  readUsageEvents,
  readUsageLedgerState,
  readUsageRun,
  repairUsageLedger,
  resetUsageLedgerCache,
  usageDayPath,
} from '../lib/persist/usage-persist.js';
import { createUsageEvent } from '../lib/usage/usage-event.js';
import { loadUsageSummary, summarizeUsage } from '../lib/usage/usage-ledger.js';
import { priceUsage } from '../lib/usage/usage-rates.js';
import { USAGE_NORMALIZATION_VERSION } from '../lib/usage/usage-contract.js';
import { beginHarnessRun, recordHarnessRunFinished } from '../lib/usage/harness-usage.js';
import { createAgentRoomKernel } from '../lib/agent-harness/room-kernel.js';

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'cretli-usage-ledger-'));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => canonicalJson(row)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * @param {object} core
 * @returns {string}
 */
function recordChecksum(core) {
  return createHash('sha1').update(canonicalJson(core)).digest('hex').slice(0, 16);
}

/**
 * @param {string} dataDir
 * @param {object} core
 */
function appendJournalEnvelope(dataDir, core) {
  const envelope = { v: 1, ...core };
  const line = `${JSON.stringify({ ...envelope, crc: recordChecksum(envelope) })}\n`;
  const file = usageDayPath(dataDir, core.at);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${existsSync(file) ? readFileSync(file, 'utf8') : ''}${line}`, 'utf8');
}

/**
 * @param {object} partial
 * @returns {object}
 */
function event(partial) {
  return createUsageEvent(partial);
}

const DAY = '2026-10-01';

test('duplicate logical identity after a cache reset never changes sums', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude',
    provider: 'other',
    runId: 'run-dup',
    sourceSessionId: 'sess-dup',
    requestId: 'req-1',
    tokens: { textInput: 100, textOutput: 10 },
    at: `${DAY}T10:00:00.000Z`,
  });
  assert.equal(durable.identityClass, 'durable_sequence');
  assert.equal(commitUsageEvent(durable, { dataDir }).status, 'committed');

  // Simulate a restart/reconnect: the in-memory read-model is gone.
  resetUsageLedgerCache(dataDir);
  const replay = commitUsageEvent(durable, { dataDir });
  assert.equal(replay.status, 'duplicate');

  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 1);
  assert.equal(summarizeUsage(events).tokens.textInput, 100);
  assert.equal(readUsageLedgerState({ dataDir }).diagnostics.duplicates, 1);
});

test('two independent events without reproducible identity are both counted', () => {
  const dataDir = tempDir();
  const first = event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-none',
    tokens: { textInput: 10 },
    at: `${DAY}T10:00:00.000Z`,
  });
  const second = event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-none',
    tokens: { textInput: 10 },
    at: `${DAY}T10:00:01.000Z`,
  });
  assert.equal(first.identityClass, 'none');
  assert.equal(first.logicalEventKey, null);
  assert.equal(commitUsageEvent(first, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(second, { dataDir }).status, 'committed');
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 2, 'identityClass=none must never be deduped by numbers');
  assert.equal(summarizeUsage(events).tokens.textInput, 20);
  // The ambiguity risk is exposed as a diagnostic, not silently deduped.
  assert.ok(readUsageLedgerState({ dataDir }).diagnostics.noneIdentity >= 2);
});

test('runId is durable from run-start; run-ended happens exactly once', () => {
  const dataDir = tempDir();
  const started = commitRunStart(
    { harness: 'claude', runId: 'run-once', sourceSessionId: 'sess-once', at: `${DAY}T10:00:00.000Z` },
    { dataDir }
  );
  assert.equal(started.status, 'started');

  const runKey = deriveRunKey({ harness: 'claude', runId: 'run-once', sourceSessionId: 'sess-once' });
  assert.equal(readUsageRun(runKey, { dataDir }).status, 'active');

  const finish = event({
    harness: 'claude',
    provider: 'other',
    eventType: 'run',
    outcome: 'ok',
    runId: 'run-once',
    sourceSessionId: 'sess-once',
    at: `${DAY}T10:05:00.000Z`,
  });
  assert.equal(commitUsageEvent(finish, { dataDir }).status, 'committed');
  // A second finish for the same durable run is rejected, not counted twice.
  assert.equal(commitUsageEvent(finish, { dataDir }).status, 'duplicate');
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.runCount, 1);
  assert.equal(state.endedRuns, 1);
  assert.equal(state.activeRuns, 0);
});

test('beginHarnessRun mints and persists a durable runId before measurements', () => {
  const dataDir = tempDir();
  const room = { chatId: 'chat-x', modelId: 'composer-2.5', transport: 'sdk' };
  beginHarnessRun(room, { sessionId: 'sess-x' }, { persistRunStart: true, harness: 'sdk', dataDir });
  assert.ok(room._runId, 'a runId is assigned even without a transport runId');
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.activeRuns, 1, 'run-start is persisted before any measurement');
  assert.equal(state.runs[0].runId, room._runId);
});

test('run-ended never adds tokens even when a run payload carries a bag', () => {
  const dataDir = tempDir();
  const finish = event({
    harness: 'codex',
    provider: 'other',
    eventType: 'run',
    outcome: 'ok',
    runId: 'run-tokens',
    tokens: { textInput: 9999, textOutput: 9999 },
    at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(finish, { dataDir });
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(summarizeUsage(events).tokens.textInput, 0);
  assert.equal(summarizeUsage(events).runs, 1);
});

test('crash after journal append before index write is recovered from the journal', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'deepseek',
    provider: 'other',
    runId: 'run-crash',
    sourceSessionId: 'sess-crash',
    messageId: 'msg-crash',
    tokens: { textInput: 7 },
    at: `${DAY}T10:00:00.000Z`,
  });
  const first = commitUsageEvent(durable, { dataDir, persistIndex: false });
  assert.equal(first.status, 'committed');
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 1);

  // The process died before persisting the index; a fresh cache must rebuild
  // the key from the committed journal instead of appending a duplicate.
  resetUsageLedgerCache(dataDir);
  const recovered = readUsageLedgerState({ dataDir });
  assert.equal(recovered.keyCount, 1);
  assert.equal(commitUsageEvent(durable, { dataDir }).status, 'duplicate');
});

test('the next commit after a torn journal tail appends a valid record', () => {
  const dataDir = tempDir();
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 5 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  const file = usageDayPath(dataDir, DAY);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"seq":999,"kind":"usage","at":"${DAY}T10:01:00.000Z","event":{`, 'utf8');
  resetUsageLedgerCache(dataDir);
  const afterTorn = commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 7 }, at: `${DAY}T10:02:00.000Z` }),
    { dataDir }
  );
  assert.equal(afterTorn.status, 'committed');
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 2);
  assert.equal(events[1].tokens.textInput, 7);
});

test('an incomplete last journal line is corrupt, not committed', () => {
  const dataDir = tempDir();
  commitRunStart({ harness: 'codex', runId: 'run-corrupt', at: `${DAY}T09:59:00.000Z` }, { dataDir });
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 5 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  const file = usageDayPath(dataDir, DAY);
  // Torn write: half an envelope, no terminating newline.
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"seq":999,"kind":"usage","at":"${DAY}T10:01:00.000Z","event":{`, 'utf8');

  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 1);
  const state = readUsageLedgerState({ dataDir });
  assert.ok(state.diagnostics.corrupt >= 1);
  // Scope could not be fully rebuilt -> the active run is explicitly partial.
  assert.equal(state.runs.find((run) => run.runId === 'run-corrupt').partial, true);
});

test('a tampered committed line fails its checksum and is ignored', () => {
  const dataDir = tempDir();
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 5 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  const file = usageDayPath(dataDir, DAY);
  const raw = readFileSync(file, 'utf8');
  const tampered = raw.replace('"textInput":5', '"textInput":5000');
  writeFileSync(file, tampered, 'utf8');

  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 0);
  assert.ok(readUsageLedgerState({ dataDir }).diagnostics.corrupt >= 1);
});

test('concurrent writers commit one logical key exactly once', async () => {
  const dataDir = tempDir();
  const moduleUrl = pathToFileURL(path.resolve('lib/persist/usage-persist.js')).href;
  const eventUrl = pathToFileURL(path.resolve('lib/usage/usage-event.js')).href;
  const worker = `
    import { commitUsageEvent } from ${JSON.stringify(moduleUrl)};
    import { createUsageEvent } from ${JSON.stringify(eventUrl)};
    const event = createUsageEvent({
      harness: 'claude', provider: 'other', runId: 'run-conc', sourceSessionId: 'sess-conc',
      requestId: 'req-conc', tokens: { textInput: 10 }, at: '${DAY}T10:00:00.000Z',
    });
    const result = commitUsageEvent(event, { dataDir: process.env.LEDGER_TEST_DIR });
    process.stdout.write(result.status);
  `;
  const statuses = await Promise.all(
    Array.from({ length: 5 }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, LEDGER_TEST_DIR: dataDir },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
        });
        child.on('close', () => resolve(out));
      })
    )
  );
  assert.equal(statuses.filter((status) => status === 'committed').length, 1);
  assert.equal(statuses.filter((status) => status === 'duplicate').length, 4);
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 1);
});

test('durable snapshot baseline survives restart and rejects out-of-order snapshots', () => {
  const dataDir = tempDir();
  const baselineKey = JSON.stringify(['baseline', 'sdk', 'run-snap', '', 'sess-snap', '', '']);
  const snap = (input, text, at) => event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-snap',
    sourceSessionId: 'sess-snap',
    tokens: { textInput: input },
    at,
  });
  const hints = (input) => ({ baselineKey, snapshotTokens: { textInput: input } });

  assert.equal(
    commitUsageEvent(snap(100, '', `${DAY}T10:00:00.000Z`), { dataDir }, hints(100)).status,
    'committed'
  );
  // Restart: the committed baseline is reloaded, so the next cumulative
  // snapshot is diffed instead of being counted from scratch.
  resetUsageLedgerCache(dataDir);
  const second = commitUsageEvent(snap(140, '', `${DAY}T10:01:00.000Z`), { dataDir }, hints(140));
  assert.equal(second.status, 'committed');
  assert.equal(second.event.tokens.textInput, 40);

  // An out-of-order older snapshot must not roll the baseline back.
  const stale = commitUsageEvent(snap(90, '', `${DAY}T10:02:00.000Z`), { dataDir }, hints(90));
  assert.equal(stale.status, 'empty');

  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.deepEqual(events.map((row) => row.tokens.textInput), [100, 40]);
});

test('a new run (new runId) resets the snapshot baseline', () => {
  const dataDir = tempDir();
  const key = (runId) => JSON.stringify(['baseline', 'sdk', runId, '', 'sess-reset', '', '']);
  const one = event({
    harness: 'sdk', provider: 'cursor', runId: 'run-a', sourceSessionId: 'sess-reset',
    tokens: { textInput: 1000 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(one, { dataDir }, { baselineKey: key('run-a'), snapshotTokens: { textInput: 1000 } });
  const two = event({
    harness: 'sdk', provider: 'cursor', runId: 'run-b', sourceSessionId: 'sess-reset',
    tokens: { textInput: 800 }, at: `${DAY}T10:05:00.000Z`,
  });
  const result = commitUsageEvent(two, { dataDir }, { baselineKey: key('run-b'), snapshotTokens: { textInput: 800 } });
  assert.equal(result.status, 'committed');
  assert.equal(result.event.tokens.textInput, 800, 'a new run does not subtract the old run');
});

test('late usage inside the 24 h window corrects coverage without adding a run', () => {
  const dataDir = tempDir();
  const runKey = deriveRunKey({ harness: 'sdk', runId: 'run-late' });
  commitRunStart({ harness: 'sdk', runId: 'run-late', runKey, at: `${DAY}T10:00:00.000Z` }, { dataDir });
  commitUsageEvent(
    event({
      harness: 'sdk',
      provider: 'cursor',
      eventType: 'run',
      outcome: 'ok',
      runId: 'run-late',
      at: `${DAY}T10:05:00.000Z`,
      coverage: { proof: false, expectedRequests: 1, coveredRequests: 1, scope: 'own' },
    }),
    { dataDir }
  );
  const before = readUsageLedgerState({ dataDir });
  assert.equal(before.endedRuns, 1);

  const late = event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-late',
    tokens: { textInput: 50 },
    at: `${DAY}T11:00:00.000Z`,
  });
  const result = commitUsageEvent(
    late,
    { dataDir, now: Date.parse(`${DAY}T12:00:00.000Z`) },
    { final: true }
  );
  assert.equal(result.status, 'committed');
  const after = readUsageLedgerState({ dataDir });
  assert.equal(after.endedRuns, 1, 'a late measurement never adds a run');
  assert.equal(after.activeRuns, 0);
  assert.equal(after.runs[0].coverage.proof, true);
  assert.equal(after.runs[0].coverage.completeness, 'complete');
  assert.ok(after.runs[0].correctedAt, 'the correction is recorded with its timestamp');
  // The late tokens are still real usage.
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 2);
});

test('late usage after the 24 h horizon is stale and never counted again', () => {
  const dataDir = tempDir();
  const runKey = deriveRunKey({ harness: 'sdk', runId: 'run-stale' });
  commitRunStart({ harness: 'sdk', runId: 'run-stale', runKey, at: `${DAY}T10:00:00.000Z` }, { dataDir });
  commitUsageEvent(
    event({ harness: 'sdk', provider: 'cursor', eventType: 'run', outcome: 'ok', runId: 'run-stale', at: `${DAY}T10:05:00.000Z` }),
    { dataDir }
  );
  const stale = event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-stale',
    tokens: { textInput: 999 },
    at: '2026-10-03T10:00:00.000Z',
  });
  const result = commitUsageEvent(
    stale,
    { dataDir, now: Date.parse('2026-10-03T12:00:00.000Z') }
  );
  assert.equal(result.status, 'committed');
  assert.equal(result.stale, true);
  const events = readUsageEvents({ from: DAY, to: '2026-10-03', dataDir });
  assert.equal(events.length, 1, 'stale usage is kept out of the normal aggregates');
  assert.equal(readUsageLedgerState({ dataDir }).diagnostics.stale, 1);
  assert.equal(readUsageLedgerState({ dataDir }).endedRuns, 1);
});

test('retention keeps active runs and prunes only closed ones', () => {
  const dataDir = tempDir();
  const activeKey = deriveRunKey({ harness: 'sdk', runId: 'run-active' });
  const endedKey = deriveRunKey({ harness: 'sdk', runId: 'run-ended' });
  commitRunStart({ harness: 'sdk', runId: 'run-active', runKey: activeKey, at: '2026-01-01T00:00:00.000Z' }, { dataDir });
  commitRunStart({ harness: 'sdk', runId: 'run-ended', runKey: endedKey, at: '2026-01-01T00:00:00.000Z' }, { dataDir });
  commitUsageEvent(
    event({ harness: 'sdk', provider: 'cursor', eventType: 'run', outcome: 'ok', runId: 'run-ended', at: '2026-01-01T01:00:00.000Z' }),
    { dataDir }
  );
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  const dry = pruneUsageRetention({ dataDir, now, dryRun: true });
  assert.deepEqual(dry.prunedRunKeys, [endedKey]);
  assert.equal(dry.applied, false);
  assert.equal(readUsageLedgerState({ dataDir }).endedRuns, 1, 'dry-run changes nothing');

  const applied = pruneUsageRetention({ dataDir, now });
  assert.equal(applied.applied, true);
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.activeRuns, 1, 'an active run is never pruned');
  assert.equal(state.endedRuns, 0);
  assert.equal(state.retiredRunCount, 1);

  // A late event for the pruned run is stale/unknown, not a new run.
  const late = event({
    harness: 'sdk',
    provider: 'cursor',
    runId: 'run-ended',
    tokens: { textInput: 123 },
    at: '2026-06-02T00:00:00.000Z',
  });
  const classified = commitUsageEvent(late, { dataDir, now });
  assert.equal(classified.stale, true);
  assert.equal(readUsageLedgerState({ dataDir }).runCount, 1);
});

test('the hot path does not rescan the whole journal', () => {
  const dataDir = tempDir();
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', requestId: 'r1', tokens: { textInput: 1 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', requestId: 'r2', tokens: { textInput: 2 }, at: `${DAY}T10:01:00.000Z` }),
    { dataDir }
  );
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.lastScan.filesRead, 0, 'no journal file is read when the index is current');
});

test('two data dirs keep separate identity keys and baselines', () => {
  const dirA = tempDir();
  const dirB = tempDir();
  const shared = event({
    harness: 'claude', provider: 'other', runId: 'run-ws', sourceSessionId: 'sess-ws',
    requestId: 'req-ws', tokens: { textInput: 10 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(shared, { dataDir: dirA });
  assert.equal(commitUsageEvent(shared, { dataDir: dirB }).status, 'committed');
  assert.equal(readUsageLedgerState({ dataDir: dirA }).keyCount, 1);
  assert.equal(readUsageLedgerState({ dataDir: dirB }).keyCount, 1);

  const baselineKey = JSON.stringify(['baseline', 'sdk', 'run-b', '', 'sess-b', '', '']);
  const snap = (input) => event({
    harness: 'sdk', provider: 'cursor', runId: 'run-b', sourceSessionId: 'sess-b',
    tokens: { textInput: input }, at: `${DAY}T11:00:00.000Z`,
  });
  commitUsageEvent(snap(100), { dataDir: dirA }, { baselineKey, snapshotTokens: { textInput: 100 } });
  // dirB never saw the baseline, so it counts the full snapshot.
  const inB = commitUsageEvent(snap(100), { dataDir: dirB }, { baselineKey, snapshotTokens: { textInput: 100 } });
  assert.equal(inB.event.tokens.textInput, 100);
  assert.equal(readUsageLedgerState({ dataDir: dirB }).baselineCount, 1);
});

test('hints.supersedes replaces an existing logical key without double counting', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-super', sourceSessionId: 'sess-super',
    requestId: 'req-super', tokens: { textInput: 100 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  const corrected = { ...durable, tokens: { ...durable.tokens, textInput: 80 } };
  const result = commitUsageEvent(corrected, { dataDir }, { supersedes: true, correction: true });
  assert.equal(result.status, 'committed');
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.textInput, 80);
  assert.equal(summarizeUsage(events).tokens.textInput, 80);
  assert.equal(commitUsageEvent(corrected, { dataDir }).status, 'duplicate');
});

test('retention does not drop identity keys for a new run on the same session', () => {
  const dataDir = tempDir();
  const sessionId = 'sess-resume';
  const oldRunKey = deriveRunKey({ harness: 'sdk', runId: 'run-old', sourceSessionId: sessionId });
  const newRunKey = deriveRunKey({ harness: 'sdk', runId: 'run-new', sourceSessionId: sessionId });
  commitRunStart({ harness: 'sdk', runId: 'run-old', runKey: oldRunKey, sourceSessionId: sessionId, at: '2026-01-01T00:00:00.000Z' }, { dataDir });
  const oldUsage = event({
    harness: 'sdk', provider: 'cursor', runId: 'run-old', sourceSessionId: sessionId,
    requestId: 'req-old', tokens: { textInput: 10 }, at: '2026-01-01T00:30:00.000Z',
  });
  commitUsageEvent(oldUsage, { dataDir });
  commitUsageEvent(
    event({
      harness: 'sdk', provider: 'cursor', eventType: 'run', outcome: 'ok',
      runId: 'run-old', sourceSessionId: sessionId, at: '2026-01-01T01:00:00.000Z',
    }),
    { dataDir }
  );
  commitRunStart({ harness: 'sdk', runId: 'run-new', runKey: newRunKey, sourceSessionId: sessionId, at: '2026-01-01T02:00:00.000Z' }, { dataDir });
  const newUsage = event({
    harness: 'sdk', provider: 'cursor', runId: 'run-new', sourceSessionId: sessionId,
    requestId: 'req-new', tokens: { textInput: 20 }, at: '2026-01-01T02:30:00.000Z',
  });
  commitUsageEvent(newUsage, { dataDir });
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  pruneUsageRetention({ dataDir, now });
  resetUsageLedgerCache(dataDir);
  assert.equal(commitUsageEvent(newUsage, { dataDir }).status, 'duplicate');
  const state = readUsageLedgerState({ dataDir });
  assert.ok(state.runs.some((run) => run.runId === 'run-new' && run.status === 'active'));
  assert.equal(state.runs.some((run) => run.runId === 'run-old'), false);
});

test('corrupt line diagnostics are counted once per torn line across rescans', () => {
  const dataDir = tempDir();
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 1 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  const file = usageDayPath(dataDir, DAY);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"broken":`, 'utf8');
  resetUsageLedgerCache(dataDir);
  const first = readUsageLedgerState({ dataDir }).diagnostics.corrupt;
  resetUsageLedgerCache(dataDir);
  const second = readUsageLedgerState({ dataDir }).diagnostics.corrupt;
  assert.equal(first, 1);
  assert.equal(second, 1);
});

test('legacy corrections are dry-runnable, idempotent and supersede the old version', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-corr', sourceSessionId: 'sess-corr',
    requestId: 'req-corr', tokens: { textInput: 1000, textOutput: 10 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });

  const dry = applyUsageCorrections({
    dataDir,
    dryRun: true,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 900, textOutput: 12 } }],
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.applied, 0);
  assert.equal(dry.changes.length, 1);
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 1, 'dry-run writes nothing');

  const applied = applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 900, textOutput: 12 } }],
  });
  assert.equal(applied.applied, 1);
  assert.ok(applied.backupDir, 'corrections create a restorable backup first');
  const corrected = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(corrected.length, 1, 'the superseded version is replaced, not removed');
  assert.equal(corrected[0].tokens.textInput, 900);
  assert.equal(corrected[0].tokens.textOutput, 12);
  const summary = summarizeUsage(corrected);
  assert.equal(summary.tokens.textInput, 900);
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.correctionCount, 1);
  assert.equal(state.supersededKeyCount, 1);
  assert.equal(state.diagnostics.corrections, 1, 'one diagnostic increment per correction');

  const repeat = applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 900, textOutput: 12 } }],
  });
  assert.equal(repeat.applied, 0);
  assert.equal(repeat.skipped[0].reason, 'already_superseded');
});

test('explicit repair rebuilds the read-model from the committed journal', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-repair', sourceSessionId: 'sess-repair',
    requestId: 'req-repair', tokens: { textInput: 3 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  resetUsageLedgerCache(dataDir);
  const repaired = repairUsageLedger({ dataDir });
  assert.equal(repaired.keyCount, 1);
  assert.equal(commitUsageEvent(durable, { dataDir }).status, 'duplicate');
});

test('room-kernel production path persists run-start, one run-ended and late coverage', () => {
  const dataDir = tempDir();
  const kernel = createAgentRoomKernel({
    transport: 'codex',
    persistHistory: () => {},
    usageDataDir: dataDir,
  });
  const room = kernel.createRoomState({ sessionKey: 'sess-e2e', chatId: 'chat-e2e', modelId: 'gpt-5-codex' });
  kernel.broadcastRoom(room, { type: 'sdkPromptStarted', runId: 'run-e2e' });
  assert.ok(room._runId, 'run-start persisted through the kernel');
  kernel.broadcastRoom(room, {
    type: 'sdkEvent',
    event: { type: 'usage', usage: { input_tokens: 100, output_tokens: 10 } },
  });
  kernel.broadcastRoom(room, { type: 'sdkRunFinished', runId: 'run-e2e', status: 'completed' });
  // A late final delta inside the window corrects coverage, never the run count.
  kernel.broadcastRoom(room, {
    type: 'sdkEvent',
    event: { type: 'usage', final: true, usage: { input_tokens: 60, output_tokens: 6 } },
  });

  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.runCount, 1, 'exactly one durable run');
  assert.equal(state.endedRuns, 1);
  assert.equal(state.activeRuns, 0);
  assert.ok(state.runs[0].coverage?.proof, 'the late final measurement corrected coverage');
  assert.equal(recordHarnessRunFinished(room, 'codex', { runId: 'run-e2e', status: 'completed' }), null);
});

test('beginHarnessRun without the persistence seam stays side-effect free', () => {
  const room = { chatId: 'chat-free', transport: 'sdk' };
  beginHarnessRun(room, { runId: 'run-free' });
  assert.equal(room._runId, 'run-free');
  assert.equal(room._runFinishedRecorded, false);
});

test('summary exposes active and ended runs separately and never adds a late run', () => {
  const dataDir = tempDir();
  commitRunStart({ harness: 'codex', runId: 'run-active', at: `${DAY}T09:00:00.000Z` }, { dataDir });

  commitRunStart({ harness: 'codex', runId: 'run-ended', at: `${DAY}T09:05:00.000Z` }, { dataDir });
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', eventType: 'run', outcome: 'ok', runId: 'run-ended', at: `${DAY}T09:10:00.000Z` }),
    { dataDir }
  );
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', runId: 'run-ended', tokens: { textInput: 25 }, at: `${DAY}T09:20:00.000Z` }),
    { dataDir, now: Date.parse(`${DAY}T10:00:00.000Z`) }
  );

  const summary = loadUsageSummary({ from: DAY, to: DAY, dataDir });
  assert.equal(summary.runLifecycle.active, 1);
  assert.equal(summary.runLifecycle.ended, 1);
  assert.equal(summary.runs, 1, 'only the ended run has a run event');
  assert.equal(summary.tokens.textInput, 25, 'the late measurement is counted exactly once');
  assert.equal(summary.ledger.diagnostics.duplicates, 0);
});

test('applyUsageCorrections keeps usd and model attribution in summaries', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude',
    provider: 'other',
    model: 'claude-sonnet-4',
    runId: 'run-priced',
    sourceSessionId: 'sess-priced',
    requestId: 'req-priced',
    reportedUsd: 0.05,
    tokens: { textInput: 1000, textOutput: 10 },
    at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 900, textOutput: 12 } }],
  });
  resetUsageLedgerCache(dataDir);
  const priced = readUsageEvents({ from: DAY, to: DAY, dataDir }).map((row) => priceUsage(row));
  const summary = summarizeUsage(priced);
  assert.equal(summary.tokens.textInput, 900);
  assert.equal(summary.unpricedEvents, 0);
  assert.ok(summary.byModel['claude-sonnet-4']);
  assert.ok(summary.byProvider.other);
});

test('concurrent writers reclaim a dead lock owner and dedupe commits', async () => {
  const dataDir = tempDir();
  const lockDir = path.join(resolveUsageDataDir(dataDir), '.ledger.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(path.join(lockDir, 'owner'), '999999:deadbeef:0\n');
  const moduleUrl = pathToFileURL(path.resolve('lib/persist/usage-persist.js')).href;
  const eventUrl = pathToFileURL(path.resolve('lib/usage/usage-event.js')).href;
  const worker = `
    import { commitUsageEvent } from ${JSON.stringify(moduleUrl)};
    import { createUsageEvent } from ${JSON.stringify(eventUrl)};
    const event = createUsageEvent({
      harness: 'claude', provider: 'other', runId: 'run-dead-lock', sourceSessionId: 'sess-dead-lock',
      requestId: 'req-dead-lock', tokens: { textInput: 10 }, at: '${DAY}T10:00:00.000Z',
    });
    const result = commitUsageEvent(event, { dataDir: process.env.LEDGER_TEST_DIR });
    process.stdout.write(result.status);
  `;
  const statuses = await Promise.all(
    Array.from({ length: 5 }, () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', worker], {
          env: { ...process.env, LEDGER_TEST_DIR: dataDir },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
        });
        child.on('close', () => resolve(out));
      })
    )
  );
  assert.equal(statuses.filter((status) => status === 'committed').length, 1);
  assert.equal(statuses.filter((status) => status === 'duplicate').length, 4);
});

test('corrupt partial applies only to the run scoped by the bad line', () => {
  const dataDir = tempDir();
  commitRunStart({ harness: 'codex', runId: 'run-a', at: `${DAY}T09:00:00.000Z` }, { dataDir });
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', runId: 'run-a', tokens: { textInput: 1 }, at: `${DAY}T09:10:00.000Z` }),
    { dataDir }
  );
  commitRunStart({ harness: 'codex', runId: 'run-b', at: `${DAY}T09:20:00.000Z` }, { dataDir });
  const file = usageDayPath(dataDir, DAY);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"broken":true`, 'utf8');
  resetUsageLedgerCache(dataDir);
  const state = readUsageLedgerState({ dataDir });
  const runA = state.runs.find((run) => run.runId === 'run-a');
  const runB = state.runs.find((run) => run.runId === 'run-b');
  assert.equal(runA?.partial, false);
  assert.equal(runB?.partial, true);
  const fixed = readFileSync(file, 'utf8').replace('{"broken":true', '');
  writeFileSync(file, fixed.endsWith('\n') ? fixed : `${fixed}\n`, 'utf8');
  resetUsageLedgerCache(dataDir);
  const afterFix = readUsageLedgerState({ dataDir });
  assert.equal(afterFix.runs.find((run) => run.runId === 'run-b')?.partial, false);
});

test('persisted corrupt line stays counted once after journal append', () => {
  const dataDir = tempDir();
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 1 }, at: `${DAY}T10:00:00.000Z` }),
    { dataDir }
  );
  const file = usageDayPath(dataDir, DAY);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"broken":`, 'utf8');
  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageLedgerState({ dataDir }).diagnostics.corrupt, 1);
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', tokens: { textInput: 2 }, at: `${DAY}T10:01:00.000Z` }),
    { dataDir }
  );
  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageLedgerState({ dataDir }).diagnostics.corrupt, 1);
});

test('duplicate corrections for the same key in one batch apply once', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-dup-corr', sourceSessionId: 'sess-dup-corr',
    requestId: 'req-dup-corr', tokens: { textInput: 50 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  const result = applyUsageCorrections({
    dataDir,
    corrections: [
      { logicalEventKey: durable.logicalEventKey, tokens: { textInput: 40 } },
      { logicalEventKey: durable.logicalEventKey, tokens: { textInput: 30 } },
    ],
  });
  assert.equal(result.applied, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'duplicate');
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir })[0].tokens.textInput, 40);
});

test('retention key-prune journals removed baselines for repair', () => {
  const dataDir = tempDir();
  const baselineKey = JSON.stringify(['baseline', 'sdk', 'run-prune-base', '', 'sess-prune', '', '']);
  commitUsageEvent(
    event({
      harness: 'sdk', provider: 'cursor', runId: 'run-prune-base', sourceSessionId: 'sess-prune',
      tokens: { textInput: 10 }, at: '2026-01-01T00:30:00.000Z',
    }),
    { dataDir },
    { baselineKey, snapshotTokens: { textInput: 10 } }
  );
  commitUsageEvent(
    event({
      harness: 'sdk', provider: 'cursor', eventType: 'run', outcome: 'ok',
      runId: 'run-prune-base', sourceSessionId: 'sess-prune', at: '2026-01-01T01:00:00.000Z',
    }),
    { dataDir }
  );
  pruneUsageRetention({ dataDir, now: Date.parse('2026-06-01T00:00:00.000Z') });
  resetUsageLedgerCache(dataDir);
  const repaired = repairUsageLedger({ dataDir });
  assert.equal(repaired.baselineCount, 0);
});

test('repair applies cross-day journal records in seq order (M1)', () => {
  const dataDir = tempDir();
  const day1 = '2026-09-30';
  const day2 = '2026-10-01';
  const eventA = event({
    harness: 'claude', provider: 'other', runId: 'run-xday', sourceSessionId: 'sess-xday',
    requestId: 'req-a', tokens: { textInput: 10 }, at: `${day1}T10:00:00.000Z`,
  });
  const eventB = event({
    harness: 'claude', provider: 'other', runId: 'run-xday', sourceSessionId: 'sess-xday',
    requestId: 'req-b', tokens: { textInput: 20 }, at: `${day2}T10:00:00.000Z`,
  });
  const eventC = event({
    harness: 'claude', provider: 'other', runId: 'run-xday', sourceSessionId: 'sess-xday',
    requestId: 'req-c', tokens: { textInput: 30 }, at: `${day2}T10:01:00.000Z`,
  });
  assert.equal(commitUsageEvent(eventA, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(eventB, { dataDir }).status, 'committed');
  assert.equal(commitUsageEvent(eventC, { dataDir }).status, 'committed');
  applyUsageCorrections({
    dataDir,
    now: Date.parse(`${day2}T12:00:00.000Z`),
    corrections: [{ logicalEventKey: eventA.logicalEventKey, tokens: { textInput: 11 } }],
  });
  resetUsageLedgerCache(dataDir);
  unlinkSync(path.join(resolveUsageDataDir(dataDir), 'ledger-index.json'));
  const repaired = repairUsageLedger({ dataDir });
  assert.ok(repaired.lastScan.filesRead >= 2, 'repair must merge multiple day files from the journal');
  assert.equal(repaired.keyCount, 3, 'all logical keys survive cross-day rebuild');
  const events = readUsageEvents({ from: day1, to: day2, dataDir });
  assert.equal(events.length, 3);
  assert.equal(summarizeUsage(events).tokens.textInput, 11 + 20 + 30);
  assert.equal(commitUsageEvent(eventA, { dataDir }).status, 'duplicate');
  assert.equal(commitUsageEvent(eventB, { dataDir }).status, 'duplicate');
});

test('torn tail then append clears stale corrupt partial flag (M2)', () => {
  const dataDir = tempDir();
  commitRunStart({ harness: 'codex', runId: 'run-torn', at: `${DAY}T09:00:00.000Z` }, { dataDir });
  const file = usageDayPath(dataDir, DAY);
  writeFileSync(file, `${readFileSync(file, 'utf8')}{"broken":`, 'utf8');
  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageLedgerState({ dataDir }).runs.find((run) => run.runId === 'run-torn')?.partial, true);
  commitUsageEvent(
    event({ harness: 'codex', provider: 'other', runId: 'run-torn', tokens: { textInput: 1 }, at: `${DAY}T09:30:00.000Z` }),
    { dataDir }
  );
  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageLedgerState({ dataDir }).runs.find((run) => run.runId === 'run-torn')?.partial, false);
});

test('supersede replacement preserves run-ended outcome fields (M3)', () => {
  const dataDir = tempDir();
  const runKey = deriveRunKey({ harness: 'claude', runId: 'run-end-corr', sourceSessionId: 'sess-end-corr' });
  commitRunStart(
    { harness: 'claude', runId: 'run-end-corr', sourceSessionId: 'sess-end-corr', at: `${DAY}T09:00:00.000Z` },
    { dataDir }
  );
  const finished = event({
    harness: 'claude', provider: 'other', eventType: 'run', outcome: 'ok',
    measurementPresent: true, completeness: 'complete',
    runId: 'run-end-corr', sourceSessionId: 'sess-end-corr',
    requestId: 'req-run-end', tokens: { textInput: 50, textOutput: 5 },
    at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(finished, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: finished.logicalEventKey, tokens: { textInput: 40, textOutput: 4 } }],
  });
  const run = readUsageRun(runKey, { dataDir });
  assert.equal(run.outcome, 'ok');
  assert.equal(run.completeness, 'partial', 'correction must not reset completeness to missing');
  assert.equal(run.measurementPresent, true, 'correction must not clear measurementPresent');
  assert.equal(run.status, 'ended');
});

test('supersede token correction keeps run lastAcceptedAt for retention (M4)', () => {
  const dataDir = tempDir();
  const runKey = deriveRunKey({ harness: 'claude', runId: 'run-ret-at', sourceSessionId: 'sess-ret-at' });
  commitRunStart(
    { harness: 'claude', runId: 'run-ret-at', sourceSessionId: 'sess-ret-at', at: `${DAY}T09:00:00.000Z` },
    { dataDir }
  );
  const delta = event({
    harness: 'claude', provider: 'other', runId: 'run-ret-at', sourceSessionId: 'sess-ret-at',
    requestId: 'req-delta', tokens: { textInput: 10 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(delta, { dataDir });
  const endedAt = `${DAY}T10:05:00.000Z`;
  commitUsageEvent(
    event({
      harness: 'claude', provider: 'other', eventType: 'run', outcome: 'ok',
      runId: 'run-ret-at', sourceSessionId: 'sess-ret-at', at: endedAt,
    }),
    { dataDir }
  );
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: delta.logicalEventKey, tokens: { textInput: 9 } }],
  });
  assert.equal(readUsageRun(runKey, { dataDir }).lastAcceptedAt, endedAt);
});

test('applyUsageCorrections marks journal scanned without extra recovery read (M6)', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-scan', sourceSessionId: 'sess-scan',
    requestId: 'req-scan', tokens: { textInput: 5 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 4 } }],
  });
  resetUsageLedgerCache(dataDir);
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.lastScan.filesRead, 0, 'fileScan sizes must match after corrections');
});

test('readUsageEvents resolves multiple supersede replacements in one pass (M5)', () => {
  const dataDir = tempDir();
  const first = event({
    harness: 'claude', provider: 'other', runId: 'run-m5a', sourceSessionId: 'sess-m5',
    requestId: 'req-m5a', tokens: { textInput: 10 }, at: `${DAY}T10:00:00.000Z`,
  });
  const second = event({
    harness: 'claude', provider: 'other', runId: 'run-m5b', sourceSessionId: 'sess-m5',
    requestId: 'req-m5b', tokens: { textInput: 20 }, at: `${DAY}T10:01:00.000Z`,
  });
  commitUsageEvent(first, { dataDir });
  commitUsageEvent(second, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [
      { logicalEventKey: first.logicalEventKey, tokens: { textInput: 11 } },
      { logicalEventKey: second.logicalEventKey, tokens: { textInput: 22 } },
    ],
  });
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((row) => row.tokens.textInput).sort((a, b) => a - b),
    [11, 22]
  );
});

test('run-ended correction keeps outcome role delegationId and latency in summaries (D1)', () => {
  const dataDir = tempDir();
  const runKey = deriveRunKey({
    harness: 'claude',
    runId: 'run-d1',
    sourceSessionId: 'sess-d1',
  });
  commitRunStart(
    { harness: 'claude', runId: 'run-d1', sourceSessionId: 'sess-d1', role: 'implement', at: `${DAY}T09:00:00.000Z` },
    { dataDir }
  );
  const finished = event({
    harness: 'claude',
    provider: 'other',
    eventType: 'run',
    outcome: 'ok',
    role: 'implement',
    delegationId: 'deleg-d1',
    latencyMs: 1200,
    runId: 'run-d1',
    sourceSessionId: 'sess-d1',
    requestId: 'req-d1-run',
    tokens: { textInput: 50, textOutput: 5 },
    at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(finished, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: finished.logicalEventKey, tokens: { textInput: 40, textOutput: 4 } }],
  });
  resetUsageLedgerCache(dataDir);
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  const summary = summarizeUsage(events);
  assert.equal(summary.okRuns, 1);
  assert.equal(summary.byRole.implement?.runs, 1);
  assert.equal(events[0].role, 'implement');
  assert.equal(events[0].delegationId, 'deleg-d1');
  assert.equal(events[0].latencyMs, 1200);
  const run = readUsageRun(runKey, { dataDir });
  assert.equal(run.outcome, 'ok');
  assert.equal(run.role, 'implement');
});

test('readUsageEvents does not parse journal files when nothing is superseded (D2)', () => {
  const dataDir = tempDir();
  const dayOther = '2026-09-29';
  commitUsageEvent(
    event({
      harness: 'claude', provider: 'other', runId: 'run-a', sourceSessionId: 'sess-a',
      requestId: 'req-a', tokens: { textInput: 1 }, at: `${dayOther}T10:00:00.000Z`,
    }),
    { dataDir }
  );
  commitUsageEvent(
    event({
      harness: 'claude', provider: 'other', runId: 'run-b', sourceSessionId: 'sess-b',
      requestId: 'req-b', tokens: { textInput: 2 }, at: `${DAY}T10:00:00.000Z`,
    }),
    { dataDir }
  );
  resetUsageLedgerCache(dataDir);
  readUsageLedgerState({ dataDir });
  readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(readUsageLedgerState({ dataDir }).lastReadEventsSupersedeFiles, 0);
});

test('supersede replacement scan stays inside the read date range (D2)', () => {
  const dataDir = tempDir();
  const dayOther = '2026-09-29';
  const first = event({
    harness: 'claude', provider: 'other', runId: 'run-range', sourceSessionId: 'sess-range',
    requestId: 'req-range', tokens: { textInput: 10 }, at: `${dayOther}T10:00:00.000Z`,
  });
  commitUsageEvent(first, { dataDir });
  applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: first.logicalEventKey, tokens: { textInput: 11 } }],
  });
  resetUsageLedgerCache(dataDir);
  const outOfRange = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(outOfRange.length, 0);
  assert.equal(readUsageLedgerState({ dataDir }).lastReadEventsSupersedeFiles, 0);
  const inRange = readUsageEvents({ from: dayOther, to: dayOther, dataDir });
  assert.equal(inRange.length, 1);
  assert.equal(inRange[0].tokens.textInput, 11);
  assert.equal(readUsageLedgerState({ dataDir }).lastReadEventsSupersedeFiles, 1);
});

test('supersede replacement resolves after key-prune when correction day differs from event day', () => {
  const dataDir = tempDir();
  const dayCorrection = '2026-09-29';
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-prune-sup', sourceSessionId: 'sess-prune-sup',
    requestId: 'req-prune-sup', tokens: { textInput: 10 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  applyUsageCorrections({
    dataDir,
    now: Date.parse(`${dayCorrection}T11:00:00.000Z`),
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 21 } }],
  });
  const { lastSeq } = readUsageLedgerState({ dataDir });
  appendJournalEnvelope(dataDir, {
    seq: lastSeq + 1,
    kind: 'key-prune',
    at: `${dayCorrection}T12:00:00.000Z`,
    removedKeys: [durable.logicalEventKey],
  });
  resetUsageLedgerCache(dataDir);
  repairUsageLedger({ dataDir });
  const state = readUsageLedgerState({ dataDir });
  assert.equal(state.supersededKeyCount, 1);
  assert.equal(state.keyCount, 0);
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.textInput, 21);
});

test('pendingReplacement allows finishing a crashed correction (D4)', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-pending', sourceSessionId: 'sess-pending',
    requestId: 'req-pending', tokens: { textInput: 100 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  appendJournalEnvelope(dataDir, {
    seq: 99,
    kind: 'correction',
    at: `${DAY}T10:05:00.000Z`,
    supersede: durable.logicalEventKey,
    correction: {
      version: USAGE_NORMALIZATION_VERSION,
      scope: 'tokens',
      previous: { tokens: { textInput: 100 } },
      next: { tokens: { textInput: 90 } },
    },
  });
  resetUsageLedgerCache(dataDir);
  assert.equal(readUsageEvents({ from: DAY, to: DAY, dataDir }).length, 0);
  const finished = applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: durable.logicalEventKey, tokens: { textInput: 90 } }],
  });
  assert.equal(finished.applied, 1);
  assert.equal(finished.skipped.length, 0);
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 1);
  assert.equal(events[0].tokens.textInput, 90);
});

test('legacy raw line before an envelope with the same seq is not dropped (D5)', () => {
  const dataDir = tempDir();
  const legacy = event({
    harness: 'codex', provider: 'other', runId: 'run-legacy-seq', tokens: { textInput: 7 },
    at: `${DAY}T10:00:00.000Z`,
  });
  const file = usageDayPath(dataDir, DAY);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(legacy)}\n`, 'utf8');
  resetUsageLedgerCache(dataDir);
  const enveloped = event({
    harness: 'codex', provider: 'other', runId: 'run-legacy-seq', requestId: 'req-env',
    tokens: { textInput: 3 }, at: `${DAY}T10:01:00.000Z`,
  });
  assert.equal(commitUsageEvent(enveloped, { dataDir }).status, 'committed');
  resetUsageLedgerCache(dataDir);
  unlinkSync(path.join(resolveUsageDataDir(dataDir), 'ledger-index.json'));
  const repaired = repairUsageLedger({ dataDir });
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 2);
  assert.equal(summarizeUsage(events).tokens.textInput, 10);
});

test('applyUsageCorrections skips backup when there are no changes', () => {
  const dataDir = tempDir();
  const result = applyUsageCorrections({
    dataDir,
    corrections: [{ logicalEventKey: 'missing-key', tokens: { textInput: 1 } }],
  });
  assert.equal(result.applied, 0);
  assert.equal(result.backupDir, null);
});

test('correction without replacement usage omits stale tokens from reads', () => {
  const dataDir = tempDir();
  const durable = event({
    harness: 'claude', provider: 'other', runId: 'run-crash-corr', sourceSessionId: 'sess-crash-corr',
    requestId: 'req-crash-corr', tokens: { textInput: 1000 }, at: `${DAY}T10:00:00.000Z`,
  });
  commitUsageEvent(durable, { dataDir });
  appendJournalEnvelope(dataDir, {
    seq: 99,
    kind: 'correction',
    at: `${DAY}T10:05:00.000Z`,
    supersede: durable.logicalEventKey,
    correction: {
      version: USAGE_NORMALIZATION_VERSION,
      scope: 'tokens',
      previous: { tokens: { textInput: 1000 } },
      next: { tokens: { textInput: 900 } },
    },
  });
  resetUsageLedgerCache(dataDir);
  const events = readUsageEvents({ from: DAY, to: DAY, dataDir });
  assert.equal(events.length, 0, 'superseded without replacement must not replay old tokens');
});
