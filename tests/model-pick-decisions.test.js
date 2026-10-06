import './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  classifyDelegationPickOrigin,
  finalizeDelegationPickSlotReservation,
  persistModelPickProposal,
  releaseModelPickSlotsForDelegation,
  resolveDelegationPickLinkFields,
  summarizeModelPickExecutionCounters,
} from '../lib/model-pick-decisions.js';
import {
  getModelPickRecord,
  normalizeModelPickRecord,
  purgeStaleModelPickRecords,
  reserveModelPickSlot,
} from '../lib/persist/model-pick-decisions-persist.js';
import { MODEL_PICK_MAX_CANDIDATES, MODEL_PICK_MAX_SLOTS, MODEL_PICK_RETENTION_MS, MODEL_PICK_TTL_MS } from '../lib/model-pick-policy.js';
import {
  buildDelegationQualityCycles,
  summarizeDelegationCycleCostMetrics,
} from '../lib/delegation-cycle-outcomes.js';

function tempPickFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pick-')), 'model-pick-decisions.json');
}

test('persistModelPickProposal stores bounded candidates and pickId', () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    chatId: 'chat-1',
    workspaceFolder: '/tmp/ws',
    purpose: 'model_pick',
    role: 'implement',
    pickResult: {
      pick: { harness: 'a', model: 'm-a', reason: 'score' },
      picks: [
        { harness: 'a', model: 'm-a', reason: 'score' },
        { harness: 'b', model: 'm-b', reason: 'rotation' },
      ],
      candidates: [{ harness: 'c', model: 'm-c' }],
    },
    file,
  });
  assert.ok(persisted.pickId);
  const loaded = getModelPickRecord(persisted.pickId, { file });
  assert.equal(loaded.role, 'implement');
  assert.ok(loaded.candidates.length >= 2);
  assert.equal(loaded.picks[0].harness, 'a');
});

test('valid pick_id links as auto selected', () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    chatId: 'chat-1',
    role: 'implement',
    pickResult: { pick: { harness: 'deepseek', model: 'deepseek-chat' }, picks: [{ harness: 'deepseek', model: 'deepseek-chat' }] },
    file,
  });
  const linked = classifyDelegationPickOrigin({
    pickId: persisted.pickId,
    harness: 'deepseek',
    model: 'deepseek-chat',
    assignment: 'implement',
    executionMode: 'agent',
    parentChatId: 'chat-1',
    file,
  });
  assert.equal(linked.origin, 'auto');
  assert.equal(linked.originDetail, 'selected');
  assert.equal(linked.linkStatus, 'linked');
});

test('expired pick_id is rejected-link unknown', () => {
  const file = tempPickFile();
  const now = Date.now();
  const persisted = persistModelPickProposal({
    role: 'implement',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    now,
    file,
  });
  const linked = classifyDelegationPickOrigin({
    pickId: persisted.pickId,
    harness: 'a',
    model: 'm-a',
    assignment: 'implement',
    now: now + MODEL_PICK_TTL_MS + 1000,
    file,
  });
  assert.equal(linked.origin, 'unknown');
  assert.equal(linked.originDetail, 'rejected-link');
});

test('wrong model on pick_id is rejected-link', () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    role: 'implement',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
  const linked = classifyDelegationPickOrigin({
    pickId: persisted.pickId,
    harness: 'a',
    model: 'other-model',
    assignment: 'implement',
    file,
  });
  assert.equal(linked.linkStatus, 'rejected-link');
});

test('fanout uses separate slots and idempotent replay', async () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    role: 'review',
    pickResult: {
      pick: { harness: 'a', model: 'm-a' },
      picks: [{ harness: 'a', model: 'm-a' }, { harness: 'b', model: 'm-b' }],
    },
    file,
  });
  const first = await reserveModelPickSlot({
    pickId: persisted.pickId,
    selectionSlot: 0,
    delegationId: randomUUID(),
    idempotencyKey: 'idem-1',
    file,
  });
  assert.equal(first.ok, true);
  const second = await reserveModelPickSlot({
    pickId: persisted.pickId,
    selectionSlot: 1,
    delegationId: randomUUID(),
    idempotencyKey: 'idem-2',
    file,
  });
  assert.equal(second.ok, true);
  const replay = await reserveModelPickSlot({
    pickId: persisted.pickId,
    selectionSlot: 0,
    delegationId: randomUUID(),
    idempotencyKey: 'idem-1',
    file,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  const conflict = await reserveModelPickSlot({
    pickId: persisted.pickId,
    selectionSlot: 0,
    delegationId: randomUUID(),
    idempotencyKey: 'idem-3',
    file,
  });
  assert.equal(conflict.ok, false);
});

test('manual source marks manual origin', () => {
  const linked = classifyDelegationPickOrigin({
    manualSource: 'settings-ui',
    harness: 'a',
    model: 'm-a',
    assignment: 'implement',
  });
  assert.equal(linked.origin, 'manual');
});

test('accepted-by-review requires all sibling PASS and verify', () => {
  const parentChatId = 'parent-1';
  const implement = {
    id: 'impl-1',
    parentChatId,
    assignment: 'implement',
    executionMode: 'agent',
    status: 'completed',
    taskOutcome: 'success',
    createdAt: '2026-10-01T10:00:00.000Z',
    startedAt: '2026-10-01T10:00:00.000Z',
    finishedAt: '2026-10-01T10:05:00.000Z',
    report: 'done',
  };
  const reviewPass = {
    id: 'rev-1',
    parentChatId,
    assignment: 'review',
    executionMode: 'agent',
    status: 'completed',
    createdAt: '2026-10-01T10:06:00.000Z',
    startedAt: '2026-10-01T10:06:00.000Z',
    finishedAt: '2026-10-01T10:08:00.000Z',
    report: 'VERDICT: PASS',
    verifyResult: { status: 'passed' },
  };
  const cycles = buildDelegationQualityCycles({ rows: [implement, reviewPass], parentChatId });
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].acceptedByReview, true);
  assert.equal(cycles[0].qualityOutcome, 'accepted-by-review');
});

test('mixed sibling FAIL blocks accepted-by-review', () => {
  const parentChatId = 'parent-2';
  const implement = {
    id: 'impl-2',
    parentChatId,
    assignment: 'implement',
    status: 'completed',
    createdAt: '2026-10-01T11:00:00.000Z',
    finishedAt: '2026-10-01T11:05:00.000Z',
    report: 'done',
  };
  const pass = {
    id: 'rev-pass',
    parentChatId,
    assignment: 'review',
    status: 'completed',
    createdAt: '2026-10-01T11:06:00.000Z',
    finishedAt: '2026-10-01T11:07:00.000Z',
    report: 'VERDICT: PASS',
  };
  const fail = {
    id: 'rev-fail',
    parentChatId,
    assignment: 'review',
    status: 'completed',
    createdAt: '2026-10-01T11:06:30.000Z',
    finishedAt: '2026-10-01T11:08:00.000Z',
    report: 'VERDICT: FAIL',
  };
  const cycles = buildDelegationQualityCycles({ rows: [implement, pass, fail], parentChatId });
  assert.equal(cycles[0].acceptedByReview, false);
  assert.equal(cycles[0].qualityOutcome, 'rejected-by-review');
});

test('verify failure blocks accepted-by-review', () => {
  const parentChatId = 'parent-3';
  const implement = {
    id: 'impl-3',
    parentChatId,
    assignment: 'implement',
    status: 'completed',
    createdAt: '2026-10-01T12:00:00.000Z',
    finishedAt: '2026-10-01T12:05:00.000Z',
    report: 'done',
  };
  const review = {
    id: 'rev-3',
    parentChatId,
    assignment: 'review',
    status: 'completed',
    createdAt: '2026-10-01T12:06:00.000Z',
    finishedAt: '2026-10-01T12:08:00.000Z',
    report: 'VERDICT: PASS',
    verifyResult: { status: 'failed' },
  };
  const cycles = buildDelegationQualityCycles({ rows: [implement, review], parentChatId });
  assert.equal(cycles[0].acceptedByReview, false);
});

test('no review yields unreviewed cycle', () => {
  const parentChatId = 'parent-4';
  const implement = {
    id: 'impl-4',
    parentChatId,
    assignment: 'implement',
    status: 'completed',
    createdAt: '2026-10-01T13:00:00.000Z',
    finishedAt: '2026-10-01T13:05:00.000Z',
    report: 'done',
  };
  const cycles = buildDelegationQualityCycles({ rows: [implement], parentChatId });
  assert.equal(cycles[0].unreviewed, true);
  assert.equal(cycles[0].qualityOutcome, 'unreviewed');
});

test('zero accepted cycles yield null effective cost', () => {
  const parentChatId = 'parent-5';
  const implement = {
    id: 'impl-5',
    parentChatId,
    assignment: 'implement',
    status: 'completed',
    createdAt: '2026-10-01T14:00:00.000Z',
    finishedAt: '2026-10-01T14:05:00.000Z',
    report: 'done',
  };
  const cycles = buildDelegationQualityCycles({ rows: [implement], parentChatId });
  const metrics = summarizeDelegationCycleCostMetrics(cycles);
  assert.equal(metrics.acceptedCount, 0);
  assert.equal(metrics.effectiveCostPerAcceptedUsd, null);
});

test('fanout slots classify distinctly; audit candidates are not slots', () => {
  const file = tempPickFile();
  const fanout = persistModelPickProposal({
    role: 'review',
    chatId: 'chat-f',
    pickResult: {
      pick: { harness: 'a', model: 'm-a' },
      picks: [{ harness: 'a', model: 'm-a' }, { harness: 'b', model: 'm-b' }],
      candidates: [{ harness: 'c', model: 'm-c' }, { harness: 'd', model: 'm-d' }],
    },
    file,
  });
  const fanoutLink = classifyDelegationPickOrigin({
    pickId: fanout.pickId,
    harness: 'b',
    model: 'm-b',
    assignment: 'review',
    parentChatId: 'chat-f',
    file,
  });
  assert.equal(fanoutLink.originDetail, 'fanout');
  assert.equal(fanoutLink.selectionSlot, 1);

  const record = getModelPickRecord(fanout.pickId, { file });
  assert.equal(record.picks.length, 2, 'slots follow the explicit picks, not the candidate count');
  for (const candidate of ['m-c', 'm-d']) {
    const link = classifyDelegationPickOrigin({
      pickId: fanout.pickId,
      harness: candidate === 'm-c' ? 'c' : 'd',
      model: candidate,
      assignment: 'review',
      parentChatId: 'chat-f',
      file,
    });
    assert.equal(link.origin, 'unknown', `${candidate} is an audit candidate, not a pick`);
    assert.equal(link.linkStatus, 'rejected-link');
  }
  const nullSlots = record.candidates.filter((row) => row.selectionSlot == null);
  assert.ok(nullSlots.length >= 2, 'audit candidates keep a null slot (never 0)');
});

test('fanout is capped at five explicit picks; a sixth numeric slot cannot be minted', async () => {
  const file = tempPickFile();
  const sixPicks = [0, 1, 2, 3, 4, 5].map((i) => ({ harness: 'h', model: `m-${i}` }));
  const persisted = persistModelPickProposal({
    role: 'review',
    chatId: 'chat-cap',
    pickResult: {
      pick: sixPicks[0],
      picks: sixPicks,
      candidates: [{ harness: 'x', model: 'm-x' }],
    },
    file,
  });
  const record = getModelPickRecord(persisted.pickId, { file });
  assert.equal(record.picks.length, MODEL_PICK_MAX_SLOTS, 'never more than five slots, whatever the candidates');
  assert.ok(record.candidates.length <= MODEL_PICK_MAX_CANDIDATES, 'candidate set stays bounded');
  const sixth = classifyDelegationPickOrigin({
    pickId: persisted.pickId,
    harness: 'h',
    model: 'm-5',
    assignment: 'review',
    parentChatId: 'chat-cap',
    file,
  });
  assert.equal(sixth.linkStatus, 'rejected-link', 'the sixth pick is not a slot');
  for (let slot = 0; slot < MODEL_PICK_MAX_SLOTS; slot += 1) {
    const reserved = await reserveModelPickSlot({
      pickId: persisted.pickId, selectionSlot: slot, delegationId: `d-${slot}`, idempotencyKey: `k-${slot}`, file,
    });
    assert.equal(reserved.ok, true, `explicit slot ${slot} reserves`);
  }
  const overflow = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: MODEL_PICK_MAX_SLOTS, delegationId: 'd-overflow', idempotencyKey: 'k-overflow', file,
  });
  assert.equal(overflow.ok, false, 'a numeric slot beyond the explicit picks is refused');
  assert.equal(overflow.code, 'validation');
});

const PRIOR_ATTEMPT = {
  id: 'prior-1',
  parentChatId: 'chat-fb',
  leafId: 'leaf-1',
  executor: { transport: 'a', model: 'm-a' },
};

function fallbackPick(file) {
  return persistModelPickProposal({
    role: 'implement',
    chatId: 'chat-fb',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
}

test('fallback to another executor needs a real earlier attempt and gets its own slot', () => {
  const file = tempPickFile();
  const persisted = fallbackPick(file);
  const base = {
    pickId: persisted.pickId,
    harness: 'z',
    model: 'm-z',
    assignment: 'implement',
    executionMode: 'agent',
    parentChatId: 'chat-fb',
    leafId: 'leaf-1',
    pickFallbackFrom: 'prior-1',
    fallbackFromRecord: PRIOR_ATTEMPT,
    file,
  };
  const fields = resolveDelegationPickLinkFields(base);
  assert.equal(fields.pickOrigin, 'auto');
  assert.equal(fields.pickOriginDetail, 'fallback');
  assert.equal(fields.pickLinkStatus, 'linked');
  assert.equal(fields.selectionSlot, 'fallback:prior-1', 'own slot, never slot 0');
});

test('fake fallback claims are rejected-link, not auto', () => {
  const file = tempPickFile();
  const persisted = fallbackPick(file);
  const base = {
    pickId: persisted.pickId,
    harness: 'z',
    model: 'm-z',
    assignment: 'implement',
    parentChatId: 'chat-fb',
    leafId: 'leaf-1',
    pickFallbackFrom: 'prior-1',
    fallbackFromRecord: PRIOR_ATTEMPT,
    file,
  };
  const cases = {
    'arbitrary string, no record': { fallbackFromRecord: null, pickFallbackFrom: 'whatever' },
    'record id mismatch': { pickFallbackFrom: 'other-id' },
    'record of another chat': { fallbackFromRecord: { ...PRIOR_ATTEMPT, parentChatId: 'chat-x' } },
    'record of another leaf': { fallbackFromRecord: { ...PRIOR_ATTEMPT, leafId: 'leaf-2' } },
    'missing leaf on new start': { leafId: '' },
    'missing leaf on prior record': { fallbackFromRecord: { ...PRIOR_ATTEMPT, leafId: '' } },
    'same executor (no change)': { harness: 'a', model: 'm-a' },
  };
  for (const [label, override] of Object.entries(cases)) {
    const fields = resolveDelegationPickLinkFields({ ...base, ...override });
    assert.notEqual(fields.pickOrigin, 'auto', label);
    assert.equal(fields.pickLinkStatus, 'rejected-link', label);
    assert.equal(fields.selectionSlot, null, label);
  }
});

test('normalizeModelPickRecord: null pick selectionSlot uses index, never Number(null) as slot 0 twice', () => {
  const normalized = normalizeModelPickRecord({
    id: 'pick-null-slot',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    chatId: 'chat-1',
    workspaceFolder: '/tmp/ws',
    purpose: 'model_pick',
    role: 'implement',
    policyVersion: 'v1',
    picks: [
      { harness: 'a', model: 'm-a', selectionSlot: null },
      { harness: 'b', model: 'm-b', selectionSlot: null },
    ],
    candidates: [],
  });
  assert.ok(normalized);
  assert.equal(normalized.picks[0].selectionSlot, 0);
  assert.equal(normalized.picks[1].selectionSlot, 1, 'second null must not coerce to slot 0');
});

test('pick_id is bound to the proposing chat and workspace', () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    role: 'implement',
    chatId: 'chat-A',
    workspaceFolder: '/tmp/ws-a',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
  const ok = { pickId: persisted.pickId, harness: 'a', model: 'm-a', assignment: 'implement', file };
  assert.equal(classifyDelegationPickOrigin({ ...ok, parentChatId: 'chat-A', workspaceFolder: '/tmp/ws-a' }).origin, 'auto');
  assert.equal(classifyDelegationPickOrigin({ ...ok, parentChatId: 'chat-B', workspaceFolder: '/tmp/ws-a' }).linkStatus, 'rejected-link', 'cross-chat');
  assert.equal(classifyDelegationPickOrigin({ ...ok, parentChatId: 'chat-A', workspaceFolder: '/tmp/ws-b' }).linkStatus, 'rejected-link', 'cross-workspace');
  assert.equal(classifyDelegationPickOrigin({ ...ok }).linkStatus, 'rejected-link', 'no start context, no link');
});

test('manual_source is an allow-list: unknown free text is not manual', () => {
  for (const source of ['ui', 'settings-ui', 'USER', 'operator', 'manual', 'todo-assignee']) {
    assert.equal(classifyDelegationPickOrigin({ manualSource: source, assignment: 'implement' }).origin, 'manual', source);
  }
  for (const source of ['hacker', 'auto', 'selected', 'x'.repeat(40)]) {
    const link = classifyDelegationPickOrigin({ manualSource: source, assignment: 'implement' });
    assert.equal(link.origin, 'unknown', source);
    assert.equal(link.linkStatus, 'rejected-link', source);
  }
});

test('a missing slot never maps to slot 0 and auto needs an idempotency key', async () => {
  const file = tempPickFile();
  const persisted = fallbackPick(file);
  const noSlot = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: null, delegationId: 'd1', idempotencyKey: 'k1', file,
  });
  assert.equal(noSlot.ok, false);
  assert.equal(noSlot.code, 'validation');
  assert.deepEqual(getModelPickRecord(persisted.pickId, { file }).slots, {});
  const noKey = await finalizeDelegationPickSlotReservation({
    pickId: persisted.pickId, selectionSlot: 0, delegationId: 'd1', idempotencyKey: '', pickOrigin: 'auto', file,
  });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'idempotency_key_required');
  const noSlotAuto = await finalizeDelegationPickSlotReservation({
    pickId: persisted.pickId, selectionSlot: null, delegationId: 'd1', idempotencyKey: 'k', pickOrigin: 'auto', file,
  });
  assert.equal(noSlotAuto.ok, false);
  const released = await reserveModelPickSlot({
    pickId: persisted.pickId, selectionSlot: 'fallback:prior-1', delegationId: 'd2', idempotencyKey: 'k2', file,
  });
  assert.equal(released.ok, true);
  assert.equal(releaseModelPickSlotsForDelegation({ pickId: persisted.pickId, delegationId: 'd2', file }), true);
  assert.deepEqual(getModelPickRecord(persisted.pickId, { file }).slots, {});
});

test('two processes racing for one slot: exactly one wins and no update is lost', async () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    role: 'review',
    chatId: 'chat-race',
    pickResult: {
      pick: { harness: 'a', model: 'm-a' },
      picks: [0, 1, 2, 3].map((i) => ({ harness: 'a', model: `m-${i}` })),
    },
    file,
  });
  const worker = path.join(path.dirname(file), 'reserve-worker.mjs');
  const modulePath = new URL('../lib/persist/model-pick-decisions-persist.js', import.meta.url).href;
  fs.writeFileSync(worker, `
    import { reserveModelPickSlot } from ${JSON.stringify(modulePath)};
    const [file, pickId, tag] = process.argv.slice(2);
    const out = [];
    for (let round = 0; round < 15; round += 1) {
      // Everyone fights for slot 0 (one winner) and owns one private slot.
      const shared = await reserveModelPickSlot({ pickId, selectionSlot: 0, delegationId: 'd-' + tag + '-' + round, idempotencyKey: 'k-' + tag, file });
      out.push(shared.ok ? (shared.replay ? 'replay' : 'won') : shared.code);
    }
    const own = await reserveModelPickSlot({ pickId, selectionSlot: 'fallback:' + tag, delegationId: 'own-' + tag, idempotencyKey: 'own-' + tag, file });
    console.log(JSON.stringify({ tag, out, own: own.ok }));
  `);
  const run = (tag) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', worker, file, persisted.pickId, tag], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(stdout.trim().split('\n').pop())) : reject(new Error(`worker ${tag} exited ${code}`))));
  });
  const results = await Promise.all(['p1', 'p2', 'p3', 'p4'].map(run));
  const winners = results.filter((r) => r.out.includes('won'));
  assert.equal(winners.length, 1, 'exactly one process reserved slot 0');
  assert.ok(results.every((r) => r.own === true), 'every private slot was reserved');
  const slots = getModelPickRecord(persisted.pickId, { file }).slots;
  assert.equal(Object.keys(slots).length, 5, 'slot 0 plus four private slots: no lost update');
  assert.ok(slots['0'].idempotencyKey.startsWith('k-'));
});

test('resolveDelegationPickLinkFields legacy without pick_id', () => {
  const fields = resolveDelegationPickLinkFields({ assignment: 'implement', harness: 'a', model: 'm' });
  assert.equal(fields.pickOrigin, 'unknown');
  assert.equal(fields.pickOriginDetail, 'legacy');
});

test('explicit fix role links to a fix pick and is persisted on the link fields', () => {
  const file = tempPickFile();
  const persisted = persistModelPickProposal({
    role: 'fix',
    chatId: 'chat-fix',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
  const fields = resolveDelegationPickLinkFields({
    pickId: persisted.pickId,
    harness: 'a',
    model: 'm-a',
    assignment: 'implement',
    executionMode: 'agent',
    role: 'fix',
    parentChatId: 'chat-fix',
    file,
  });
  assert.equal(fields.pickRole, 'fix');
  assert.equal(fields.pickOrigin, 'auto');
});

test('a pick without a start only raises proposals, not executed counters', () => {
  const file = tempPickFile();
  persistModelPickProposal({
    role: 'implement',
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
  const counters = summarizeModelPickExecutionCounters([], { file });
  assert.equal(counters.proposals, 1);
  assert.equal(counters.executedAuto, 0);
  assert.equal(counters.executedManual, 0);
  assert.equal(counters.executedUnknown, 0);
  assert.equal(counters.runs, 0);
  assert.equal(counters.cycles, null, 'missing cycle denominator stays null, not a guessed 0');
});

test('origin counters partition runs into auto/manual/unknown', () => {
  const counters = summarizeModelPickExecutionCounters(
    [{ pickOrigin: 'auto' }, { pickOrigin: 'manual' }, { pickOrigin: '' }],
    { loadPicks: () => ({}) },
  );
  assert.equal(counters.proposals, 0);
  assert.equal(counters.executedAuto, 1);
  assert.equal(counters.executedManual, 1);
  assert.equal(counters.executedUnknown, 1);
  assert.equal(counters.runs, 3);
  assert.deepEqual(counters.originDetails, { none: 3 });
});

test('originDetails keep fallback/alternate visible per link detail', () => {
  const counters = summarizeModelPickExecutionCounters(
    [
      { pickOrigin: 'auto', pickOriginDetail: 'selected' },
      { pickOrigin: 'auto', pickOriginDetail: 'fallback' },
      { pickOrigin: 'auto', pickOriginDetail: 'alternate' },
      { pickOrigin: 'auto', pickOriginDetail: 'fanout' },
    ],
    { loadPicks: () => ({}) },
  );
  assert.deepEqual(counters.originDetails, {
    selected: 1,
    fallback: 1,
    alternate: 1,
    fanout: 1,
  });
});

test('an unreadable proposal store reports proposals=null, never zero', () => {
  const counters = summarizeModelPickExecutionCounters([], {
    loadPicks: () => { throw new Error('store down'); },
  });
  assert.equal(counters.proposals, null);
});

test('unclaimed picks are purged after 30 days retention', () => {
  const file = tempPickFile();
  const now = Date.now();
  const persisted = persistModelPickProposal({
    role: 'implement',
    now,
    pickResult: { pick: { harness: 'a', model: 'm-a' }, picks: [{ harness: 'a', model: 'm-a' }] },
    file,
  });
  purgeStaleModelPickRecords({ file, now: now + MODEL_PICK_RETENTION_MS + 1000 });
  assert.equal(getModelPickRecord(persisted.pickId, { file }), null, 'an unclaimed proposal past retention is dropped');
});

test('decision journal never stores prompt content', () => {
  const file = tempPickFile();
  const secret = 'PROMPT-SECRET-do-not-persist';
  persistModelPickProposal({
    role: 'implement',
    purpose: 'model_pick',
    chatId: 'chat-prompt',
    pickResult: {
      pick: { harness: 'a', model: 'm-a', reason: secret },
      picks: [{ harness: 'a', model: 'm-a', reason: secret }],
      candidates: [{ harness: 'b', model: 'm-b', reason: secret }],
      prompt: secret,
    },
    file,
  });
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes(secret), false, 'no prompt/reason text reaches the decision journal');
});
