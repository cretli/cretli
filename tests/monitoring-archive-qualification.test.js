/**
 * Task 3.1 — archived chats must not stay monitored because of a stale
 * waiting/attention presence, while an open chat or a real run still is.
 *
 * Covers the completed `hasConfirmedAgentRun` contract, the archive-aware
 * classifier/selection, the 1500/1200 archived regression shape, and the
 * "opening the archive does not expand monitoring" guarantee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasActiveAgentRun,
  hasConfirmedAgentRun,
} from '../app_front/features/chat/chatStatusMeta.js';
import {
  classifyMonitoringCandidateReasons,
  classifyMonitoringReasons,
  isArchivedChat,
  qualifiesArchivedMonitoring,
  selectBackgroundWsChatIds,
  selectHistoryHttpChatIds,
  selectMonitoredChatIds,
} from '../app_front/features/chat/chatBackgroundPolicy.js';
import {
  createUiFreezeCounters,
} from '../app_front/lib/uiFreezeCounters.js';

const ARCHIVED_AT = '2026-01-01T00:00:00.000Z';
const STALE = 10 * 24 * 60 * 60 * 1000;

/** @param {object} chat @param {object} [extra] */
function chat(id, extra = {}) {
  return { id, cursorSessionId: `s-${id}`, activityAt: 0, ...extra };
}

// --- contract completion: hasConfirmedAgentRun vs hasActiveAgentRun -----------------

test('hasConfirmedAgentRun rejects a non-run presence that keeps _agentState alive', () => {
  // A local active flag with no server signal is still a run.
  assert.equal(hasActiveAgentRun({ _agentState: 'active' }), true);
  assert.equal(hasConfirmedAgentRun({ _agentState: 'active' }), true);

  // Stale waiting/attention/pending veto the client-only flag — those are not work.
  assert.equal(hasActiveAgentRun({ _agentState: 'active', _serverRunState: { state: 'waiting' } }), true);
  assert.equal(hasConfirmedAgentRun({ _agentState: 'active', _serverRunState: { state: 'waiting' } }), false);
  assert.equal(hasConfirmedAgentRun({ _agentState: 'active', _serverRunState: { state: 'attention' } }), false);
  // Parent folded to `waiting` while child delegations run is still a confirmed run.
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: { state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 2 },
  }), true);
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: { state: 'waiting', waitingAgentCount: 1, inFlightChildCount: 1, delegationStatus: 'running' },
  }), true);
  assert.equal(hasConfirmedAgentRun({
    _agentState: 'active',
    _serverRunState: { state: 'waiting', waitingAgentCount: 1, inFlightChildCount: 1 },
  }), true);
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: {
      state: 'waiting',
      waitingAgentCount: 1,
      inFlightChildCount: 0,
      delegationStatus: 'waiting_for_input',
    },
  }), false, 'waiting_for_input child is not in-flight work');
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: {
      state: 'waiting',
      waitingAgentCount: 2,
      inFlightChildCount: 1,
      delegationStatus: 'waiting_for_input',
    },
  }), true, 'mixed running + waiting_for_input children still qualify');
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: {
      state: 'waiting',
      waitingAgentCount: 1,
      delegationStatus: 'waiting_for_input',
    },
  }), false, 'legacy shape without inFlightChildCount must not treat waiting_for_input as a run');
  assert.equal(hasConfirmedAgentRun({
    _serverRunState: { state: 'waiting', waitingAgentCount: 1, delegationStatus: 'running' },
  }), true, 'legacy shape may still use in-flight delegationStatus');
  assert.equal(hasConfirmedAgentRun({ _agentState: 'active', _opencodePendingQuestion: { id: 'q' } }), false);
  assert.equal(hasConfirmedAgentRun({
    _agentState: 'active',
    _sdkServerPendingPermissionCount: 1,
  }), false);

  // Protocol busy/queued always wins, even if a stale presence sits beside it.
  assert.equal(hasConfirmedAgentRun({ _serverRunState: { state: 'busy' } }), true);
  assert.equal(hasConfirmedAgentRun({ _sdkServerBusy: true }), true);
  assert.equal(hasConfirmedAgentRun({ _sdkServerQueuedCount: 2 }), true);
  assert.equal(hasConfirmedAgentRun({ _sdkRichView: { queuedCount: 1 } }), true);
  assert.equal(hasConfirmedAgentRun({ _serverRunState: { state: 'waiting' } }), false);
  assert.equal(hasConfirmedAgentRun({ _serverRunState: { state: 'attention' } }), false);
  assert.equal(hasConfirmedAgentRun(null), false);
});

// --- classifyMonitoringReasons: archived gate ---------------------------------------

test('archived idle / stale waiting / attention / recent do not qualify', () => {
  const opts = { activeChatId: 'other', getChatActivityAt: (c) => c.activityAt, now: 1_000_000 };
  const archived = (extra) => chat('a', { archivedAt: ARCHIVED_AT, ...extra });

  assert.deepEqual(classifyMonitoringReasons(archived({}), opts), []);
  assert.deepEqual(classifyMonitoringReasons(archived({ _serverRunState: { state: 'waiting' } }), opts), []);
  assert.deepEqual(classifyMonitoringReasons(archived({ _serverRunState: { state: 'attention' } }), opts), []);
  assert.deepEqual(
    classifyMonitoringReasons(archived({ activityAt: 999_000 }), opts),
    [],
    'recent alone must not keep an archived chat monitored',
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({
      _agentState: 'active',
      _serverRunState: { state: 'waiting' },
    }), opts),
    [],
    'a non-idle client state driven by waiting is not a run',
  );
});

test('archived chat qualifies only when active or actually running', () => {
  const opts = { activeChatId: 'other', getChatActivityAt: (c) => c.activityAt, now: 1_000_000 };
  const archived = (extra) => chat('a', { archivedAt: ARCHIVED_AT, ...extra });

  assert.deepEqual(
    classifyMonitoringReasons(archived({
      _serverRunState: { state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 2 },
    }), opts),
    ['live'],
    'archived parent waiting on in-flight child jobs stays monitored (live bucket)',
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({
      _serverRunState: {
        state: 'waiting',
        waitingAgentCount: 1,
        inFlightChildCount: 1,
        delegationStatus: 'running',
      },
    }), opts),
    ['live'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({
      _serverRunState: {
        state: 'waiting',
        waitingAgentCount: 1,
        inFlightChildCount: 0,
        delegationStatus: 'waiting_for_input',
      },
    }), opts),
    [],
    'archived parent waiting only on user input must not stay monitored',
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({ _sdkServerBusy: true }), opts),
    ['live'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({ _serverRunState: { state: 'busy' } }), opts),
    ['live', 'busy'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({ _sdkServerQueuedCount: 1 }), opts),
    ['live'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({ _agentState: 'active' }), opts),
    ['live'],
    'a local run without a non-run presence still counts',
  );
  assert.deepEqual(
    classifyMonitoringReasons(archived({ _sdkServerBusy: true }), { ...opts, activeChatId: 'a' }),
    ['active', 'live'],
  );
});

test('non-archived chats keep the full reason set', () => {
  const opts = { activeChatId: 'other', getChatActivityAt: (c) => c.activityAt, now: 1_000_000 };
  assert.deepEqual(
    classifyMonitoringReasons(chat('w', { _serverRunState: { state: 'waiting' } }), opts),
    ['live', 'waiting'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(chat('t', { _serverRunState: { state: 'attention' } }), opts),
    ['attention'],
  );
  assert.deepEqual(
    classifyMonitoringReasons(chat('r', { activityAt: 999_000 }), opts),
    ['recent'],
  );
});

test('candidate classifier is the pre-3.1 behaviour and stays archive-agnostic', () => {
  const opts = { activeChatId: 'other', getChatActivityAt: (c) => c.activityAt, now: 1_000_000 };
  const archivedAttention = chat('a', { archivedAt: ARCHIVED_AT, _serverRunState: { state: 'attention' } });
  assert.deepEqual(classifyMonitoringCandidateReasons(archivedAttention, opts), ['attention']);
  assert.deepEqual(classifyMonitoringReasons(archivedAttention, opts), []);
});

// --- 1500 / 1200 archived regression ------------------------------------------------

test('1500 chats with 1200 archived: stale archived rows leave the monitor set', () => {
  const now = 2_000_000;
  const rows = [];
  for (let index = 0; index < 1500; index += 1) {
    const archived = index < 1200;
    /** @type {Record<string, unknown>} */
    const row = chat(`c-${index}`, {
      activityAt: index % 5 === 0 ? now - 1000 : now - STALE,
    });
    if (archived) row.archivedAt = ARCHIVED_AT;
    if (index % 3 === 0) row._serverRunState = { state: 'waiting' };
    else if (index % 3 === 1) row._serverRunState = { state: 'attention' };
    if (index % 500 === 0) row._sdkServerBusy = true;
    rows.push(row);
  }
  // Active chat is an archived row to prove the "open chat" exception.
  const activeChatId = 'c-0';
  const getChatActivityAt = (row) => row.activityAt;

  // Raw "before" reason matches are much larger than the gated set.
  let rawMatches = 0;
  for (const row of rows) {
    if (classifyMonitoringCandidateReasons(row, { activeChatId, getChatActivityAt, now }).length > 0) {
      rawMatches += 1;
    }
  }

  const monitored = selectMonitoredChatIds(rows, () => activeChatId, getChatActivityAt, now);
  assert.ok(monitored.has('c-0'), 'open archived chat stays monitored');
  // Every archived row with no run and not open is excluded, including c-0's peers.
  for (let index = 1; index < 1200; index += 1) {
    if (index % 500 === 0) {
      assert.ok(monitored.has(`c-${index}`), `archived busy run c-${index} stays monitored`);
    } else {
      assert.ok(!monitored.has(`c-${index}`), `stale archived c-${index} must not be monitored`);
    }
  }
  assert.ok(monitored.size < rawMatches, 'gate removes archived rows from the monitor set');
});

test('fast path and instrumented path select the same chats', () => {
  const now = 3_000_000;
  const rows = [
    chat('active', { archivedAt: ARCHIVED_AT }),
    chat('archived-run', { archivedAt: ARCHIVED_AT, _sdkServerBusy: true, activityAt: now - STALE }),
    chat('archived-stale', { archivedAt: ARCHIVED_AT, _serverRunState: { state: 'waiting' }, activityAt: now - 1000 }),
    chat('live', { _serverRunState: { state: 'busy' } }),
    chat('recent', { activityAt: now - 1000 }),
  ];
  const getChatActivityAt = (row) => row.activityAt;
  const fast = selectMonitoredChatIds(rows, () => 'active', getChatActivityAt, now);
  const instrumented = selectMonitoredChatIds(rows, () => 'active', getChatActivityAt, now, {
    onClassified: () => {},
  });
  assert.deepEqual([...instrumented].sort(), [...fast].sort());
  assert.ok(fast.has('archived-run'));
  assert.ok(!fast.has('archived-stale'));
});

// --- opening the archive must not expand monitoring ---------------------------------

test('opening the archive does not HTTP-poll stale archived rows', () => {
  const now = 4_000_000;
  const archivedStale = chat('archived-stale', {
    archivedAt: ARCHIVED_AT,
    _serverRunState: { state: 'attention' },
    activityAt: now - 1000,
  });
  const archivedRun = chat('archived-run', { archivedAt: ARCHIVED_AT, _sdkServerBusy: true });
  const live = chat('live', { _serverRunState: { state: 'waiting' } });
  const rows = [archivedStale, archivedRun, live];
  const getChatActivityAt = (row) => row.activityAt;
  const monitored = selectMonitoredChatIds(rows, () => '', getChatActivityAt, now);
  // The archive section rendered every archived id.
  const visible = new Set(['archived-stale', 'archived-run', 'live']);
  const http = selectHistoryHttpChatIds(monitored, rows, { activeChatId: '', visibleChatIds: visible });
  assert.ok(!http.has('archived-stale'), 'stale archived row must not be polled just because it is visible');
  assert.ok(http.has('archived-run'), 'archived run stays polled through visibility');
  assert.ok(http.has('live'));

  // Defence in depth: an archived id injected into the monitored set is dropped.
  const injected = selectHistoryHttpChatIds(new Set(['archived-stale']), rows, {
    activeChatId: '',
    visibleChatIds: visible,
  });
  assert.equal(injected.size, 0);
});

test('archived rows do not take background WS slots, but runs do', () => {
  const now = 5_000_000;
  const recentArchived = chat('recent-archived', { archivedAt: ARCHIVED_AT, activityAt: now - 1000 });
  const waitingArchived = chat('waiting-archived', {
    archivedAt: ARCHIVED_AT,
    _serverRunState: { state: 'waiting' },
    activityAt: now - 2000,
  });
  const childJobsArchived = chat('child-jobs-archived', {
    archivedAt: ARCHIVED_AT,
    _serverRunState: { state: 'waiting', waitingAgentCount: 1, inFlightChildCount: 1 },
  });
  const waitingInputArchived = chat('waiting-input-archived', {
    archivedAt: ARCHIVED_AT,
    _serverRunState: {
      state: 'waiting',
      waitingAgentCount: 1,
      inFlightChildCount: 0,
      delegationStatus: 'waiting_for_input',
    },
  });
  const runArchived = chat('run-archived', { archivedAt: ARCHIVED_AT, _sdkServerBusy: true });
  const live = chat('live', { _serverRunState: { state: 'busy' } });
  const rows = [recentArchived, waitingArchived, childJobsArchived, waitingInputArchived, runArchived, live];
  const ws = selectBackgroundWsChatIds(rows, () => '', (row) => row.activityAt, now);
  assert.ok(!ws.has('recent-archived'), 'recent archived row must not take a WS slot');
  assert.ok(!ws.has('waiting-archived'), 'stale waiting archived row must not take a WS slot');
  assert.ok(!ws.has('waiting-input-archived'), 'archived waiting_for_input child must not take a WS slot');
  assert.ok(ws.has('child-jobs-archived'), 'archived parent with in-flight child jobs keeps a WS slot');
  assert.ok(ws.has('run-archived'), 'archived real run keeps a WS slot');
  assert.ok(ws.has('live'));
});

// --- archive helpers + counter "before/after" surface --------------------------------

test('isArchivedChat / qualifiesArchivedMonitoring match the gate', () => {
  assert.equal(isArchivedChat({ archivedAt: ARCHIVED_AT }), true);
  assert.equal(isArchivedChat({ archivedAt: '   ' }), false);
  assert.equal(qualifiesArchivedMonitoring(chat('plain'), ''), true);
  assert.equal(qualifiesArchivedMonitoring(chat('a', { archivedAt: ARCHIVED_AT }), ''), false);
  assert.equal(qualifiesArchivedMonitoring(chat('a', { archivedAt: ARCHIVED_AT }), 'a'), true);
  assert.equal(
    qualifiesArchivedMonitoring(chat('a', { archivedAt: ARCHIVED_AT, _sdkServerBusy: true }), ''),
    true,
  );
});

test('counter meter records candidate and qualified reasons separately', () => {
  const meter = createUiFreezeCounters({ now: () => 0, active: () => true });
  meter.recordMonitoringCandidate({ reason: 'attention', archived: true });
  meter.recordMonitoringCandidate({ reason: 'attention', archived: true });
  meter.recordMonitoringQualification({ reason: 'busy', archived: true });
  const snapshot = meter.snapshot();
  assert.equal(snapshot.monitoringCandidates['attention|archived=true'], 2);
  assert.equal(snapshot.monitoring['attention|archived=true'], undefined);
  assert.equal(snapshot.monitoring['busy|archived=true'], 1);
});
