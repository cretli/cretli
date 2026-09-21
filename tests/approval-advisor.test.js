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
  normalizeApprovalBrokerSettings,
  readApprovalBrokerMode,
} from '../lib/approval/approval-broker.js';
import {
  ADVISOR_MAX_REASON_CHARS,
  APPROVAL_ADVISOR_API_KEY_ENV,
  buildAdvisorPermissionTuple,
  buildAdvisorRequestBody,
  getApprovalAdvisorMetaForClient,
  getEffectiveApprovalAdvisorApiKey,
  parseAdvisorCompletion,
  postApprovalAdvisorRequest,
  readApprovalAdvisorSettings,
  recordApprovalAdvisorAudit,
  requestApprovalAdvisor,
  resetApprovalAdvisorQuota,
  resolveAdvisorReplyOutcome,
  resolveApprovalAdvisorPlan,
  shouldScheduleApprovalAdvisor,
  validateApprovalAdvisorEndpoint,
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
  baseUrl: '',
  model: '',
  timeoutMs: 5000,
  dailyQuota: 100,
});

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

// A medium-risk mutation is also ineligible.
{
  const editAction = { mode: 'local_reads', decision: 'ask_user', risk: 'medium', categories: ['mutation'], shadow: false };
  assert.equal(resolveApprovalAdvisorPlan(advisorSettings(), editAction).eligible, false);
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
  assert.equal(plan.timeoutMs, 5000);
}

assert.equal(
  resolveApprovalAdvisorPlan(advisorSettings({ model: '' }), lowRiskReadAction).reason,
  'no_model',
  'missing model must not trigger a provider request',
);

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
{
  const settings = advisorSettings();
  const requested = new Set();
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: lowRiskReadAction, settings, requestId: 'r1', requested }), true);
  requested.add('r1');
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: lowRiskReadAction, settings, requestId: 'r1', requested }), false, 'advised once per requestId');
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: lowRiskReadAction, settings, requestId: '', requested }), false);
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: { ...lowRiskReadAction, risk: 'high', categories: ['secrets'] }, settings, requestId: 'r2', requested }), false);
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: { ...lowRiskReadAction, shadow: true }, settings, requestId: 'r3', requested }), false);
  assert.equal(shouldScheduleApprovalAdvisor({ approvalAction: lowRiskReadAction, settings: advisorSettings({ mode: 'off' }), requestId: 'r4', requested }), false);
}

// --- advisor reply outcome + human-wins guard ------------------------------

{
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: true, replyStatus: 'sent' }), 'allow_once');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: false, replyStatus: 'sent' }), 'ask_user', 'no longer pending');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', stillPending: true, replyStatus: 'not_claimed' }), 'ask_user', 'human already answered and wins');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'allow' }, { mode: 'local_reads', shadow: true, stillPending: true, replyStatus: 'sent' }), 'ask_user', 'shadow never replies');
  assert.equal(resolveAdvisorReplyOutcome({ advisorDecision: 'ask_user' }, { mode: 'local_reads', stillPending: true, replyStatus: 'sent' }), 'ask_user');
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
  assert.equal(entry.ts, '2026-01-02T03:04:05.000Z');
  const line = JSON.stringify(entry);
  assert.equal(line.includes('sk-advisor-secret-0123456789'), false, 'audit redacts any key that slips into the reason');
  assert.equal(line.includes('Authorization'), false);
  assert.equal(readApprovalAuditEntries({ file })[0].requestId, 'perm_read_1');

  // off / shadow produce no advisor audit.
  assert.equal(recordApprovalAdvisorAudit({
    permissionEvent: lowRiskReadEvent,
    approvalAction: { ...lowRiskReadAction, mode: 'shadow' },
    result: { advisorDecision: 'allow' },
    finalDecision: 'ask_user',
  }, { file }), null);
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
