/**
 * Scout scan usage settle contract (summarize + history exposure).
 */
import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  appendWorkspaceScoutScanHistory,
  mutateWorkspaceWatcherRow,
  upsertWorkspaceWatcher,
} from '../lib/persist/workspace-watchers-persist.js';
import { summarizeScoutScanUsage, clearActiveScoutScanIfScanId } from '../lib/workspace-watcher-scout.js';
import { getWorkspaceWatcherScoutHistory } from '../lib/workspace-watcher-control.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

const dataDir = process.env.CRETLI_DATA_DIR;
const workspaceFolder = path.join(os.tmpdir(), 'scout-usage-test-ws');

test.after(() => {
  removeIsolatedDataDir();
});

test('summarizeScoutScanUsage returns numbers only when the ledger measured usage', () => {
  const chatId = 'chat-measured-1';
  const usage = summarizeScoutScanUsage({
    chatId,
    runId: 'run-1',
    startedAt: '2026-02-01T10:00:00.000Z',
    finishedAt: '2026-02-01T10:05:00.000Z',
    deps: {
      readUsageEvents: () => ([{
        chatId,
        runId: 'run-1',
        usd: 0.004,
        measurementPresent: true,
      }]),
    },
  });
  assert.ok(usage);
  assert.equal(usage.eventCount, 1);
  assert.ok(usage.usd > 0);

  const empty = summarizeScoutScanUsage({
    chatId: 'chat-empty',
    deps: { readUsageEvents: () => [] },
  });
  assert.equal(empty, null);

  const noChat = summarizeScoutScanUsage({ chatId: '' });
  assert.equal(noChat, null);

  const throwing = summarizeScoutScanUsage({
    chatId: 'chat-throw',
    deps: { readUsageEvents: () => { throw new Error('ledger down'); } },
  });
  assert.equal(throwing, null);
});

test('summarizeScoutScanUsage omits usd when ledger has tokens but no positive usd', () => {
  const chatId = 'chat-tokens-only';
  const usage = summarizeScoutScanUsage({
    chatId,
    deps: {
      readUsageEvents: () => ([{
        chatId,
        harness: 'openrouter',
        tokens: { textInput: 100, textOutput: 50 },
      }]),
    },
  });
  assert.ok(usage);
  assert.ok(usage.tokens > 0);
  assert.equal('usd' in usage, false);
});

test('summarizeScoutScanUsage does not fabricate zero tokens or usd for measurementPresent-only ledger', () => {
  const chatId = 'chat-marker-only';
  const markerOnly = summarizeScoutScanUsage({
    chatId,
    deps: {
      readUsageEvents: () => ([{ chatId, measurementPresent: true }]),
    },
  });
  assert.ok(markerOnly);
  assert.equal('tokens' in markerOnly, false);
  assert.equal('usd' in markerOnly, false);
  assert.equal(markerOnly.eventCount, 1);

  const noSignal = summarizeScoutScanUsage({
    chatId: 'chat-no-signal',
    deps: {
      readUsageEvents: () => ([{ chatId: 'chat-no-signal', note: 'no measurement fields' }]),
    },
  });
  assert.equal(noSignal, null);
});

test('clearActiveScoutScanIfScanId writes usage only when measured; history exposes null otherwise', () => {
  upsertWorkspaceWatcher(workspaceFolder, { policy: { scoutEnabled: true } }, { dataDir });
  const scanId = 'scan-usage-settle';
  const chatId = 'chat-settle-1';
  mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
    activeScoutScans: [{
      scanId,
      scoutId: 'profile-1',
      chatId,
      runId: 'run-settle',
      status: 'running',
      startedAt: '2026-02-01T10:00:00.000Z',
      reservedAt: '2026-02-01T09:59:00.000Z',
    }],
    ...appendWorkspaceScoutScanHistory(row, {
      scanId,
      scoutId: 'profile-1',
      status: 'running',
      startedAt: '2026-02-01T10:00:00.000Z',
      chatId,
      runId: 'run-settle',
      usage: null,
    }),
  }), { dataDir, createIfMissing: false });

  const cleared = clearActiveScoutScanIfScanId(workspaceFolder, scanId, {
    dataDir,
    status: 'completed',
    now: Date.parse('2026-02-01T10:06:00.000Z'),
    deps: { readUsageEvents: () => [] },
  });
  assert.equal(cleared, true);
  let history = getWorkspaceWatcherScoutHistory({ dataDir, workspaceFolder, max: 10 });
  assert.equal(history.history[0]?.usage, null);

  const scanId2 = 'scan-usage-settle-2';
  mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => ({
    activeScoutScans: [{
      scanId: scanId2,
      scoutId: 'profile-1',
      chatId: 'chat-settle-2',
      runId: 'run-2',
      status: 'running',
      startedAt: '2026-02-01T11:00:00.000Z',
    }],
    ...appendWorkspaceScoutScanHistory(row, {
      scanId: scanId2,
      scoutId: 'profile-1',
      status: 'running',
      startedAt: '2026-02-01T11:00:00.000Z',
      chatId: 'chat-settle-2',
      runId: 'run-2',
      usage: null,
    }),
  }), { dataDir, createIfMissing: false });

  clearActiveScoutScanIfScanId(workspaceFolder, scanId2, {
    dataDir,
    status: 'completed',
    now: Date.parse('2026-02-01T11:06:00.000Z'),
    deps: {
      readUsageEvents: () => ([{
        chatId: 'chat-settle-2',
        runId: 'run-2',
        usd: 0.01,
        measurementPresent: true,
      }]),
    },
  });
  history = getWorkspaceWatcherScoutHistory({ dataDir, workspaceFolder, max: 10 });
  const measured = history.history.find((entry) => entry.scanId === scanId2);
  assert.ok(measured?.usage);
  assert.ok(measured.usage.usd > 0);
  assert.notEqual(measured.usage, {});
});
