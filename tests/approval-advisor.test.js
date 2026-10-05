/**
 * Approval broker — Phase 2 (external model advisor) contract tests.
 *
 * These exercise the pure advisor surface (eligibility, redaction, SSRF gate,
 * pinned transport, response parsing, quota, error mapping, audit and the
 * no-leak invariants) plus the pending / idempotency / human-wins reply guard.
 * They never touch the network: the transport and the DNS lookup are injected.
 */
import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import {
  applyApprovalBrokerSettingsPatch,
  normalizeApprovalAdvisorSettings,
  normalizeApprovalBrokerSettings,
  readApprovalBrokerMode,
} from '../lib/approval/approval-broker.js';
import {
  ADVISOR_MAX_REASON_CHARS,
  ADVISOR_POLICY_VERSION,
  APPROVAL_ADVISOR_API_KEY_ENV,
  buildAdvisorPermissionTuple,
  buildAdvisorRequestBody,
  buildSystemOneRequestBody,
  getApprovalAdvisorMetaForClient,
  getEffectiveApprovalAdvisorApiKey,
  parseAdvisorCompletion,
  parseSystemOneAnswer,
  postApprovalAdvisorRequest,
  readApprovalAdvisorSettings,
  recordApprovalAdvisorAudit,
  recordApprovalAdvisorSkipAudit,
  requestApprovalAdvisor,
  resetApprovalAdvisorQuota,
  resolveAdvisorReplyOutcome,
  resolveApprovalAdvisorPlan,
  shouldScheduleApprovalAdvisor,
  validateApprovalAdvisorEndpoint,
  waitForAdvisorApplyWindow,
} from '../lib/approval/approval-advisor.js';
import { createOpenCodePermissionReplyGuard } from '../lib/opencode/opencode-permission-reply-guard.js';
import { resolveOpenCodeApprovalAction } from '../lib/opencode/opencode-permission.js';
import { readApprovalAuditEntries } from '../lib/approval/approval-audit.js';

const KEY = 'sk-advisor-secret-0123456789';
const BASE_URL = 'https://advisor.example.test/v1/chat/completions';

function clearEnvKey() {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
}
clearEnvKey();

function advisorSettings(overrides = {}) {
  const {
    mode = 'local_reads',
    enabled = true,
    baseUrl = BASE_URL,
    model = 'advisor-model',
    timeoutMs = 5000,
    dailyQuota = 100,
    key = KEY,
  } = overrides;
  const settings = {};
  applyApprovalBrokerSettingsPatch(settings, {
    mode,
    advisor: { enabled, baseUrl, model, timeoutMs, dailyQuota },
  });
  if (key) settings.approvalAdvisorApiKey = key;
  return settings;
}

const lowRiskReadAction = {
  mode: 'local_reads',
  decision: 'ask_user',
  reply: null,
  risk: 'low',
  categories: [],
  action: 'read',
  command: '',
  shadow: false,
  policyVersion: 'opencode-local-1',
  reason: 'manual_review',
};
const lowRiskReadEvent = {
  requestId: 'perm_read_1',
  action: 'read',
  resources: ['/home/user/workspace/src/app.js'],
};

{
  const tuple = buildAdvisorPermissionTuple({
    permissionEvent: { requestId: 'path_1', action: 'read', resources: ['/workspace/private.txt'] },
    approvalAction: { ...lowRiskReadAction, command: 'cat /workspace/private.txt' },
  });
  assert.equal(tuple.command, 'cat private.txt', 'advisor command must not reveal absolute workspace paths');
  assert.equal(JSON.stringify(tuple).includes('/workspace'), false);
  const windowsTuple = buildAdvisorPermissionTuple({
    permissionEvent: { requestId: 'path_2', action: 'read' },
    approvalAction: { ...lowRiskReadAction, command: 'type C:\\Users\\alice\\workspace\\private.txt' },
  });
  assert.equal(windowsTuple.command, 'type private.txt', 'Windows absolute paths must also be reduced to basenames');
  assert.equal(windowsTuple.command.includes('alice'), false);
}

// --- defaults: nothing configured means zero network -----------------------

assert.equal(readApprovalBrokerMode({}), 'off', 'broker defaults off');
assert.equal(readApprovalAdvisorSettings({}).enabled, false, 'advisor defaults disabled');
assert.deepEqual(readApprovalAdvisorSettings({}), {
  enabled: false,
  protocol: 'openai_chat',
  baseUrl: '',
  model: '',
  minProbability: 0.9,
  timeoutMs: 5000,
  dailyQuota: 100,
});

// --- advisor protocol + minProbability normalization ------------------------

{
  assert.equal(normalizeApprovalAdvisorSettings({ protocol: 'systemone' }).protocol, 'systemone');
  assert.equal(normalizeApprovalAdvisorSettings({ protocol: 'SYSTEMONE' }).protocol, 'systemone', 'protocol is case-insensitive');
  assert.equal(normalizeApprovalAdvisorSettings({ protocol: 'bogus' }).protocol, 'openai_chat', 'unknown protocol fails closed to openai_chat');
  assert.equal(normalizeApprovalAdvisorSettings({}).protocol, 'openai_chat', 'protocol defaults to openai_chat');
  assert.equal(normalizeApprovalAdvisorSettings({ minProbability: 0.7 }).minProbability, 0.7);
  assert.equal(normalizeApprovalAdvisorSettings({ minProbability: 0.1 }).minProbability, 0.5, 'minProbability clamps to 0.5');
  assert.equal(normalizeApprovalAdvisorSettings({ minProbability: 5 }).minProbability, 0.99, 'minProbability clamps to 0.99');
  assert.equal(normalizeApprovalAdvisorSettings({ minProbability: 'NaN' }).minProbability, 0.9, 'a non-number falls back to 0.9');
  assert.equal(normalizeApprovalAdvisorSettings({ minProbability: null }).minProbability, 0.9);
}

// Updating only the mode must not erase a configured advisor block.
{
  const settings = {};
  applyApprovalBrokerSettingsPatch(settings, {
    mode: 'local_reads',
    advisor: { enabled: true, baseUrl: BASE_URL, model: 'm', dailyQuota: 7 },
  });
  applyApprovalBrokerSettingsPatch(settings, { mode: 'shadow' });
  assert.equal(settings.approvalBroker.advisor.dailyQuota, 7);
  assert.equal(settings.approvalBroker.advisor.enabled, true);
  applyApprovalBrokerSettingsPatch(settings, { mode: 'off' });
  assert.equal(settings.approvalBroker.advisor.enabled, true, 'off preserves explicit advisor configuration');
}

const transportCalls = [];
function countingTransport(response) {
  return async (opts) => {
    transportCalls.push(opts);
    return typeof response === 'function' ? response(opts) : response;
  };
}

// mode off => not eligible, no transport call.
{
  transportCalls.length = 0;
  const settings = advisorSettings({ mode: 'off' });
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'mode_not_local_reads');
  await requestApprovalAdvisor({ plan, settings, transport: countingTransport({ status: 200, json: {} }) });
  assert.equal(transportCalls.length, 0, 'off mode must not touch the network');
}

// advisor disabled => not eligible even in local_reads.
{
  transportCalls.length = 0;
  const settings = advisorSettings({ enabled: false });
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'advisor_disabled');
  await requestApprovalAdvisor({ plan, settings, transport: countingTransport({ status: 200, json: {} }) });
  assert.equal(transportCalls.length, 0, 'disabled advisor must not touch the network');
}

// no endpoint / no key => not eligible.
{
  const plan = resolveApprovalAdvisorPlan(advisorSettings({ key: '' }), lowRiskReadAction);
  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'no_api_key');
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings({ baseUrl: '' }), lowRiskReadAction).reason, 'no_https_endpoint');
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings({ baseUrl: 'http://advisor.example.test/v1' }), lowRiskReadAction).reason,
    'no_https_endpoint',
    'http endpoint is not eligible',
  );
}

// --- eligibility mirrors the local decision matrix -------------------------

// A real high-risk / secrets action produced by the local broker is never eligible.
{
  const secretEvent = { requestId: 'per_secret', action: 'bash', metadata: { command: 'cat .env' }, resources: [] };
  const highRisk = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: secretEvent,
    assignment: '',
    workspaceFolder: process.cwd(),
  });
  assert.equal(highRisk.decision, 'ask_user');
  assert.equal(highRisk.risk, 'high');
  const plan = resolveApprovalAdvisorPlan(advisorSettings(), highRisk);
  assert.equal(plan.eligible, false);
  assert.match(plan.reason, /not_low_risk|unsafe_category/);
}

// The one mutation-only medium class the advisor may widen: the host-owned
// review-verify runner. This is the only command that may carry `mutation`.
{
  const command = 'node scripts/review-verify.js';
  const action = {
    mode: 'local_reads',
    decision: 'ask_user',
    risk: 'medium',
    categories: ['mutation'],
    command,
    shadow: false,
  };
  const plan = resolveApprovalAdvisorPlan(advisorSettings(), action);
  assert.equal(plan.eligible, true, 'the review-verify runner must be advisor-eligible');
  assert.equal(plan.reason, '');
  // A catalog id is still the same runner.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { ...action, command: 'node scripts/review-verify.js notices' }).eligible,
    true,
  );
}

// Problem 1 lock: every OTHER mutation-only medium stays with the human. A
// blanket `risk === 'medium'` gate would wrongly auto-approve all of these.
{
  for (const command of [
    'mkdir scratch',
    'mv a b',
    'sed -i s/a/b/ file.txt',
    'git commit -m x',
    'node scripts/other.js',
    'python script.py',
    'node scripts/review-verify.js --test-reporter=spec',
    'node scripts/review-verify.js unknown-id',
    'node scripts/review-verify.js; rm -rf build',
    // Z1 regression: binary with path separator must never be eligible
    './node scripts/review-verify.js notices',
    '/tmp/evil/node scripts/review-verify.js notices',
    '/abs/path/node scripts/review-verify.js notices',
    'dir/nodejs scripts/review-verify.js notices',
    '/usr/bin/time /tmp/evil/node scripts/review-verify.js notices',
  ]) {
    const action = {
      mode: 'local_reads',
      decision: 'ask_user',
      risk: 'medium',
      categories: ['mutation'],
      command,
      shadow: false,
    };
    const plan = resolveApprovalAdvisorPlan(advisorSettings(), action);
    assert.equal(plan.eligible, false, `${command} must NOT be advisor-eligible`);
    assert.equal(plan.reason, 'not_low_risk', `${command} fails the risk gate`);
  }
}

// Anything carrying a dangerous category stays ineligible.
{
  const mixed = { mode: 'local_reads', decision: 'ask_user', risk: 'medium', categories: ['mutation', 'network'], shadow: false };
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings(), mixed).eligible, false, 'mutation + network is not eligible');
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { ...mixed, risk: 'high' }).eligible,
    false,
    'mutation + network at high risk is not eligible',
  );
  // The category gate still bites even when the risk gate alone would pass.
  const lowPlan = resolveApprovalAdvisorPlan(advisorSettings(), { ...lowRiskReadAction, categories: ['mutation', 'secrets'] });
  assert.equal(lowPlan.eligible, false);
  assert.equal(lowPlan.reason, 'unsafe_category');
  // An inconsistent medium risk without any mutation category fails closed.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { ...mixed, categories: ['network'] }).eligible,
    false,
    'medium risk with only a dangerous category fails closed',
  );
}

// --- eligibility edge cases fail closed ------------------------------------
{
  // Missing risk field: never infer `low`.
  const noRisk = { mode: 'local_reads', decision: 'ask_user', categories: ['mutation'] };
  const noRiskPlan = resolveApprovalAdvisorPlan(advisorSettings(), noRisk);
  assert.equal(noRiskPlan.eligible, false, 'a missing risk fails closed');
  assert.equal(noRiskPlan.reason, 'not_low_risk');
  // categories undefined on a low-risk action behaves like an empty list.
  const noCategories = { mode: 'local_reads', decision: 'ask_user', risk: 'low' };
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), noCategories).eligible,
    true,
    'low + undefined categories is a read-only action',
  );
  // categories undefined with a medium risk cannot prove mutation-only, so it
  // fails closed.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { ...noCategories, risk: 'medium' }).eligible,
    false,
    'medium + undefined categories fails closed',
  );
  // medium + [] (inconsistent: medium without mutation) fails closed.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { mode: 'local_reads', decision: 'ask_user', risk: 'medium', categories: [] }).eligible,
    false,
    'medium + [] fails closed',
  );
  // Z1 regression: medium + mutation with no command field (undefined) fails closed.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { mode: 'local_reads', decision: 'ask_user', risk: 'medium', categories: ['mutation'] }).eligible,
    false,
    'medium + mutation + no command fails closed',
  );
  // high + ['mutation'] fails closed.
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), { mode: 'local_reads', decision: 'ask_user', risk: 'high', categories: ['mutation'] }).eligible,
    false,
    'high + mutation fails closed',
  );
  // Problem 4: low + ['mutation'] is inconsistent and must not widen, even for
  // the otherwise-allowed review-verify command.
  const lowMutation = {
    mode: 'local_reads',
    decision: 'ask_user',
    risk: 'low',
    categories: ['mutation'],
    command: 'node scripts/review-verify.js',
  };
  const lowMutationPlan = resolveApprovalAdvisorPlan(advisorSettings(), lowMutation);
  assert.equal(lowMutationPlan.eligible, false, 'low + mutation must fail closed');
  assert.equal(lowMutationPlan.reason, 'unsafe_category');
}

// End-to-end: the real local decision for an interactive `node scripts/review-verify.js`
// is ask_user + medium + ['mutation'] and must now reach the advisor instead of
// dying at the eligibility gate.
{
  const command = 'node scripts/review-verify.js';
  const bashEvent = { requestId: 'perm_bash_verify', action: 'bash', metadata: { command }, resources: [command] };
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: bashEvent,
    assignment: '',
    workspaceFolder: process.cwd(),
  });
  assert.equal(action.decision, 'ask_user');
  assert.equal(action.risk, 'medium');
  assert.deepEqual(action.categories, ['mutation']);
  assert.equal(
    resolveApprovalAdvisorPlan(advisorSettings(), action).eligible,
    true,
    'the review-verify bash probe must reach the advisor',
  );
  assert.equal(
    shouldScheduleApprovalAdvisor({ approvalAction: action, settings: advisorSettings(), requestId: 'perm_bash_verify', requested: new Set() }).eligible,
    true,
    'the mutation-only probe must be scheduled once',
  );
}

// End-to-end lock: a real non-review mutation (mkdir) stays non-scheduled even
// though it is mutation-only medium.
{
  const command = 'mkdir scratch-dir';
  const bashEvent = { requestId: 'perm_bash_mkdir', action: 'bash', metadata: { command }, resources: [command] };
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: bashEvent,
    assignment: '',
    workspaceFolder: process.cwd(),
  });
  assert.equal(action.risk, 'medium');
  assert.deepEqual(action.categories, ['mutation']);
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings(), action).eligible, false);
  assert.equal(
    shouldScheduleApprovalAdvisor({ approvalAction: action, settings: advisorSettings(), requestId: 'perm_bash_mkdir', requested: new Set() }).eligible,
    false,
  );
}

// End-to-end lock: a network command stays non-scheduled.
{
  const command = 'curl https://example.test/data';
  const bashEvent = { requestId: 'perm_bash_net', action: 'bash', metadata: { command }, resources: [command] };
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: bashEvent,
    assignment: '',
    workspaceFolder: process.cwd(),
  });
  assert.equal(action.risk, 'high');
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings(), action).eligible, false);
  assert.equal(
    shouldScheduleApprovalAdvisor({ approvalAction: action, settings: advisorSettings(), requestId: 'perm_bash_net', requested: new Set() }).eligible,
    false,
  );
}

// shadow is never eligible.
{
  const shadowAction = { ...lowRiskReadAction, mode: 'shadow', shadow: true };
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings({ mode: 'shadow' }), shadowAction).reason, 'mode_not_local_reads');
}

// a genuinely eligible low-risk read
{
  const plan = resolveApprovalAdvisorPlan(advisorSettings(), lowRiskReadAction);
  assert.equal(plan.eligible, true, 'a low-risk read ask_user in local_reads is eligible');
  assert.equal(plan.hostname, 'advisor.example.test');
  assert.equal(plan.protocol, 'openai_chat');
  assert.equal(plan.minProbability, 0.9);
  assert.equal(plan.timeoutMs, 5000);
}

// Area 2 product decision: advisor eligibility is action-type-agnostic. The
// gate reads only the risk/category tuple, never the action name, so the same
// `low` + `[]` ask_user widens identically for `bash` and `edit`. (The real
// local classifier still emits `edit` as medium+mutation — out of scope here.)
{
  const settings = advisorSettings();
  const editLowRead = {
    mode: 'local_reads',
    decision: 'ask_user',
    action: 'edit',
    risk: 'low',
    categories: [],
    command: '',
    shadow: false,
  };

  // (a) edit + low + [] is eligible, and yields the same verdict as bash.
  const editPlan = resolveApprovalAdvisorPlan(settings, editLowRead);
  assert.equal(editPlan.eligible, true, 'edit + ask_user + low + [] must be advisor-eligible');
  assert.equal(editPlan.reason, '', 'an eligible edit tuple carries no reject reason');
  const bashPlan = resolveApprovalAdvisorPlan(settings, { ...editLowRead, action: 'bash' });
  assert.deepEqual(
    { eligible: bashPlan.eligible, reason: bashPlan.reason },
    { eligible: editPlan.eligible, reason: editPlan.reason },
    'eligibility must not depend on the action type for the same low + [] tuple',
  );

  // (b) edit + medium with no mutation category and a non-review-verify command
  // fails the risk gate.
  const editMedium = resolveApprovalAdvisorPlan(settings, {
    ...editLowRead,
    risk: 'medium',
    command: 'npm run build',
  });
  assert.equal(editMedium.eligible, false);
  assert.equal(editMedium.reason, 'not_low_risk', 'edit + medium + [] fails closed at the risk gate');

  // (c) edit + low with any non-empty category fails the category gate.
  for (const categories of [['mutation'], ['network'], ['secrets']]) {
    const plan = resolveApprovalAdvisorPlan(settings, { ...editLowRead, categories });
    assert.equal(plan.eligible, false, `edit + low + ${JSON.stringify(categories)} is not eligible`);
    assert.equal(plan.reason, 'unsafe_category', `edit + low + ${JSON.stringify(categories)} fails the category gate`);
  }
}

assert.equal(
  resolveApprovalAdvisorPlan(advisorSettings({ model: '' }), lowRiskReadAction).reason,
  'no_model',
  'missing model must not trigger a provider request for openai_chat',
);

// System One does not require a model: the endpoint has a server-side default.
{
  const settings = advisorSettings({ model: '' });
  settings.approvalBroker.advisor.protocol = 'systemone';
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  assert.equal(plan.eligible, true, 'systemone is eligible without a model');
  assert.equal(plan.protocol, 'systemone');
  assert.equal(plan.model, '');
}

// --- env key always wins over the stored setting ---------------------------

{
  clearEnvKey();
  const settings = advisorSettings({ key: KEY });
  assert.equal(getEffectiveApprovalAdvisorApiKey(settings), KEY, 'falls back to the stored key');
  process.env[APPROVAL_ADVISOR_API_KEY_ENV] = 'env-wins-key';
  try {
    assert.equal(getEffectiveApprovalAdvisorApiKey(settings), 'env-wins-key', 'env overrides the stored key');
  } finally {
    clearEnvKey();
  }
}

// --- the request tuple leaks nothing sensitive -----------------------------

{
  const tuple = buildAdvisorPermissionTuple({ permissionEvent: lowRiskReadEvent, approvalAction: lowRiskReadAction });
  assert.equal(tuple.harness, 'opencode');
  assert.equal(tuple.permission, 'read');
  assert.deepEqual(tuple.resources, ['app.js'], 'only basenames, never the absolute path / cwd');
  const body = buildAdvisorRequestBody({ model: 'advisor-model', tuple });
  assert.equal(body.model, 'advisor-model');
  assert.equal(body.stream, false, 'non-streaming');
  assert.equal(body.temperature, 0);
  assert.equal('tools' in body, false, 'the advisor request must never advertise tools');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('/home/user/workspace'), false, 'no cwd / workspace layout on the wire');
  assert.equal(serialized.includes(KEY), false, 'the key is never in the request body');
  assert.equal(serialized.toLowerCase().includes('authorization'), false, 'no auth material in the body');
  assert.equal(Array.isArray(body.messages) && body.messages.length === 2, true, 'system + redacted tuple only');
  assert.equal(body.messages[1].content.includes('/home/user/workspace'), false);
  // Problem 2 lock: the system prompt must describe the real eligibility rule
  // (read-only OR the host-owned review-verify runner), not "read-only only".
  assert.match(body.messages[0].content, /review-verify\.js/, 'the system prompt names the allowed runner');
  assert.match(body.messages[0].content, /read-only/i, 'the system prompt still describes the low-risk read class');
}

// --- System One request body: state + one noul question, optional model ----

{
  const tuple = buildAdvisorPermissionTuple({ permissionEvent: lowRiskReadEvent, approvalAction: lowRiskReadAction });
  const body = buildSystemOneRequestBody({ model: 'jev-latest', tuple });
  assert.deepEqual(body.state, tuple, 'the System One state is exactly the redacted tuple');
  assert.equal(body.questions.safe_read.type, 'noul');
  assert.match(body.questions.safe_read.instructions, /read-only/i);
  assert.match(body.questions.safe_read.instructions, /files/i);
  assert.match(body.questions.safe_read.instructions, /review-verify\.js/, 'System One instructions name the allowed runner');
  assert.equal(body.model, 'jev-latest');
  assert.equal('messages' in body, false, 'System One must not send an OpenAI chat payload');
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('/home/user/workspace'), false, 'no cwd / workspace layout on the wire');
  assert.equal(serialized.includes(KEY), false, 'the key is never in the request body');
  const noModel = buildSystemOneRequestBody({ model: '', tuple });
  assert.equal('model' in noModel, false, 'an empty model is omitted for the server default');
}

// Resource basenames are redacted for both protocols.
{
  const tuple = buildAdvisorPermissionTuple({
    permissionEvent: { requestId: 'path_secret', action: 'read', resources: ['/workspace/secret=abc123'] },
    approvalAction: lowRiskReadAction,
  });
  assert.equal(tuple.resources.length, 1);
  assert.equal(JSON.stringify(tuple).includes('abc123'), false, 'resource basenames are redacted before sending');
}

// --- System One answer parsing ---------------------------------------------

{
  assert.deepEqual(parseSystemOneAnswer({ answers: { safe_read: { type: 'noul', noul: 0.95 } } }, 0.9), {
    decision: 'allow',
    reason: 'noul 0.95',
    confidence: 0.95,
    error: null,
  });
  // Exact threshold boundary is inclusive.
  assert.equal(parseSystemOneAnswer({ answers: { safe_read: { type: 'noul', noul: 0.9 } } }, 0.9).decision, 'allow');
  assert.equal(parseSystemOneAnswer({ answers: { safe_read: { type: 'noul', noul: 0.899 } } }, 0.9).decision, 'ask_user');
  // Laya adds routing/action/confidence; `confidence` is not a substitute for noul.
  const laya = parseSystemOneAnswer(
    { answers: { safe_read: { type: 'noul', noul: 0.2, confidence: 0.99, routing: 'x', action: 'allow' } } },
    0.9,
  );
  assert.equal(laya.decision, 'ask_user', 'Laya extra fields are ignored and never widen allow');
  assert.equal(laya.confidence, 0.2, 'confidence always mirrors noul');
  // Bad shapes: string values, NaN, Infinity, out of range, wrong type, missing.
  for (const bad of [
    { answers: { safe_read: { type: 'noul', noul: '0.95' } } },
    { answers: { safe_read: { type: 'noul', noul: Number.NaN } } },
    { answers: { safe_read: { type: 'noul', noul: Number.POSITIVE_INFINITY } } },
    { answers: { safe_read: { type: 'noul', noul: -0.1 } } },
    { answers: { safe_read: { type: 'noul', noul: 1.1 } } },
    { answers: { safe_read: { type: 'choice', noul: 0.99 } } },
    { answers: { safe_read: { type: 'noul' } } },
    { answers: {} },
    {},
  ]) {
    const parsed = parseSystemOneAnswer(bad, 0.9);
    assert.equal(parsed.decision, 'ask_user', `${JSON.stringify(bad)} must collapse to ask_user`);
    assert.equal(parsed.error, 'bad_answer', `${JSON.stringify(bad)} must carry an error code`);
  }
  assert.equal(parseSystemOneAnswer('{bad json', 0.9).error, 'bad_json');
  assert.equal(parseSystemOneAnswer('{"answers":{"safe_read":{"type":"noul","noul":0.95}}}', 0.9).decision, 'allow');
  // An omitted threshold falls back to the 0.9 default.
  assert.equal(parseSystemOneAnswer({ answers: { safe_read: { type: 'noul', noul: 0.91 } } }).decision, 'allow');
  assert.equal(parseSystemOneAnswer({ answers: { safe_read: { type: 'noul', noul: 0.89 } } }).decision, 'ask_user');
}

// --- response parsing: allow / ask_user / deny->ask_user / bad json --------

{
  assert.deepEqual(parseAdvisorCompletion('{"decision":"allow","reason":"read only","confidence":0.8}'), {
    decision: 'allow',
    reason: 'read only',
    confidence: 0.8,
    error: null,
  });
  const mapped = parseAdvisorCompletion('{"decision":"deny","reason":"no"}');
  assert.equal(mapped.decision, 'ask_user', 'deny maps to ask_user (advisor never adds a reject)');
  assert.equal(parseAdvisorCompletion('{"decision":"allow","reason":"' + 'x'.repeat(400) + '"}').reason.length, ADVISOR_MAX_REASON_CHARS, 'reason capped to 200');
  assert.equal(parseAdvisorCompletion('{"decision":"allow","confidence":5}').confidence, 1, 'confidence clamped');
  assert.equal(parseAdvisorCompletion('{bad json').error, 'bad_json');
  assert.equal(parseAdvisorCompletion('[1,2]').error, 'bad_json');
}

// --- error mapping: exactly one transport call, all collapse to ask_user ---

async function expectAskUser(label, transportResponse, expectedError) {
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = advisorSettings();
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  const result = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport(transportResponse),
  });
  assert.equal(transportCalls.length, 1, `${label}: exactly one transport call, no retry`);
  assert.equal(result.advisorDecision, 'ask_user', `${label}: collapses to ask_user`);
  assert.equal(result.error, expectedError, `${label}: error code`);
}

await expectAskUser('timeout', { error: 'timeout', code: 'timeout' }, 'timeout');
await expectAskUser('rate_limited', { status: 429 }, 'rate_limited');
await expectAskUser('http_error', { status: 500, json: { error: 'boom' } }, 'http_error');
await expectAskUser('bad_json', { status: 200, json: { choices: [{ message: { content: 'not json' } }] } }, 'bad_json');
await expectAskUser('ssrf', { error: 'ssrf', code: 'blocked-address' }, 'ssrf');
await expectAskUser('network', { error: 'network', code: 'network' }, 'network');

// a clean allow from the provider becomes advisorDecision allow with usage/cost.
{
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = advisorSettings();
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  const result = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({
      status: 200,
      json: {
        choices: [{ message: { content: '{"decision":"allow","reason":"read only","confidence":0.9}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.0012 },
      },
    }),
  });
  assert.equal(result.advisorDecision, 'allow');
  assert.equal(result.reason, 'read only');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.usageTokens, 105);
  assert.equal(result.usageCost, 0.0012);
  assert.equal(result.provider, 'advisor.example.test');
  assert.equal(result.error, null);
  assert.equal(transportCalls.length, 1);
}

// --- System One transport: builder/parser chosen by plan.protocol ----------

function systemOneSettings(overrides = {}) {
  const settings = advisorSettings(overrides);
  settings.approvalBroker.advisor.protocol = 'systemone';
  if (overrides.minProbability !== undefined) settings.approvalBroker.advisor.minProbability = overrides.minProbability;
  return settings;
}

{
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = systemOneSettings();
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  assert.equal(plan.protocol, 'systemone');
  const result = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({
      status: 200,
      json: {
        model: 'jev-latest',
        answers: { safe_read: { type: 'noul', noul: 0.97, confidence: 0.99, routing: 'x' } },
        usage: { input_tokens: 120, output_tokens: 8 },
      },
    }),
  });
  assert.equal(result.advisorDecision, 'allow');
  assert.equal(result.confidence, 0.97, 'confidence comes from noul, not the Laya confidence field');
  assert.equal(result.protocol, 'systemone');
  assert.equal(result.usageTokens, 128, 'System One usage is input_tokens + output_tokens');
  assert.equal(result.error, null);
  assert.equal(transportCalls.length, 1);
  const sent = JSON.parse(transportCalls[0].payload);
  assert.deepEqual(sent.state, buildAdvisorPermissionTuple({ permissionEvent: lowRiskReadEvent, approvalAction: lowRiskReadAction }));
  assert.equal(sent.questions.safe_read.type, 'noul');
  assert.equal('messages' in sent, false, 'no OpenAI chat payload for systemone');
}

// A noul below the threshold stays ask_user with no error (a valid answer).
{
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = systemOneSettings({ minProbability: 0.95 });
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  const result = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({ status: 200, json: { answers: { safe_read: { type: 'noul', noul: 0.94 } } } }),
  });
  assert.equal(result.advisorDecision, 'ask_user');
  assert.equal(result.error, null);
  assert.equal(result.confidence, 0.94);
}

async function expectSystemOneAskUser(label, transportResponse, expectedError) {
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = systemOneSettings();
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  const result = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport(transportResponse),
  });
  assert.equal(transportCalls.length, 1, `systemone ${label}: exactly one transport call`);
  assert.equal(result.advisorDecision, 'ask_user', `systemone ${label}: collapses to ask_user`);
  assert.equal(result.error, expectedError, `systemone ${label}: error code`);
  assert.equal(result.protocol, 'systemone');
}

await expectSystemOneAskUser('timeout', { error: 'timeout', code: 'timeout' }, 'timeout');
await expectSystemOneAskUser('rate_limited', { status: 429 }, 'rate_limited');
await expectSystemOneAskUser('ssrf', { error: 'ssrf', code: 'blocked-address' }, 'ssrf');
await expectSystemOneAskUser('bad_answer', { status: 200, json: { answers: { safe_read: { type: 'choice', choice: 'x' } } } }, 'bad_answer');

// --- quota: a second request in the window is refused without the network ---
{
  transportCalls.length = 0;
  resetApprovalAdvisorQuota();
  const settings = advisorSettings({ dailyQuota: 1 });
  const plan = resolveApprovalAdvisorPlan(settings, lowRiskReadAction);
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const first = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({ status: 200, json: { choices: [{ message: { content: '{"decision":"ask_user"}' } }] } }),
    now,
  });
  assert.equal(first.error, null);
  assert.equal(transportCalls.length, 1);
  const second = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({ status: 200, json: {} }),
    now: now + 1000,
  });
  assert.equal(second.error, 'quota');
  assert.equal(second.advisorDecision, 'ask_user');
  assert.equal(transportCalls.length, 1, 'quota miss must not hit the network');
  // UTC day rolls over
  const third = await requestApprovalAdvisor({
    plan,
    settings,
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    transport: countingTransport({ status: 200, json: { choices: [{ message: { content: '{"decision":"ask_user"}' } }] } }),
    now: now + 86_400_000,
  });
  assert.equal(third.error, null, 'new window allows a request again');
  assert.equal(transportCalls.length, 2);
}
resetApprovalAdvisorQuota();

// --- SSRF gate + IP pinning (transport level, no connect) ------------------

{
  const lookup = async (host) => {
    if (host === 'public.test') return [{ address: '93.184.216.34' }];
    if (host === 'rebind.test') return [{ address: '127.0.0.1' }];
    if (host === 'meta.test') return [{ address: '169.254.169.254' }];
    return [{ address: '203.0.113.5' }];
  };

  // Reject the internal targets before any connection attempt.
  for (const url of [
    'http://public.test/v1',
    'https://127.0.0.1/v1',
    'https://localhost:8443/v1',
    'https://10.1.2.3/v1',
    'https://192.168.0.5/v1',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'https://user:pass@public.test/v1',
  ]) {
    const res = await validateApprovalAdvisorEndpoint(url, { lookup });
    assert.equal(res.ok, false, `${url} must be rejected`);
  }
  // A public https name resolves and is allowed.
  const ok = await validateApprovalAdvisorEndpoint('https://public.test/v1/chat', { lookup });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.resolvedIps, ['93.184.216.34']);

  // A public name that rebinds to loopback is rejected (DNS-rebinding).
  assert.equal((await validateApprovalAdvisorEndpoint('https://rebind.test/v1', { lookup })).ok, false);
  // https to a metadata address is rejected even though the scheme is fine.
  const meta = await validateApprovalAdvisorEndpoint('https://meta.test/v1', { lookup });
  assert.equal(meta.ok, false);

  // postApprovalAdvisorRequest must pin to the validated IP and never connect
  // when the endpoint fails validation.
  let spy = null;
  const requestImpl = (options, payload, done) => {
    spy = options;
    done({ status: 200, json: { choices: [{ message: { content: '{"decision":"allow"}' } }] } });
  };
  const sent = await postApprovalAdvisorRequest({
    url: 'https://public.test/v1/chat',
    apiKey: KEY,
    payload: '{"model":"m"}',
    timeoutMs: 5000,
    lookup,
    requestImpl,
  });
  assert.ok(spy, 'a valid endpoint reaches the request impl');
  assert.equal(sent.status, 200, 'the pinned request returns the provider response');
  assert.equal(spy.servername, 'public.test', 'TLS SNI/verification uses the real hostname');
  assert.equal(spy.rejectUnauthorized, true, 'certificate verification is never relaxed');
  assert.equal(spy.headers.Authorization, `Bearer ${KEY}`);
  // The pinned lookup only ever answers with the validated public IP.
  const pinned = await new Promise((resolve) => spy.lookup('public.test', { all: true }, (_err, records) => resolve(records)));
  assert.deepEqual(pinned.map((r) => r.address), ['93.184.216.34'], 'connection is pinned to the validated IP');

  spy = null;
  const blocked = await postApprovalAdvisorRequest({
    url: 'https://169.254.169.254/latest/meta-data/',
    apiKey: KEY,
    payload: '{"model":"m"}',
    timeoutMs: 5000,
    lookup,
    requestImpl,
  });
  assert.equal(blocked.error, 'ssrf');
  assert.equal(spy, null, 'a rejected endpoint must never open a connection');
}

// --- scheduling gate: idempotency, off/shadow/high-risk never scheduled ----
// The gate returns the reason next to the verdict so a skip is auditable.
{
  const settings = advisorSettings();
  const requested = new Set();
  const gate = (approvalAction, requestId, source = settings) => (
    shouldScheduleApprovalAdvisor({ approvalAction, settings: source, requestId, requested })
  );
  assert.deepEqual(gate(lowRiskReadAction, 'r1'), { eligible: true, reason: '' });
  requested.add('r1');
  assert.deepEqual(gate(lowRiskReadAction, 'r1'), { eligible: false, reason: 'already_requested' }, 'advised once per requestId');
  assert.deepEqual(gate(lowRiskReadAction, ''), { eligible: false, reason: 'no_request_id' });
  assert.deepEqual(
    gate({ ...lowRiskReadAction, risk: 'high', categories: ['secrets'] }, 'r2'),
    { eligible: false, reason: 'not_low_risk' },
  );
  assert.deepEqual(
    gate({ ...lowRiskReadAction, shadow: true }, 'r3'),
    { eligible: false, reason: 'shadow' },
  );
  assert.deepEqual(
    gate(lowRiskReadAction, 'r4', advisorSettings({ mode: 'off' })),
    { eligible: false, reason: 'mode_not_local_reads' },
  );
  assert.deepEqual(
    gate({ ...lowRiskReadAction, mode: 'shadow', shadow: true }, 'r5'),
    { eligible: false, reason: 'action_mode_mismatch' },
  );
  assert.deepEqual(
    gate(lowRiskReadAction, 'r6', advisorSettings({ key: '' })),
    { eligible: false, reason: 'no_api_key' },
  );
}

// --- advisor reply outcome + human-wins guard ------------------------------

{
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: true, replyStatus: 'sent' }), 'allow_once');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: false, replyStatus: 'sent' }), 'ask_user', 'no longer pending');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: true, replyStatus: 'not_claimed' }), 'ask_user', 'human already answered and wins');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', shadow: true, stillPending: true, replyStatus: 'sent' }), 'ask_user', 'shadow never replies');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'ask_user' }, { mode: 'local_reads', stillPending: true, replyStatus: 'sent' }), 'ask_user');
}

{
  let pending = true;
  let slept = 0;
  const still = await waitForAdvisorApplyWindow(5000, () => pending, async (ms) => {
    slept = ms;
    pending = false;
  });
  assert.equal(slept, 5000);
  assert.equal(still, false, 'a human reply during the highlight window wins');
  const kept = await waitForAdvisorApplyWindow(5000, () => true, async () => {});
  assert.equal(kept, true);
  const gone = await waitForAdvisorApplyWindow(5000, () => false, async () => {
    throw new Error('must not wait when the card is already answered');
  });
  assert.equal(gone, false);
}

// The one-shot reply guard is what makes "human wins" real: whoever claims the
// requestId first (the human card or the advisor) is the only one allowed to POST.
{
  const guard = createOpenCodePermissionReplyGuard();
  assert.equal(guard.claim('perm_read_1'), true, 'the human clicks Allow first and claims the id');
  assert.equal(guard.claim('perm_read_1'), false, 'the advisor can no longer reply for the same id');
}

// --- audit: provider/model/latency/usage/decisions/error, never the key ----
{
  const file = path.join(ISOLATED_DATA_DIR, 'advisor-test', 'audit.jsonl');
  process.env[APPROVAL_ADVISOR_API_KEY_ENV] = KEY;
  const entry = recordApprovalAdvisorAudit({
    room: { chatId: 'chat_1' },
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    plan: resolveApprovalAdvisorPlan(advisorSettings(), lowRiskReadAction),
    result: {
      advisorDecision: 'allow',
      reason: 'read only — sk-advisor-secret-0123456789 leaked?',
      confidence: 0.9,
      provider: 'advisor.example.test',
      model: 'advisor-model',
      latencyMs: 421,
      usageTokens: 105,
      usageCost: 0.0012,
      error: null,
    },
    finalDecision: 'allow_once',
    now: Date.UTC(2026, 0, 2, 3, 4, 5),
  }, { file });
  assert.ok(entry);
  assert.equal(entry.kind, 'advisor');
  assert.equal(entry.provider, 'advisor.example.test');
  assert.equal(entry.model, 'advisor-model');
  assert.equal(entry.latencyMs, 421);
  assert.equal(entry.usageTokens, 105);
  assert.equal(entry.usageCost, 0.0012);
  assert.equal(entry.advisorDecision, 'allow');
  assert.equal(entry.finalDecision, 'allow_once');
  assert.equal(entry.protocol, 'openai_chat', 'audit records the advisor protocol');
  assert.equal(entry.advisorPolicyVersion, ADVISOR_POLICY_VERSION);
  assert.equal(entry.advisorPolicyVersion, 'advisor-external-3');
  assert.equal(entry.ts, '2026-01-02T03:04:05.000Z');
  const line = JSON.stringify(entry);
  assert.equal(line.includes('sk-advisor-secret-0123456789'), false, 'audit redacts any key that slips into the reason');
  assert.equal(line.includes('Authorization'), false);
  assert.equal(readApprovalAuditEntries({ file })[0].requestId, 'perm_read_1');

  // A System One plan records its own protocol.
  const systemOneEntry = recordApprovalAdvisorAudit({
    room: { chatId: 'chat_1' },
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    plan: resolveApprovalAdvisorPlan(systemOneSettings(), lowRiskReadAction),
    result: { advisorDecision: 'ask_user', confidence: 0.4, provider: 'advisor.example.test', model: '' },
    finalDecision: 'ask_user',
    now: Date.UTC(2026, 0, 2, 3, 4, 6),
  }, { file });
  assert.equal(systemOneEntry.protocol, 'systemone');

  // off / shadow produce no advisor audit.
  assert.equal(recordApprovalAdvisorAudit({
    permissionEvent: lowRiskReadEvent,
    approvalAction: { ...lowRiskReadAction, mode: 'shadow' },
    result: { advisorDecision: 'allow' },
    finalDecision: 'ask_user',
  }, { file }), null);
  clearEnvKey();
}

// --- advisor_skip audit: every skip is recorded, not only local_reads -------
// `recordApprovalAdvisorAudit` refuses anything but `local_reads`; the skip
// writer must not, because `mode_not_local_reads` and `action_mode_mismatch`
// are exactly the skips an operator needs to see.
{
  const file = path.join(ISOLATED_DATA_DIR, 'advisor-skip-test', 'audit.jsonl');
  const action = { ...lowRiskReadAction, mode: 'shadow', shadow: true };
  process.env[APPROVAL_ADVISOR_API_KEY_ENV] = KEY;

  assert.equal(recordApprovalAdvisorAudit({
    room: { chatId: 'chat_1' },
    permissionEvent: lowRiskReadEvent,
    approvalAction: action,
    result: { advisorDecision: 'allow' },
    finalDecision: 'ask_user',
  }, { file }), null, 'the advisor entry stays mode-gated');

  // End-to-end: whatever reason the gate produced is what lands in the entry.
  const gate = shouldScheduleApprovalAdvisor({
    approvalAction: action,
    settings: advisorSettings(),
    requestId: 'perm_skip_mode',
    requested: new Set(),
  });
  assert.deepEqual(gate, { eligible: false, reason: 'action_mode_mismatch' });
  const entry = recordApprovalAdvisorSkipAudit({
    room: { chatId: 'chat_1' },
    permissionEvent: { requestId: 'perm_skip_mode' },
    approvalAction: action,
    requestId: 'perm_skip_mode',
    reason: gate.reason,
    now: Date.UTC(2026, 0, 2, 3, 4, 7),
  }, { file });
  assert.ok(entry, 'a non-local_reads skip is still audited');
  assert.equal(entry.kind, 'advisor_skip');
  assert.equal(entry.reason, 'action_mode_mismatch');
  assert.equal(entry.requestId, 'perm_skip_mode');
  assert.equal(entry.chatId, 'chat_1');
  assert.equal(entry.risk, 'low');
  assert.equal(entry.mode, 'shadow', 'the skip records the mode that caused it');
  assert.equal(entry.ts, '2026-01-02T03:04:07.000Z');
  assert.equal(entry.advisorPolicyVersion, ADVISOR_POLICY_VERSION);

  // The reason passes through the same secret scrub and length cap.
  const leaky = recordApprovalAdvisorSkipAudit({
    permissionEvent: lowRiskReadEvent,
    approvalAction: lowRiskReadAction,
    requestId: ' perm_leak ',
    reason: `no_api_key ${KEY} Authorization: Bearer tailtoken123456 ${'x'.repeat(400)}`,
  }, { file });
  assert.ok(leaky);
  assert.equal(leaky.requestId, 'perm_leak');
  assert.equal(leaky.reason.length, ADVISOR_MAX_REASON_CHARS, 'skip reason is capped like the advisor reason');
  const leakyLine = JSON.stringify(leaky);
  assert.equal(leakyLine.includes(KEY), false, 'the skip audit never carries the key');
  assert.equal(leakyLine.includes('tailtoken123456'), false, 'bearer tokens are scrubbed');

  // The caller-side guards have reasons too and need no resolved action.
  const guardEntry = recordApprovalAdvisorSkipAudit({
    permissionEvent: {},
    reason: 'no_pending_permission_map',
  }, { file });
  assert.equal(guardEntry.kind, 'advisor_skip');
  assert.equal('mode' in guardEntry, false, 'no empty mode field when nothing was classified');
  assert.equal(guardEntry.risk, 'low');
  assert.equal(recordApprovalAdvisorSkipAudit({ permissionEvent: {}, reason: 'no_request_id' }, { file }).requestId, '');

  const rows = readApprovalAuditEntries({ file });
  assert.equal(rows.filter((row) => row.kind === 'advisor').length, 0, 'a skip never writes an advisor row');
  assert.equal(rows.filter((row) => row.kind === 'advisor_skip').length, 4);
  clearEnvKey();
}

// --- GET/meta must never surface the key -----------------------------------
{
  clearEnvKey();
  const settings = advisorSettings();
  const meta = getApprovalAdvisorMetaForClient(settings);
  assert.equal(meta.approvalAdvisorKeyEffective, true);
  assert.equal(meta.approvalAdvisorKeyStoredInSettings, true);
  assert.equal(Object.values(meta).includes(KEY), false, 'client meta never contains the key');
  const brokerView = normalizeApprovalBrokerSettings(settings.approvalBroker);
  assert.equal(JSON.stringify(brokerView).includes(KEY), false, 'the persisted advisor block never carries the key');
  assert.equal(JSON.stringify(meta).toLowerCase().includes('authorization'), false);
  assert.equal(brokerView.advisor.baseUrl, BASE_URL);
  assert.equal(brokerView.advisor.enabled, true);
}

// --- a real low-risk interactive read stays eligible end-to-end ------------
{
  // Prove the eligibility hook matches the actual local decision (not just a
  // hand-built action): an interactive read outside the workspace is ask_user +
  // low risk with no categories, so it is the advisor's target case.
  const action = resolveOpenCodeApprovalAction({
    mode: 'local_reads',
    sdkMode: 'agent',
    permissionEvent: { requestId: 'perm_outside', action: 'read', resources: ['/tmp/scratch-note.txt'] },
    assignment: '',
    workspaceFolder: path.join(ISOLATED_DATA_DIR, 'elsewhere'),
  });
  assert.equal(action.decision, 'ask_user');
  assert.equal(action.risk, 'low');
  assert.equal(action.shadow, false);
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings(), action).eligible, true);
}

clearEnvKey();
console.log('approval-advisor.test.js OK');
