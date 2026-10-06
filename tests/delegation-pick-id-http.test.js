/**
 * Stage 4 (5af7d7aa): HTTP `delegation_start` with an optional `pick_id`.
 *
 * Registers the real delegation routes on a tiny fake express app and starts
 * jobs through the mock chat-run adapter, so the link classification, slot
 * reservation and idempotent replay are exercised end to end without a browser.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addChat } from '../lib/persist/chats-persist.js';
import { getDelegationById, listDelegationsForParent, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { saveSettings } from '../lib/persist/settings.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { getModelPickRecord } from '../lib/persist/model-pick-decisions-persist.js';
import { MODEL_PICK_TTL_MS } from '../lib/model-pick-policy.js';
import {
  registerMockChatRunAdapter,
  resetMockChatRuns,
} from '../lib/chat-run/mock-adapter.js';

resetMockChatRuns();
registerMockChatRunAdapter('opencode');
registerMockChatRunAdapter('codebuddy');

const workspace = ISOLATED_DATA_DIR;

const routes = new Map();
registerDelegationsRoutes({
  get: (p, fn) => routes.set(`GET ${p}`, fn),
  post: (p, fn) => routes.set(`POST ${p}`, fn),
}, { workspaceDirForAgent: () => workspace });

async function invoke(method, route, req = {}) {
  let status = 200;
  let body;
  const res = {
    status(code) { status = code; return this; },
    json(payload) { body = payload; return this; },
  };
  await routes.get(`${method} ${route}`)({ params: {}, query: {}, body: {}, ...req }, res);
  return { status, body };
}

let parentSeq = 0;
function makeParent() {
  parentSeq += 1;
  return addChat(randomUUID(), `pick-parent-${parentSeq}`, null, workspace, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
}

function startBody(parent, pickId, extra = {}) {
  return {
    executor: { transport: 'opencode', model: 'opencode/test' },
    sourceKind: 'text',
    taskText: 'Implement the change and report the diff.',
    executionMode: 'agent',
    assignment: 'implement',
    idempotencyKey: randomUUID(),
    pickId,
    ...extra,
  };
}

// A mutating job holds the workspace; terminalize each scenario before the
// next start so the width/workspace gates do not leak between assertions.
function finish(delegationId) {
  updateDelegationRecord(delegationId, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    report: 'TASK: implement\nVERDICT: PASS',
  });
}

// --- Valid pick_id: auto / selected + slot reservation ------------------------
const parent1 = makeParent();
const pick1 = persistModelPickProposal({
  chatId: parent1.id,
  workspaceFolder: workspace,
  role: 'implement',
  chatId: parent1.id,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const validBody = startBody(parent1, pick1.pickId);
const started = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent1.id },
  body: validBody,
});
assert.equal(started.status, 201, JSON.stringify(started.body));
assert.equal(started.body.ok, true);
assert.equal(started.body.delegation.pickOrigin, 'auto');
assert.equal(started.body.delegation.pickOriginDetail, 'selected');
assert.equal(started.body.delegation.pickLinkStatus, 'linked');
assert.equal(started.body.delegation.pickId, pick1.pickId);
const reserved = getModelPickRecord(pick1.pickId);
assert.equal(reserved.slots['0'].delegationId, started.body.delegation.id);

// Idempotent replay of the same start must not create a second delegation and
// must not re-reserve the slot with a new key.
const replay = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent1.id },
  body: validBody,
});
assert.equal(replay.status, 200, 'the replay is acknowledged without a new job');
assert.equal(replay.body.replayed, true);
assert.equal(replay.body.delegation.id, started.body.delegation.id, 'same idempotency key replays');
finish(started.body.delegation.id);

// --- Expired pick_id: unknown / rejected-link, start still allowed ------------
const parent2 = makeParent();
const expired = persistModelPickProposal({
  chatId: parent2.id,
  workspaceFolder: workspace,
  role: 'implement',
  now: Date.now() - MODEL_PICK_TTL_MS - 60_000,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const expiredStart = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent2.id },
  body: startBody(parent2, expired.pickId),
});
assert.equal(expiredStart.status, 201, JSON.stringify(expiredStart.body));
assert.equal(expiredStart.body.delegation.pickOrigin, 'unknown');
assert.equal(expiredStart.body.delegation.pickOriginDetail, 'rejected-link');
assert.equal(expiredStart.body.delegation.pickLinkStatus, 'rejected-link');
finish(expiredStart.body.delegation.id);

// --- Wrong model for the pick: rejected-link, eligibility untouched -----------
const parent3 = makeParent();
const pick3 = persistModelPickProposal({
  chatId: parent3.id,
  workspaceFolder: workspace,
  role: 'implement',
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const wrongModel = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent3.id },
  body: startBody(parent3, pick3.pickId, {
    executor: { transport: 'opencode', model: 'opencode/other' },
  }),
});
assert.equal(wrongModel.status, 201);
assert.equal(wrongModel.body.delegation.pickOrigin, 'unknown');
assert.equal(wrongModel.body.delegation.pickLinkStatus, 'rejected-link');
finish(wrongModel.body.delegation.id);

// --- Wrong role for the pick: rejected-link -----------------------------------
const parent4 = makeParent();
const reviewPick = persistModelPickProposal({
  chatId: parent4.id,
  workspaceFolder: workspace,
  role: 'review',
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const roleMismatch = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent4.id },
  body: startBody(parent4, reviewPick.pickId),
});
assert.equal(roleMismatch.status, 201);
assert.equal(roleMismatch.body.delegation.pickLinkStatus, 'rejected-link');
assert.equal(roleMismatch.body.delegation.pickOriginDetail, 'rejected-link');
finish(roleMismatch.body.delegation.id);

// --- Unknown pick_id: unknown / rejected-link ---------------------------------
const parent5 = makeParent();
const unknown = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent5.id },
  body: startBody(parent5, 'pick-does-not-exist'),
});
assert.equal(unknown.status, 201);
assert.equal(unknown.body.delegation.pickOrigin, 'unknown');
assert.equal(unknown.body.delegation.pickOriginDetail, 'rejected-link');
finish(unknown.body.delegation.id);

// --- Fallback: a real earlier attempt on another executor, with its own slot --
// normalizeTodoRefId accepts hex todo ids only; arbitrary slugs are dropped.
const FALLBACK_LEAF = 'cafef00dcafebabe';
const parent6 = makeParent();
const fallbackPick = persistModelPickProposal({
  role: 'implement',
  chatId: parent6.id,
  workspaceFolder: workspace,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const firstAttempt = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent6.id },
  body: startBody(parent6, fallbackPick.pickId, { leafId: FALLBACK_LEAF }),
});
assert.equal(firstAttempt.status, 201, JSON.stringify(firstAttempt.body));
assert.equal(firstAttempt.body.delegation.pickOriginDetail, 'selected');
updateDelegationRecord(firstAttempt.body.delegation.id, {
  status: 'failed',
  finishedAt: new Date().toISOString(),
  error: 'usage limit',
});
const fallbackBody = startBody(parent6, fallbackPick.pickId, {
  executor: { transport: 'codebuddy', model: 'hy3' },
  pickFallbackFrom: firstAttempt.body.delegation.id,
  leafId: FALLBACK_LEAF,
});
const fallbackStart = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent6.id },
  body: fallbackBody,
});
assert.equal(fallbackStart.status, 201, JSON.stringify(fallbackStart.body));
assert.equal(fallbackStart.body.delegation.pickOrigin, 'auto');
assert.equal(fallbackStart.body.delegation.pickOriginDetail, 'fallback');
assert.equal(fallbackStart.body.delegation.pickLinkStatus, 'linked');
assert.equal(fallbackStart.body.delegation.executor.transport, 'codebuddy');
assert.ok(fallbackStart.body.delegation.attemptId, 'the fallback job has its own attempt');
assert.notEqual(
  fallbackStart.body.delegation.attemptId,
  firstAttempt.body.delegation.attemptId,
  'the fallback executor change is a fresh attempt, not a silent reuse',
);
assert.notEqual(fallbackStart.body.delegation.id, firstAttempt.body.delegation.id, 'fallback is its own job');
assert.ok(getDelegationById(fallbackStart.body.delegation.id), 'fallback job is persisted');
const fallbackSlots = getModelPickRecord(fallbackPick.pickId).slots;
assert.equal(fallbackSlots['0'].delegationId, firstAttempt.body.delegation.id, 'slot 0 stays with the first attempt');
assert.equal(
  fallbackSlots[`fallback:${firstAttempt.body.delegation.id}`].delegationId,
  fallbackStart.body.delegation.id,
  'the fallback reserves its own slot, never aliasing slot 0',
);
finish(fallbackStart.body.delegation.id);

// A second fallback from the same earlier attempt with a new key is refused
// and leaves no extra row behind.
const rowsBeforeDup = listDelegationsForParent(parent6.id).length;
const dupFallback = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent6.id },
  body: startBody(parent6, fallbackPick.pickId, {
    executor: { transport: 'codebuddy', model: 'hy3' },
    pickFallbackFrom: firstAttempt.body.delegation.id,
    leafId: FALLBACK_LEAF,
  }),
});
assert.equal(dupFallback.status, 409, JSON.stringify(dupFallback.body));
assert.equal(dupFallback.body.code, 'slot_taken');
assert.equal(listDelegationsForParent(parent6.id).length, rowsBeforeDup, 'a refused reservation leaves no orphan row');

// --- Fallback leaf mismatch: same parent chat but leafId must match -------------
const parentLeafMismatch = makeParent();
const leafMismatchPick = persistModelPickProposal({
  role: 'implement',
  chatId: parentLeafMismatch.id,
  workspaceFolder: workspace,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const priorLeafA = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentLeafMismatch.id },
  body: startBody(parentLeafMismatch, leafMismatchPick.pickId, { leafId: 'deadbeef00000001' }),
});
assert.equal(priorLeafA.status, 201, JSON.stringify(priorLeafA.body));
updateDelegationRecord(priorLeafA.body.delegation.id, {
  status: 'failed',
  finishedAt: new Date().toISOString(),
  error: 'transient',
});
const leafMismatchFallback = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentLeafMismatch.id },
  body: startBody(parentLeafMismatch, leafMismatchPick.pickId, {
    executor: { transport: 'codebuddy', model: 'hy3' },
    pickFallbackFrom: priorLeafA.body.delegation.id,
    leafId: 'deadbeef00000002',
  }),
});
assert.equal(leafMismatchFallback.status, 201, JSON.stringify(leafMismatchFallback.body));
assert.equal(
  leafMismatchFallback.body.delegation.pickOrigin,
  'unknown',
  'fallback requires matching leafId on both attempts',
);
assert.equal(leafMismatchFallback.body.delegation.pickLinkStatus, 'rejected-link');
assert.equal(
  getModelPickRecord(leafMismatchPick.pickId).slots[`fallback:${priorLeafA.body.delegation.id}`],
  undefined,
  'invalid fallback must not reserve a fallback slot',
);
finish(leafMismatchFallback.body.delegation.id);

const parentLeafMissing = makeParent();
const leafMissingPick = persistModelPickProposal({
  role: 'implement',
  chatId: parentLeafMissing.id,
  workspaceFolder: workspace,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const priorNoLeaf = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentLeafMissing.id },
  body: startBody(parentLeafMissing, leafMissingPick.pickId),
});
assert.equal(priorNoLeaf.status, 201, JSON.stringify(priorNoLeaf.body));
updateDelegationRecord(priorNoLeaf.body.delegation.id, {
  status: 'failed',
  finishedAt: new Date().toISOString(),
  error: 'transient',
});
const leafMissingFallback = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentLeafMissing.id },
  body: startBody(parentLeafMissing, leafMissingPick.pickId, {
    executor: { transport: 'codebuddy', model: 'hy3' },
    pickFallbackFrom: priorNoLeaf.body.delegation.id,
    leafId: FALLBACK_LEAF,
  }),
});
assert.equal(leafMissingFallback.status, 201, JSON.stringify(leafMissingFallback.body));
assert.equal(
  leafMissingFallback.body.delegation.pickOrigin,
  'unknown',
  'prior attempt without leafId cannot back a leaf-scoped fallback',
);
assert.equal(leafMissingFallback.body.delegation.pickLinkStatus, 'rejected-link');
assert.equal(
  getModelPickRecord(leafMissingPick.pickId).slots[`fallback:${priorNoLeaf.body.delegation.id}`],
  undefined,
  'missing leaf on prior attempt must not get a fallback slot',
);
finish(leafMissingFallback.body.delegation.id);

// --- Fake fallback claims are rejected-link, never auto -----------------------
for (const [label, fromId, executor] of [
  ['unknown id', 'delegation-does-not-exist', { transport: 'codebuddy', model: 'hy3' }],
  ['arbitrary text', 'whatever', { transport: 'codebuddy', model: 'hy3' }],
  ['pick id instead of delegation', fallbackPick.pickId, { transport: 'codebuddy', model: 'hy3' }],
  ['same executor', firstAttempt.body.delegation.id, { transport: 'opencode', model: 'opencode/test' }],
]) {
  const fakeParent = makeParent();
  const fakePick = persistModelPickProposal({
    role: 'implement',
    chatId: fakeParent.id,
    workspaceFolder: workspace,
    pickResult: {
      pick: { harness: 'opencode', model: 'opencode/test' },
      picks: [{ harness: 'opencode', model: 'opencode/test' }],
    },
  });
  const fake = await invoke('POST', '/api/chats/:id/delegations', {
    params: { id: fakeParent.id },
    body: startBody(fakeParent, fakePick.pickId, { executor, pickFallbackFrom: fromId }),
  });
  assert.equal(fake.status, 201, `${label}: ${JSON.stringify(fake.body)}`);
  assert.equal(fake.body.delegation.pickOrigin, 'unknown', `${label} must not be auto`);
  assert.equal(fake.body.delegation.pickLinkStatus, 'rejected-link', label);
  assert.equal(getModelPickRecord(fakePick.pickId).slots['0'], undefined, `${label}: no slot consumed`);
  finish(fake.body.delegation.id);
}

// --- pick_id is bound to the chat and workspace that proposed it --------------
const parentOwner = makeParent();
const parentOther = makeParent();
const boundPick = persistModelPickProposal({
  role: 'implement',
  chatId: parentOwner.id,
  workspaceFolder: workspace,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const crossChat = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentOther.id },
  body: startBody(parentOther, boundPick.pickId),
});
assert.equal(crossChat.status, 201, JSON.stringify(crossChat.body));
assert.equal(crossChat.body.delegation.pickOrigin, 'unknown', 'a pick from chat A cannot back a start in chat B');
assert.equal(crossChat.body.delegation.pickLinkStatus, 'rejected-link');
assert.equal(getModelPickRecord(boundPick.pickId).slots['0'], undefined);
finish(crossChat.body.delegation.id);
const parentForeignWs = makeParent();
const foreignWsPick = persistModelPickProposal({
  role: 'implement',
  chatId: parentForeignWs.id,
  workspaceFolder: '/some/other/workspace',
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const crossWs = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentForeignWs.id },
  body: startBody(parentForeignWs, foreignWsPick.pickId),
});
assert.equal(crossWs.status, 201, JSON.stringify(crossWs.body));
assert.equal(crossWs.body.delegation.pickOrigin, 'unknown', 'a pick from another workspace is rejected');
finish(crossWs.body.delegation.id);

// --- manual_source is an allow-list, not free text ----------------------------
const parentManual = makeParent();
const manualBad = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentManual.id },
  body: startBody(parentManual, '', { manualSource: 'totally-made-up' }),
});
assert.equal(manualBad.status, 201, JSON.stringify(manualBad.body));
assert.equal(manualBad.body.delegation.pickOrigin, 'unknown');
assert.equal(manualBad.body.delegation.pickLinkStatus, 'rejected-link');
finish(manualBad.body.delegation.id);
const manualOk = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentManual.id },
  body: startBody(parentManual, '', { manualSource: 'ui' }),
});
assert.equal(manualOk.status, 201, JSON.stringify(manualOk.body));
assert.equal(manualOk.body.delegation.pickOrigin, 'manual');
assert.equal(manualOk.body.delegation.pickOriginDetail, 'ui');
finish(manualOk.body.delegation.id);

// --- pick_id without idempotency_key is refused; slot reuse is bounded --------
const parentKey = makeParent();
const keyPick = persistModelPickProposal({
  role: 'implement',
  chatId: parentKey.id,
  workspaceFolder: workspace,
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
    candidates: [{ harness: 'opencode', model: 'opencode/extra' }],
  },
});
const noKey = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentKey.id },
  body: startBody(parentKey, keyPick.pickId, { idempotencyKey: '' }),
});
assert.equal(noKey.status, 400, JSON.stringify(noKey.body));
assert.equal(noKey.body.code, 'idempotency_key_required');
assert.equal(listDelegationsForParent(parentKey.id).length, 0, 'no row without a key');
const keyed = startBody(parentKey, keyPick.pickId);
const keyedStart = await invoke('POST', '/api/chats/:id/delegations', { params: { id: parentKey.id }, body: keyed });
assert.equal(keyedStart.status, 201, JSON.stringify(keyedStart.body));
assert.equal(keyedStart.body.delegation.pickOrigin, 'auto');
const keyedReplay = await invoke('POST', '/api/chats/:id/delegations', { params: { id: parentKey.id }, body: keyed });
assert.equal(keyedReplay.body.replayed, true, 'the repeated key replays');
assert.equal(listDelegationsForParent(parentKey.id).length, 1, 'replay creates no second row');
finish(keyedStart.body.delegation.id);
// Same pick, new key: slot already used -> refused, no orphan row.
const reuse = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentKey.id },
  body: startBody(parentKey, keyPick.pickId),
});
assert.equal(reuse.status, 409, JSON.stringify(reuse.body));
assert.equal(reuse.body.code, 'slot_taken');
assert.equal(listDelegationsForParent(parentKey.id).length, 1, 'a refused reservation leaves no queued orphan');
// An audit-only candidate is not a pick: it cannot be matched into a start.
const candidateStart = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parentKey.id },
  body: startBody(parentKey, keyPick.pickId, { executor: { transport: 'opencode', model: 'opencode/extra' } }),
});
assert.notEqual(candidateStart.body?.delegation?.pickOrigin, 'auto', 'candidates beyond picks never link as auto');
if (candidateStart.body?.delegation) finish(candidateStart.body.delegation.id);

// --- Missing pick_id (legacy) stays unknown -----------------------------------
const parent7 = makeParent();
const legacy = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent7.id },
  body: startBody(parent7, ''),
});
assert.equal(legacy.status, 201);
assert.equal(legacy.body.delegation.pickOrigin, 'unknown');
assert.equal(legacy.body.delegation.pickOriginDetail, 'legacy');
finish(legacy.body.delegation.id);

// --- A real fix role is persisted explicitly (not flattened to implement) -----
const parent8fix = makeParent();
const fixPick = persistModelPickProposal({
  chatId: parent8fix.id,
  workspaceFolder: workspace,
  role: 'fix',
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/test' },
    picks: [{ harness: 'opencode', model: 'opencode/test' }],
  },
});
const fixStart = await invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent8fix.id },
  body: startBody(parent8fix, fixPick.pickId, { assignment: 'fix' }),
});
assert.equal(fixStart.status, 201, JSON.stringify(fixStart.body));
assert.equal(fixStart.body.delegation.pickRole, 'fix', 'the requested fix role survives normalization');
assert.equal(fixStart.body.delegation.assignment, 'implement', 'legacy assignment stays the shared implement bucket');
assert.equal(fixStart.body.delegation.pickOrigin, 'auto');
assert.equal(getDelegationById(fixStart.body.delegation.id).pickRole, 'fix', 'fix role is persisted');
finish(fixStart.body.delegation.id);

// --- Stats counters expose separate proposals/executed/manual/unknown/cycles --
const stats = await invoke('GET', '/api/delegations/stats', {
  query: { workspaceFolder: workspace },
});
assert.equal(stats.status, 200);
const pickExecution = stats.body.pick_execution;
assert.ok(pickExecution && typeof pickExecution === 'object');
for (const key of ['proposals', 'executedAuto', 'executedManual', 'executedUnknown', 'runs', 'cycles']) {
  assert.ok(Object.hasOwn(pickExecution, key), `pick_execution.${key} present`);
}
assert.equal(
  pickExecution.runs,
  pickExecution.executedAuto + pickExecution.executedManual + pickExecution.executedUnknown,
  'runs partition into disjoint origin counters',
);
assert.ok(pickExecution.proposals >= 1, 'persisted proposals are counted');
assert.ok(pickExecution.executedAuto >= 1, 'auto executions are counted separately');
assert.ok(pickExecution.executedUnknown >= 1, 'unknown executions are counted separately');
assert.equal(typeof pickExecution.cycles, 'number');
assert.ok(pickExecution.originDetails && typeof pickExecution.originDetails === 'object');
assert.ok(pickExecution.originDetails.selected >= 1, 'selected link visible in stats');
assert.ok(pickExecution.originDetails.fallback >= 1, 'fallback link visible in stats');
assert.ok(pickExecution.originDetails['rejected-link'] >= 1, 'rejected links visible in stats');
assert.ok(pickExecution.originDetails.legacy >= 1, 'legacy starts visible in stats');
const cycleCost = stats.body.cycle_cost;
assert.ok(cycleCost && typeof cycleCost === 'object');
for (const key of ['acceptedCount', 'manualAcceptedCount', 'rejectedCount', 'closedCycleCount', 'openCycleCount', 'undecidedCount', 'unreviewedCount', 'denominators']) {
  assert.ok(Object.hasOwn(cycleCost, key), `cycle_cost.${key} present`);
}

// --- A pick_id never bypasses model eligibility -------------------------------
const parent8 = makeParent();
const eligiblePick = persistModelPickProposal({
  chatId: parent8.id,
  workspaceFolder: workspace,
  role: 'implement',
  pickResult: {
    pick: { harness: 'opencode', model: 'opencode/blocked-xyz' },
    picks: [{ harness: 'opencode', model: 'opencode/blocked-xyz' }],
  },
});
saveSettings({ opencodeChatEnabledModels: ['opencode/test'] });
process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'deny';
try {
  const blocked = await invoke('POST', '/api/chats/:id/delegations', {
    params: { id: parent8.id },
    body: startBody(parent8, eligiblePick.pickId, {
      executor: { transport: 'opencode', model: 'opencode/blocked-xyz' },
    }),
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.code, 'model_unavailable', 'a matching pick still cannot start an ineligible model');
  assert.equal(blocked.body.delegation, undefined, 'no job is created for an ineligible model');
  assert.equal(
    getModelPickRecord(eligiblePick.pickId).slots['0'],
    undefined,
    'the pick slot is not consumed when the start gate fails',
  );
} finally {
  process.env.CRETLI_DELEGATION_EMPTY_FAVORITES = 'all';
  saveSettings({});
}

removeIsolatedDataDir();
console.log('delegation-pick-id-http.test.js OK');
