/**
 * Plan A (5a7ead50): failure classification / lockout scope+expiry, trusted
 * automatic-start provenance, single-use UI action proof, continuation and the
 * exclusive-slot fallback. Runs on the real routes with the mock chat adapter.
 */
import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createStartupLockoutWorkspacePair } from './helpers/startup-lockout-fixture.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { getDelegationById, updateDelegationRecord } from '../lib/persist/delegations-persist.js';
import { registerDelegationsRoutes } from '../lib/routes/delegations-routes.js';
import { persistModelPickProposal } from '../lib/model-pick-decisions.js';
import { MODEL_PICK_TTL_MS } from '../lib/model-pick-policy.js';
import { registerMockChatRunAdapter, resetMockChatRuns } from '../lib/chat-run/mock-adapter.ts';
import { createSession, __reloadSessionsFromDiskForTest } from '../lib/auth.js';
import fs from 'node:fs';
import vm from 'node:vm';
import { writeChatPlanFile } from '../lib/chat-plan-persist.js';
import { pickModelForPurpose } from '../lib/model-pick-service.js';
import { classifyDelegationFailure } from '../lib/delegation-failure-class.js';
import { readTodoPanelSource } from './helpers/todoPanelSource.js';
import {
  clearHarnessStartupFailureLockout,
  describeHarnessLockoutRow,
  getHarnessUsageLimit,
  noteHarnessStartupFailureLockout,
  noteHarnessUsageLimit,
  noteDelegationFailureLockout,
  listHarnessUsageLimitsForWorkspace,
} from '../lib/harness-usage-limits.js';
import {
  DELEGATION_START_CONTEXTS,
  markDelegationAutomaticController,
  mintDelegationUiAction,
  consumeDelegationUiAction,
  resolveDelegationStartContext,
} from '../lib/delegation-start-context.js';

resetMockChatRuns();
registerMockChatRunAdapter('testfake');
registerMockChatRunAdapter('codebuddy');

const workspace = ISOLATED_DATA_DIR;
const HOUR = 60 * 60 * 1000;

// --- A1: classification ------------------------------------------------------
const classify = (error) => classifyDelegationFailure({ error, status: 'failed' });
assert.equal(classify('Transport not started').failureClass, 'transient_transport');
assert.equal(classify('OpenCode prompt first event timed out').scope, 'workspace+model');
assert.equal(
  classify('Codex rejected the request. The selected model may not be available on this ChatGPT account.').failureClass,
  'model_unavailable',
);
assert.equal(classify('Insufficient Balance').scope, 'harness');
assert.equal(classify('usage limit reached').failureClass, 'quota');
assert.equal(classify('401 Unauthorized').failureClass, 'auth');
assert.equal(classify('something odd happened').failureClass, 'unknown');
assert.equal(classify('something odd happened').scope, 'none', 'unknown never justifies an exclusion');

// --- A1/A2: model rejection keeps siblings; expiry; success clears only startup
const dataDir = ISOLATED_DATA_DIR;
noteHarnessUsageLimit({
  harness: 'codex',
  model: 'gpt-alpha',
  message: 'Codex rejected the request. The selected model may not be available on this ChatGPT account.',
  dataDir,
});
const rejected = getHarnessUsageLimit({ harness: 'codex', model: 'gpt-alpha', dataDir, usageOnly: true });
assert.ok(rejected, 'the rejected model is excluded');
assert.equal(describeHarnessLockoutRow(rejected).scope, 'model');
assert.equal(describeHarnessLockoutRow(rejected).failureClass, 'model_unavailable');
assert.ok(describeHarnessLockoutRow(rejected).expiresAt, 'exclusion carries an expiry');
assert.equal(
  getHarnessUsageLimit({ harness: 'codex', model: 'gpt-beta', dataDir, usageOnly: true }),
  null,
  'a sibling model of the same harness stays eligible',
);

// A real credit exhaustion is the one harness-wide class: every model of that
// harness is blocked, but another harness stays eligible. (A harness neither
// used nor locked elsewhere in this shared store keeps the assertion isolated.)
noteHarnessUsageLimit({ harness: 'zai', model: 'glm-test', message: 'Insufficient Balance', dataDir });
const balanceRow = getHarnessUsageLimit({ harness: 'zai', model: 'other-model', dataDir, usageOnly: true });
assert.ok(balanceRow, 'credit exhaustion locks the whole harness');
assert.equal(describeHarnessLockoutRow(balanceRow).scope, 'harness');
assert.equal(
  getHarnessUsageLimit({ harness: 'testfake', model: 'testfake/test', dataDir, usageOnly: true }),
  null,
  'a harness-wide quota never reaches another harness',
);

const { wsA, wsB } = createStartupLockoutWorkspacePair();
const base = { harness: 'testfake', model: 'testfake/lock', dataDir };
assert.equal(noteHarnessStartupFailureLockout({ ...base, workspaceFolder: wsA }), true);
const startupRow = getHarnessUsageLimit({ ...base, workspaceFolder: wsA });
assert.equal(describeHarnessLockoutRow(startupRow).failureClass, 'transient_transport');
assert.equal(describeHarnessLockoutRow(startupRow).scope, 'workspace+model');
assert.ok(
  Date.parse(startupRow.resetAt) - Date.now() <= 2 * HOUR + 1000,
  'first startup failure keeps the 2h default',
);
assert.equal(getHarnessUsageLimit({ ...base, workspaceFolder: wsB }), null, 'other workspace unaffected');
assert.equal(
  getHarnessUsageLimit({ ...base, model: 'testfake/lock-sibling', workspaceFolder: wsA }),
  null,
  'sibling model unaffected',
);
// A repeat inside the escalation window uses the 12h default.
assert.equal(noteHarnessStartupFailureLockout({ ...base, workspaceFolder: wsA }), true);
assert.ok(
  Date.parse(getHarnessUsageLimit({ ...base, workspaceFolder: wsA }).resetAt) - Date.now() > 11 * HOUR,
  'repeated failure keeps the 12h default',
);
// Fake clock: a lockout recorded long ago has already expired and stops excluding.
const wsExpired = createStartupLockoutWorkspacePair().wsA;
noteHarnessStartupFailureLockout({
  harness: 'testfake', model: 'testfake/old', dataDir, workspaceFolder: wsExpired, now: Date.now() - 3 * HOUR,
});
assert.equal(
  getHarnessUsageLimit({ harness: 'testfake', model: 'testfake/old', dataDir, workspaceFolder: wsExpired }),
  null,
  'expired startup lockout no longer excludes',
);
// Success clears only the matching startup lockout, never quota.
noteHarnessUsageLimit({ harness: 'testfake', model: 'testfake/lock', message: 'usage limit reached', dataDir });
clearHarnessStartupFailureLockout({ ...base, workspaceFolder: wsA });
const afterClear = getHarnessUsageLimit({ ...base, workspaceFolder: wsA });
assert.ok(afterClear && afterClear.code !== 'startup_failure', 'the quota restriction survives a success');

// Structured auth/outage evidence affects the real picker store and survives success.
for (const [harness, error, failureClass] of [
  ['auth-test', '401 Unauthorized', 'auth'],
  ['outage-test', 'harness is unavailable', 'harness_outage'],
]) {
  assert.equal(noteDelegationFailureLockout({ harness, model: 'm', error, workspaceFolder: wsA, dataDir }), true);
  const row = getHarnessUsageLimit({ harness, model: 'sibling', workspaceFolder: wsA, dataDir });
  assert.equal(row.failureClass, failureClass);
  assert.equal(getHarnessUsageLimit({ harness, model: 'sibling', workspaceFolder: wsB, dataDir }), null);
  clearHarnessStartupFailureLockout({ harness, model: 'm', workspaceFolder: wsA, dataDir });
  assert.ok(getHarnessUsageLimit({ harness, model: 'm', workspaceFolder: wsA, dataDir }));
}
for (const noise of ['bash: x: command not found', 'line 401 of the log', 'spawn tool ENOENT', 'processed 401 files']) {
  const noisy = classifyDelegationFailure({ error: noise });
  assert.equal(noisy.failureClass, 'unknown', noise);
  assert.equal(noteDelegationFailureLockout({ harness: 'noise-test', model: 'm', error: noise, workspaceFolder: wsA, dataDir }), false, noise);
}
assert.equal(classifyDelegationFailure({ error: 'HTTP 401 from provider' }).failureClass, 'auth');
assert.equal(classifyDelegationFailure({ error: 'request failed with status 401' }).failureClass, 'auth');
assert.equal(getHarnessUsageLimit({ harness: 'noise-test', model: 'sibling', workspaceFolder: wsA, dataDir }), null, 'no harness-wide lockout from stray text');
const modelFailure = { harness: 'codex-scoped', model: 'rejected::effort=high', error: 'Codex rejected the request. The selected model may not be available on this ChatGPT account.', workspaceFolder: wsA, dataDir };
assert.equal(noteDelegationFailureLockout(modelFailure), true);
assert.ok(getHarnessUsageLimit({ ...modelFailure, model: 'rejected' }));
assert.equal(getHarnessUsageLimit({ ...modelFailure, model: 'sibling' }), null);
assert.equal(getHarnessUsageLimit({ ...modelFailure, workspaceFolder: wsB }), null);
assert.equal(noteHarnessStartupFailureLockout(modelFailure), false, 'startup failure cannot overwrite model availability evidence');
assert.equal(describeHarnessLockoutRow({ harness: 'old' }).failureClass, 'unknown');
assert.equal(noteDelegationFailureLockout({ harness: 'unknown-test', model: 'm', error: 'odd', workspaceFolder: wsA, dataDir }), false);

// A new leaf recomputes candidates from current lockouts; recovery means eligibility, not victory.
const clock = Date.now();
const rankWorkspace = createStartupLockoutWorkspacePair().wsA;
noteHarnessStartupFailureLockout({ harness: 'testfake', model: 'testfake/recovered', workspaceFolder: rankWorkspace, dataDir, now: clock });
const nativeNow = Date.now;
const rank = (leafId) => pickModelForPurpose({
  role: 'implement', leafId, workspaceFolder: rankWorkspace, explore: false,
  harnesses: [{ id: 'testfake', enabled: true, ready: true, can_delegate: true }],
  modelsByHarness: { testfake: { favorites_configured: true, items: ['testfake/recovered', 'testfake/sibling'].map((id) => ({ id, roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 })) } },
  history: { lockouts: listHarnessUsageLimitsForWorkspace({ workspaceFolder: rankWorkspace, dataDir }) },
});
try {
  Date.now = () => clock;
  assert.ok(!rank('leaf-before').candidates.some((row) => row.model === 'testfake/recovered'));
  Date.now = () => clock + 3 * HOUR;
  const newLeaf = rank('leaf-after');
  assert.equal(newLeaf.ok, true);
  assert.ok(newLeaf.candidates.some((row) => row.model === 'testfake/recovered'));
  assert.ok(newLeaf.candidates.some((row) => row.model === 'testfake/sibling'));
} finally { Date.now = nativeNow; }

// --- A4/A5: trusted start context -------------------------------------------
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

let seq = 0;
function makeParent(extras = {}) {
  seq += 1;
  return addChat(randomUUID(), `sel-${seq}`, null, workspace, 'testfake/test', {
    agentTransport: 'testfake',
    sdkMode: 'agent',
    ...extras,
  });
}
const EXEC = { transport: 'testfake', model: 'testfake/test' };
function body(extra = {}) {
  return {
    executor: EXEC,
    sourceKind: 'text',
    taskText: 'Implement the change and report the diff.',
    executionMode: 'agent',
    assignment: 'implement',
    idempotencyKey: randomUUID(),
    ...extra,
  };
}
const finish = (id) => updateDelegationRecord(id, {
  status: 'completed',
  finishedAt: new Date().toISOString(),
  report: 'TASK: implement\nVERDICT: PASS',
});
const pickFor = (chatId, extra = {}) => persistModelPickProposal({
  chatId,
  workspaceFolder: workspace,
  role: 'implement',
  pickResult: {
    pick: { harness: 'testfake', model: 'testfake/test' },
    picks: [{ harness: 'testfake', model: 'testfake/test' }],
  },
  ...extra,
});
const post = (parent, b, req = {}) => invoke('POST', '/api/chats/:id/delegations', {
  params: { id: parent.id }, body: b, ...req,
});

// Legacy ad-hoc chat: named start and a manual marker still work.
const legacy = makeParent();
assert.equal(resolveDelegationStartContext({ parent: legacy, persist: false }).context, DELEGATION_START_CONTEXTS.legacyAdHoc);
const legacyStart = await post(legacy, body({ manualSource: 'user' }));
assert.equal(legacyStart.status, 201, JSON.stringify(legacyStart.body));
assert.equal(legacyStart.body.delegation.pickOrigin, 'manual');
assert.equal(legacyStart.body.delegation.startContext, 'legacy_ad_hoc');
finish(legacyStart.body.delegation.id);

// A caller-editable todo orchestrator id alone is not proof; server evidence is.
const watcherChat = makeParent({ pickPurpose: 'watcher-orchestrator' });
assert.equal(resolveDelegationStartContext({ parent: watcherChat, persist: false }).context, 'automatic');

// Persisted agent cookie remains restricted even if a later request omits the marker.
const agentCookie = createSession({ agentSession: true });
__reloadSessionsFromDiskForTest();
const agentReq = { headers: { cookie: `cr_session=${agentCookie}` } };
const agentUi = await invoke('POST', '/api/chats/:id/delegation-ui-actions', {
  ...agentReq, params: { id: legacy.id }, body: { executor: EXEC },
});
assert.equal(agentUi.status, 403);

// Automatic controller: no pick, forged marker, foreign/expired/reused picks are refused.
const auto = makeParent();
markDelegationAutomaticController(auto.id, 'todo_start');
assert.equal(resolveDelegationStartContext({ parent: auto }).context, 'automatic');
const named = await post(auto, body());
assert.equal(named.status, 409, JSON.stringify(named.body));
assert.equal(named.body.code, 'automatic_start_requires_pick');
const forged = await post(auto, body({ manualSource: 'user' }));
assert.equal(forged.status, 409);
assert.equal(forged.body.code, 'automatic_start_requires_pick', 'a forged manual marker is no exemption');
const forgedWithPick = await post(auto, body({ manualSource: 'ui', pickId: pickFor(auto.id).pickId }));
assert.equal(forgedWithPick.status, 201, JSON.stringify(forgedWithPick.body));
assert.equal(forgedWithPick.body.delegation.pickOrigin, 'auto');
finish(forgedWithPick.body.delegation.id);
const foreign = await post(auto, body({ pickId: pickFor(makeParent().id).pickId }));
assert.equal(foreign.body.code, 'automatic_pick_rejected');
const expired = await post(auto, body({ pickId: pickFor(auto.id, { now: Date.now() - MODEL_PICK_TTL_MS - 60_000 }).pickId }));
assert.equal(expired.body.code, 'automatic_pick_rejected');
assert.equal(expired.body.reason, 'expired');
const reusedPick = pickFor(auto.id);
const firstUse = await post(auto, body({ pickId: reusedPick.pickId }));
assert.equal(firstUse.status, 201, JSON.stringify(firstUse.body));
finish(firstUse.body.delegation.id);
const reused = await post(auto, body({ pickId: reusedPick.pickId }));
assert.equal(reused.status, 409);
assert.equal(reused.body.code, 'slot_taken', 'a pick backs one start');

// Continuation: auditable, same leaf/executor, completed prior only.
const LEAF = 'cafe000000000001';
const contParent = makeParent();
markDelegationAutomaticController(contParent.id, 'watcher_cycle');
const first = await post(contParent, body({ pickId: pickFor(contParent.id).pickId, leafId: LEAF }));
assert.equal(first.status, 201, JSON.stringify(first.body));
const early = await post(contParent, body({ continuationOf: first.body.delegation.id, leafId: LEAF }));
assert.equal(early.body.code, 'invalid_continuation', 'a still-running assignment is not continued');
finish(first.body.delegation.id);
const wrongLeaf = await post(contParent, body({ continuationOf: first.body.delegation.id, leafId: 'cafe000000000002' }));
assert.equal(wrongLeaf.body.code, 'invalid_continuation');
const wrongExec = await post(contParent, body({
  continuationOf: first.body.delegation.id, leafId: LEAF, executor: { transport: 'codebuddy', model: 'hy3' },
}));
assert.equal(wrongExec.body.code, 'invalid_continuation');
const cont = await post(contParent, body({ continuationOf: first.body.delegation.id, leafId: LEAF }));
assert.equal(cont.status, 201, JSON.stringify(cont.body));
assert.equal(cont.body.delegation.pickOrigin, 'unknown', 'never fabricated as auto/manual');
assert.equal(cont.body.delegation.pickOriginDetail, 'continuation');
assert.equal(cont.body.delegation.continuationOf, first.body.delegation.id);
assert.equal(getDelegationById(cont.body.delegation.id).startContext, 'automatic');
finish(cont.body.delegation.id);

// UI action: human-only mint, single use, bound, no exemption for later agent starts.
const uiParent = makeParent();
markDelegationAutomaticController(uiParent.id, 'todo_start');
const mintReq = { params: { id: uiParent.id }, body: { executor: EXEC, role: 'implement', sourceKind: 'text', taskText: body().taskText } };
const agentMint = await invoke('POST', '/api/chats/:id/delegation-ui-actions', { ...mintReq, mcpIntegration: true });
assert.equal(agentMint.status, 403, 'an agent identity cannot mint a UI action');
const humanMint = await invoke('POST', '/api/chats/:id/delegation-ui-actions', mintReq);
assert.equal(humanMint.status, 201, JSON.stringify(humanMint.body));
const actionId = humanMint.body.uiActionId;
const cookieUse = await post(uiParent, body({ uiActionId: actionId }), agentReq);
assert.equal(cookieUse.body.code, 'ui_action_forbidden');
const agentUse = await post(uiParent, body({ uiActionId: actionId }), { mcpIntegration: true });
assert.equal(agentUse.status, 403);
assert.equal(agentUse.body.code, 'ui_action_forbidden');
const mismatch = await post(uiParent, body({ uiActionId: actionId, executor: { transport: 'codebuddy', model: 'hy3' } }));
assert.equal(mismatch.body.code, 'ui_action_mismatch');
const used = await post(uiParent, body({ uiActionId: actionId }));
assert.equal(used.status, 201, JSON.stringify(used.body));
assert.equal(used.body.delegation.pickOrigin, 'manual');
assert.equal(used.body.delegation.pickOriginDetail, 'ui');
assert.equal(used.body.delegation.uiActionProof, true);
finish(used.body.delegation.id);
const again = await post(uiParent, body({ uiActionId: actionId }));
assert.equal(again.status, 403, 'the action is single use');
const laterAgent = await post(uiParent, body(), { mcpIntegration: true });
assert.equal(laterAgent.body.code, 'automatic_start_requires_pick', 'the exception never extends to later agent starts');
const legacyMint = await invoke('POST', '/api/chats/:id/delegation-ui-actions', {
  ...mintReq, params: { id: legacy.id },
});
const legacyManual = await post(legacy, body({ uiActionId: legacyMint.body.uiActionId }));
assert.equal(legacyManual.status, 201, JSON.stringify(legacyManual.body));
assert.equal(legacyManual.body.delegation.pickOrigin, 'manual');
finish(legacyManual.body.delegation.id);
assert.equal((await post(legacy, body({ uiActionId: legacyMint.body.uiActionId }))).status, 403);
// Other chat / expiry (fake clock) are refused by the store itself.
const otherChatAction = mintDelegationUiAction({
  parentChatId: 'other', workspaceFolder: workspace, role: 'implement', ...EXEC.transport && { harness: 'testfake', model: 'testfake/test' },
});
assert.equal(consumeDelegationUiAction({
  id: otherChatAction.id, actor: 'human', parentChatId: uiParent.id, workspaceFolder: workspace,
  role: 'implement', harness: 'testfake', model: 'testfake/test',
}).code, 'ui_action_foreign');
const shortLived = mintDelegationUiAction({
  parentChatId: uiParent.id, workspaceFolder: workspace, role: 'implement', harness: 'testfake', model: 'testfake/test', ttlMs: 1000,
});
assert.equal(consumeDelegationUiAction({
  id: shortLived.id, actor: 'human', parentChatId: uiParent.id, workspaceFolder: workspace,
  role: 'implement', harness: 'testfake', model: 'testfake/test', now: Date.now() + 5000,
}).code, 'ui_action_expired');

// Exercise the production frontend mint+start helper against real routes.
import { readApiSource } from './helpers/api-source.js';
const apiSource = readApiSource();
const helperSource = apiSource.slice(apiSource.indexOf('export async function postManualChatDelegation'), apiSource.indexOf('export async function getChatDelegations'));
const calls = [];
const frontend = vm.runInNewContext(`(function(){ ${helperSource.replaceAll('export ', '')}; return postManualChatDelegation; })()`, {
  apiFetchJson: async (url, options) => {
    calls.push(url);
    const route = url.endsWith('delegation-ui-actions') ? '/api/chats/:id/delegation-ui-actions' : '/api/chats/:id/delegations';
    return (await invoke('POST', route, { params: { id: uiParent.id }, body: JSON.parse(options.body) })).body;
  },
});
const manualPayload = body();
const manualResult = await frontend(uiParent.id, manualPayload);
assert.equal(manualResult.ok, true, JSON.stringify(manualResult));
assert.equal(manualResult.delegation.pickOrigin, 'manual');
assert.equal(calls.length, 2);
finish(manualResult.delegation.id);
assert.ok(readTodoPanelSource().includes('api.postManualChatDelegation('));
assert.ok(fs.readFileSync(new URL('../app_front/features/chat/chatDelegations.js', import.meta.url), 'utf8').includes('api.postManualChatDelegation('));

// Both production UI callers use that helper, with their actual plan/review payloads.
const todoSource = readTodoPanelSource();
const todoStart = todoSource.indexOf('async function startTodoReview(');
let todoResult;
const startReview = vm.runInNewContext(`(function(){ ${todoSource.slice(todoStart, todoSource.indexOf('\n/**', todoStart))}; return startTodoReview; })()`, {
  api: { postManualChatDelegation: async (...args) => { todoResult = await frontend(...args); return todoResult; } },
  resolveTodoReviewParentChatId: () => uiParent.id,
  buildTodoReviewTaskText: () => 'Review the approved plan independently.',
  setStatus: () => {}, t: (key) => key,
});
await startReview({ id: 'cafe000000000004', title: 'Review fixture' }, 'plan', EXEC.transport, EXEC.model);
assert.equal(todoResult?.ok, true, JSON.stringify(todoResult));
assert.equal(todoResult.delegation.pickOrigin, 'manual');
assert.equal(todoResult.delegation.assignment, 'review');
finish(todoResult.delegation.id);
writeChatPlanFile({ cwd: workspace, chatId: uiParent.id, markdown: '# Implementation plan\n\n- Update the feature\n- Verify the result', title: 'Plan', sourceTurnId: 'plan-turn' });
const chatSource = fs.readFileSync(new URL('../app_front/features/chat/chatDelegations.js', import.meta.url), 'utf8');
const chatStart = chatSource.indexOf('export async function startDelegationFromParent(');
const startFromChat = vm.runInNewContext(`(function(){ ${chatSource.slice(chatStart, chatSource.indexOf('\n/**', chatStart)).replace('export ', '')}; return startDelegationFromParent; })()`, {
  api: { postManualChatDelegation: frontend },
  peekDelegationIdempotencyKey: () => randomUUID(),
  saveLastDelegationExecutor: () => {}, clearDelegationIdempotencyKey: () => {}, t: (key) => key,
});
const chatResult = await startFromChat(uiParent, { sourceKind: 'plan', planRevision: 1, harness: EXEC.transport, model: EXEC.model, executionMode: 'agent' });
assert.equal(chatResult.ok, true, JSON.stringify(chatResult));
assert.equal(chatResult.delegation.pickOrigin, 'manual');
finish(chatResult.delegation.id);
const planChatResult = await startFromChat(uiParent, { sourceKind: 'plan', planRevision: 1, harness: EXEC.transport, model: EXEC.model, executionMode: 'plan' });
assert.equal(planChatResult.ok, true, JSON.stringify(planChatResult));
assert.equal(planChatResult.delegation.assignment, 'review');
finish(planChatResult.delegation.id);

// Fallback: one per failed attempt, idempotent, never while the original holds its slot.
const fbParent = makeParent();
markDelegationAutomaticController(fbParent.id, 'watcher_cycle');
const FB_LEAF = 'cafe000000000003';
const fbPick = pickFor(fbParent.id);
const attempt = await post(fbParent, body({ pickId: fbPick.pickId, leafId: FB_LEAF }));
assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
const fbPickFor = (executor, extra = {}) => pickFor(fbParent.id, {
  pickResult: { pick: executor, picks: [executor] },
  ...extra,
});
const STALE_EXECUTOR = { harness: 'codebuddy', model: 'hy3' };
const stalePick = fbPickFor(STALE_EXECUTOR, { now: Date.now() - 60_000 });
const fbBody = (key, pickId) => body({
  pickId,
  executor: { transport: 'codebuddy', model: 'hy3' },
  pickFallbackFrom: attempt.body.delegation.id,
  leafId: FB_LEAF,
  idempotencyKey: key,
});
const occupied = await post(fbParent, fbBody('fb-early', stalePick.pickId));
assert.equal(occupied.body.code, 'automatic_pick_rejected', 'no fallback while the original run is active');
updateDelegationRecord(attempt.body.delegation.id, {
  status: 'failed',
  finishedAt: new Date().toISOString(),
  error: 'Transport not started',
});
const staleFallback = await post(fbParent, fbBody('fb-stale', stalePick.pickId));
assert.equal(staleFallback.body.code, 'automatic_pick_rejected', 'a pick older than the failure is not a fresh decision');
const unpickedFallback = await post(fbParent, fbBody('fb-unpicked', fbPickFor({ harness: 'testfake', model: 'testfake/test' }).pickId));
assert.equal(unpickedFallback.body.code, 'automatic_pick_rejected', 'the fallback executor must be one the pick proposed');
const fallbackPick = fbPickFor(STALE_EXECUTOR);
const fbBodyFresh = (key) => fbBody(key, fallbackPick.pickId);
const race = await Promise.all([
  post(fbParent, fbBodyFresh('fb-key')),
  post(fbParent, fbBody('fb-racing-key', fbPickFor(STALE_EXECUTOR).pickId)),
]);
assert.equal(race.filter((result) => result.status === 201).length, 1);
assert.equal(race[1].body.code, 'fallback_already_used');
const fb = race[0];
assert.equal(fb.status, 201, JSON.stringify(fb.body));
assert.equal(fb.body.delegation.pickOriginDetail, 'fallback');
assert.equal(fb.body.delegation.fallbackFailureClass, 'transient_transport');
const fbReplay = await post(fbParent, fbBodyFresh('fb-key'));
assert.equal(fbReplay.status, 200);
assert.equal(fbReplay.body.delegation.id, fb.body.delegation.id, 'same key replays without a second run');
finish(fb.body.delegation.id);
const fbSecond = await post(fbParent, fbBodyFresh('fb-other-key'));
assert.equal(fbSecond.status, 409, 'at most one fallback per failed attempt');

const concurrentFallbacks = await Promise.all([
  post(fbParent, fbBody('fb-other-pick-1', fbPickFor(STALE_EXECUTOR).pickId)),
  post(fbParent, fbBody('fb-other-pick-2', fbPickFor(STALE_EXECUTOR).pickId)),
]);
assert.ok(concurrentFallbacks.every((result) => result.body.code === 'fallback_already_used'));
removeIsolatedDataDir();
console.log('delegation-selection-recovery.test.js OK');
