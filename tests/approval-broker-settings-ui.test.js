/**
 * Approval Broker settings UI contract tests.
 *
 * These exercise the pure panel helpers (form normalization, payload building,
 * endpoint validation, key-source metadata) and the API payload whitelist. They
 * deliberately never touch the DOM or the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADVISOR_DEFAULT_DAILY_QUOTA,
  ADVISOR_DEFAULT_MIN_PROBABILITY,
  ADVISOR_DEFAULT_PROTOCOL,
  ADVISOR_DEFAULT_TIMEOUT_MS,
  ADVISOR_MAX_DAILY_QUOTA,
  ADVISOR_MAX_MIN_PROBABILITY,
  ADVISOR_MAX_TIMEOUT_MS,
  ADVISOR_MIN_MIN_PROBABILITY,
  ADVISOR_MIN_TIMEOUT_MS,
  APPROVAL_ADVISOR_PROTOCOLS,
  APPROVAL_BROKER_MODES,
  buildApprovalAdvisorPatch,
  buildApprovalBrokerModePatch,
  clampAdvisorDailyQuota,
  clampAdvisorMinProbability,
  clampAdvisorTimeoutMs,
  getAdvisorKeySource,
  isAdvisorFieldsetEnabled,
  isPrivateOrLocalHost,
  normalizeAdvisorProtocol,
  normalizeApprovalBrokerFormState,
  validateAdvisorEndpointForUi,
} from '../app_front/features/approval/approvalBrokerSettings.js';
import { buildApprovalSettingsPatch } from '../app_front/api.js';

// --- defaults fail closed --------------------------------------------------

assert.deepEqual(APPROVAL_BROKER_MODES, ['off', 'shadow', 'local_reads']);
assert.deepEqual(normalizeApprovalBrokerFormState(null), {
  mode: 'off',
  enabled: false,
  protocol: ADVISOR_DEFAULT_PROTOCOL,
  baseUrl: '',
  model: '',
  minProbability: ADVISOR_DEFAULT_MIN_PROBABILITY,
  timeoutMs: ADVISOR_DEFAULT_TIMEOUT_MS,
  dailyQuota: ADVISOR_DEFAULT_DAILY_QUOTA,
  riskScope: 'low_only',
});
assert.deepEqual(normalizeApprovalBrokerFormState({}), {
  mode: 'off',
  enabled: false,
  protocol: ADVISOR_DEFAULT_PROTOCOL,
  baseUrl: '',
  model: '',
  minProbability: ADVISOR_DEFAULT_MIN_PROBABILITY,
  timeoutMs: ADVISOR_DEFAULT_TIMEOUT_MS,
  dailyQuota: ADVISOR_DEFAULT_DAILY_QUOTA,
  riskScope: 'low_only',
});
assert.equal(normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'yolo' } }).mode, 'off');
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'SHADOW' } }).mode,
  'shadow',
  'mode must be case-insensitive',
);
assert.deepEqual(APPROVAL_ADVISOR_PROTOCOLS, ['openai_chat', 'systemone']);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'local_reads', advisor: { protocol: 'systemone' } } }).protocol,
  'systemone',
);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'local_reads', advisor: { protocol: 'bogus' } } }).protocol,
  'openai_chat',
  'unknown protocol fails closed to openai_chat',
);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'local_reads', advisor: { minProbability: 0.1 } } }).minProbability,
  ADVISOR_MIN_MIN_PROBABILITY,
);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'local_reads', advisor: { minProbability: 5 } } }).minProbability,
  ADVISOR_MAX_MIN_PROBABILITY,
);

// The advisor can only be enabled in local_reads, even if a stale settings file
// says otherwise, so first-run can never activate it.
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'off', advisor: { enabled: true } } }).enabled,
  false,
);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'shadow', advisor: { enabled: true } } }).enabled,
  false,
);
assert.equal(
  normalizeApprovalBrokerFormState({ approvalBroker: { mode: 'local_reads', advisor: { enabled: true } } }).enabled,
  true,
);

assert.equal(isAdvisorFieldsetEnabled('off'), false);
assert.equal(isAdvisorFieldsetEnabled('shadow'), false);
assert.equal(isAdvisorFieldsetEnabled('local_reads'), true);
assert.equal(isAdvisorFieldsetEnabled('bogus'), false);

// --- clamping --------------------------------------------------------------

assert.equal(clampAdvisorTimeoutMs(undefined), ADVISOR_DEFAULT_TIMEOUT_MS);
assert.equal(clampAdvisorTimeoutMs('abc'), ADVISOR_DEFAULT_TIMEOUT_MS);
assert.equal(clampAdvisorTimeoutMs(1), ADVISOR_MIN_TIMEOUT_MS);
assert.equal(clampAdvisorTimeoutMs(999999), ADVISOR_MAX_TIMEOUT_MS);
assert.equal(clampAdvisorTimeoutMs(6000), 6000);
assert.equal(clampAdvisorDailyQuota(undefined), ADVISOR_DEFAULT_DAILY_QUOTA);
assert.equal(clampAdvisorDailyQuota(-40), 0);
assert.equal(clampAdvisorDailyQuota(0), 0);
assert.equal(clampAdvisorDailyQuota(999999), ADVISOR_MAX_DAILY_QUOTA);
assert.equal(clampAdvisorDailyQuota(250), 250);
assert.equal(clampAdvisorMinProbability(undefined), ADVISOR_DEFAULT_MIN_PROBABILITY);
assert.equal(clampAdvisorMinProbability('abc'), ADVISOR_DEFAULT_MIN_PROBABILITY);
assert.equal(clampAdvisorMinProbability(0.1), ADVISOR_MIN_MIN_PROBABILITY);
assert.equal(clampAdvisorMinProbability(5), ADVISOR_MAX_MIN_PROBABILITY);
assert.equal(clampAdvisorMinProbability(0.75), 0.75);
assert.equal(normalizeAdvisorProtocol('SYSTEMONE'), 'systemone');
assert.equal(normalizeAdvisorProtocol('bogus'), ADVISOR_DEFAULT_PROTOCOL);

// --- payloads --------------------------------------------------------------

assert.deepEqual(buildApprovalBrokerModePatch('shadow'), { approvalBroker: { mode: 'shadow' } });
assert.deepEqual(buildApprovalBrokerModePatch('nonsense'), { approvalBroker: { mode: 'off' } });
assert.equal(
  Object.prototype.hasOwnProperty.call(buildApprovalBrokerModePatch('local_reads').approvalBroker, 'advisor'),
  false,
  'the immediate mode switch must never carry advisor fields',
);
assert.equal(
  Object.prototype.hasOwnProperty.call(buildApprovalBrokerModePatch('local_reads').approvalBroker, 'policyVersion'),
  false,
  'the UI must never PATCH policyVersion',
);

const advisorPatch = buildApprovalAdvisorPatch({
  mode: 'local_reads',
  enabled: true,
  protocol: 'systemone',
  baseUrl: '  https://advisor.example.test/v1/chat/completions  ',
  model: '  advisor-model  ',
  minProbability: 0.8,
  timeoutMs: 9000,
  dailyQuota: 123,
});
assert.deepEqual(advisorPatch, {
  approvalBroker: {
    mode: 'local_reads',
    advisor: {
      enabled: true,
      protocol: 'systemone',
      baseUrl: 'https://advisor.example.test/v1/chat/completions',
      model: 'advisor-model',
      minProbability: 0.8,
      timeoutMs: ADVISOR_MAX_TIMEOUT_MS,
      dailyQuota: 123,
      riskScope: 'low_only',
    },
  },
});
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true }).approvalBroker.advisor.protocol,
  'openai_chat',
  'protocol defaults to openai_chat',
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true }).approvalBroker.advisor.minProbability,
  ADVISOR_DEFAULT_MIN_PROBABILITY,
  'minProbability defaults to 0.9',
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true, protocol: 'bogus' }).approvalBroker.advisor.protocol,
  'openai_chat',
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true, protocol: 'systemone', minProbability: 0.1 }).approvalBroker.advisor.minProbability,
  ADVISOR_MIN_MIN_PROBABILITY,
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'off', enabled: true }).approvalBroker.advisor.enabled,
  false,
  'off must force advisor.enabled=false even if the form was tampered with',
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'shadow', enabled: true }).approvalBroker.advisor.enabled,
  false,
  'shadow must force advisor.enabled=false',
);
assert.equal(
  buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: false }).approvalBroker.advisor.enabled,
  false,
  'an explicitly disabled advisor stays disabled',
);
assert.equal(buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true, timeoutMs: 1 }).approvalBroker.advisor.timeoutMs, ADVISOR_MIN_TIMEOUT_MS);
assert.equal(buildApprovalAdvisorPatch({ mode: 'local_reads', enabled: true, dailyQuota: -1 }).approvalBroker.advisor.dailyQuota, 0);

// --- endpoint validation (UX only; the server re-validates) ----------------

assert.deepEqual(validateAdvisorEndpointForUi(''), { ok: false, reason: 'empty' });
assert.deepEqual(validateAdvisorEndpointForUi('not a url'), { ok: false, reason: 'invalid' });
assert.deepEqual(validateAdvisorEndpointForUi('http://provider.example/v1/chat/completions'), { ok: false, reason: 'not_https' });
assert.deepEqual(validateAdvisorEndpointForUi('https://user:pass@provider.example/v1'), { ok: false, reason: 'userinfo' });
assert.deepEqual(validateAdvisorEndpointForUi('https://localhost/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://127.0.0.1/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://10.1.2.3/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://192.168.0.10/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://169.254.169.254/latest/meta-data'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://172.16.5.5/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://[::1]/v1'), { ok: false, reason: 'private_host' });
assert.deepEqual(validateAdvisorEndpointForUi('https://api.provider.example/v1/chat/completions'), { ok: true, reason: '' });

assert.equal(isPrivateOrLocalHost('example.com'), false);
assert.equal(isPrivateOrLocalHost('sub.example.com'), false);
assert.equal(isPrivateOrLocalHost('8.8.8.8'), false);
assert.equal(isPrivateOrLocalHost('localhost'), true);
assert.equal(isPrivateOrLocalHost('foo.local'), true);
assert.equal(isPrivateOrLocalHost('fd00::1'), true);
assert.equal(isPrivateOrLocalHost('fe80::1'), true);

// --- key metadata (never the value) ---------------------------------------

assert.equal(getAdvisorKeySource(undefined), 'missing');
assert.equal(getAdvisorKeySource({}), 'missing');
assert.equal(getAdvisorKeySource({ approvalAdvisorKeyStoredInSettings: true }), 'stored');
assert.equal(getAdvisorKeySource({ approvalAdvisorKeyFromEnv: true }), 'env');
assert.equal(
  getAdvisorKeySource({ approvalAdvisorKeyFromEnv: true, approvalAdvisorKeyStoredInSettings: true }),
  'env',
  'env must win over a stored key',
);

// --- API payload whitelist -------------------------------------------------

assert.deepEqual(
  buildApprovalSettingsPatch({
    approvalBroker: { mode: 'shadow' },
    approvalAdvisorApiKey: '  sk-secret-123  ',
    clearApprovalAdvisorApiKey: true,
    lanHost: 'evil.example',
    enabledHarnesses: ['sdk'],
    policyVersion: 'hacked',
  }),
  {
    approvalBroker: { mode: 'shadow' },
    approvalAdvisorApiKey: 'sk-secret-123',
    clearApprovalAdvisorApiKey: true,
  },
  'unknown keys (including policyVersion) must be dropped',
);
assert.deepEqual(buildApprovalSettingsPatch({ approvalAdvisorApiKey: '   ' }), {}, 'an empty key must never be sent');
assert.deepEqual(buildApprovalSettingsPatch(null), {});
assert.deepEqual(buildApprovalSettingsPatch('nonsense'), {});
assert.deepEqual(buildApprovalSettingsPatch({ clearApprovalAdvisorApiKey: true }), { clearApprovalAdvisorApiKey: true });
assert.deepEqual(buildApprovalSettingsPatch({ clearApprovalAdvisorApiKey: false }), { clearApprovalAdvisorApiKey: false });

// --- static markup wiring (OpenCode tab, not a new top-level tab) ----------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');

const sectionMatch = indexHtml.match(/<section[^>]*id="opencode-approval-broker-settings"[^>]*>/);
assert.ok(sectionMatch, 'the approval broker settings section must exist');
assert.match(
  sectionMatch[0],
  /data-settings-tab="harness-opencode-approvals"/,
  'the panel must live in the OpenCode permissions sub-tab',
);
assert.equal(
  /data-settings-tab="approval"/.test(indexHtml),
  false,
  'the panel must not create a new top-level settings tab',
);

for (const id of [
  'approval-broker-mode-select',
  'approval-broker-mode-status',
  'approval-advisor-enabled-checkbox',
  'approval-advisor-protocol-select',
  'approval-advisor-endpoint-field',
  'approval-advisor-endpoint-input',
  'approval-advisor-endpoint-status',
  'approval-advisor-model-input',
  'approval-advisor-min-probability-input',
  'approval-advisor-timeout-input',
  'approval-advisor-quota-input',
  'approval-advisor-save-btn',
  'approval-advisor-api-key-input',
  'approval-advisor-api-key-save-btn',
  'approval-advisor-api-key-clear-btn',
  'approval-advisor-key-source-hint',
]) {
  assert.equal(indexHtml.includes(`id="${id}"`), true, `missing element #${id}`);
}

assert.match(indexHtml, /id="approval-advisor-min-probability-input"[^>]*min="0.5"[^>]*max="0.99"/);
assert.match(indexHtml, /id="approval-advisor-timeout-input"[^>]*min="3000"[^>]*max="8000"/);
assert.match(indexHtml, /id="approval-advisor-quota-input"[^>]*min="0"[^>]*max="10000"/);

const richViewPath = path.join(projectRoot, 'app_front/lib/sdk-rich-view.js');
const richView = fs.readFileSync(richViewPath, 'utf8');
assert.match(richView, /showOpenCodePermissionAdvisorStatus\(requestId, meta = \{\}\)/);
assert.match(richView, /markOpenCodePermissionAdvisorStatus\(block, id, meta\)/);
for (const locale of ['en', 'pl']) {
  const dictionary = fs.readFileSync(path.join(projectRoot, `app_front/i18n/${locale}.js`), 'utf8');
  assert.match(dictionary, /openCodePermissionAdvisorStatus:\s*\{/);
  assert.match(dictionary, /checking: .*Jev advisor|checking: .*Advisor JEV/);
  assert.match(dictionary, /skipped: .*not consulted|skipped: .*nie wywołano/);
}

const permissionHandler = fs.readFileSync(path.join(projectRoot, 'lib/opencode/opencode-agent-ws.js'), 'utf8');
assert.match(permissionHandler, /type: 'opencodePermissionAdvisorStatus'[\s\S]{0,120}status: 'checking'/);
assert.match(permissionHandler, /recordApprovalAdvisorAudit\(\{/);
assert.match(permissionHandler, /const error = 'advisor_run_exception'/);
assert.match(
  indexHtml,
  /data-i18n="settings\.approvalAdvisorProtocolHint"[^>]*>[^<]*api\.typesafe\.ai\/v1\/systemone/,
  'the Jev/System One preset hint must be visible in the panel',
);
assert.equal(
  indexHtml.includes('CRETLI_APPROVAL_ADVISOR_API_KEY'),
  true,
  'the env-precedence hint must be visible in the panel',
);

console.log('approval-broker-settings-ui.test.js OK');
