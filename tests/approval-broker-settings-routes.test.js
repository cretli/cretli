/**
 * Approval Broker settings route contract tests.
 *
 * Boots the real `registerSettingsRoutes` handlers against the isolated data
 * dir and checks the GET/PATCH contract used by the OpenCode settings panel:
 * safe defaults, advisor metadata only, write-only key, env precedence and
 * clear-only-stored semantics. No network and no real HTTP server.
 */
import './helpers/isolated-data-dir.js';
import { buildCanUseToolGrantKeys, saveCanUseToolGrant, hasCanUseToolGrant } from '../lib/approval/can-use-tool-grants.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerSettingsRoutes } from '../lib/routes/settings-routes.js';
import {
  APPROVAL_ADVISOR_API_KEY_ENV,
  resolveApprovalAdvisorPlan,
} from '../lib/approval/approval-advisor.js';
import { loadSettings } from '../lib/persist/settings.js';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';

test.after(() => {
  removeIsolatedDataDir();
});

const STORED_KEY = 'sk-advisor-test-stored-0123456789';
const ENV_KEY = 'sk-advisor-test-env-9876543210';
const ENDPOINT = 'https://advisor.example.test/v1/chat/completions';

/**
 * Register the settings routes on a tiny fake express app and expose typed
 * invokers that resolve `{ status, body }`.
 */
function createSettingsClient() {
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  const app = {
    get(path, fn) {
      handlers.set(`GET ${path}`, fn);
    },
    patch(path, fn) {
      handlers.set(`PATCH ${path}`, fn);
    },
    post(path, fn) {
      handlers.set(`POST ${path}`, fn);
    },
  };
  const ctx = {
    port: 0,
    useHttps: false,
    serverInstanceToken: 'test-instance-token',
    frontHmrEnabled: false,
    frontHmrForcedByEnv: false,
    frontHotFallbackEnabled: false,
    getLanHost: () => null,
    getConfiguredWorkspaceSelection: () => ({ workspaceFile: '', workspaceFolder: '' }),
    isSessionSyncEnabled: () => false,
    resolveFrontHmrEnabledFromSettings: () => false,
  };
  registerSettingsRoutes(app, ctx);

  function call(method, body, url = '/api/settings') {
    const handler = handlers.get(`${method} ${url}`);
    assert.ok(handler, `missing ${method} /api/settings handler`);
    const req = { body: body || {}, headers: {} };
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          resolve({ status: this.statusCode, body: payload });
        },
      };
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((err) => resolve({ status: 500, body: { ok: false, error: err?.message || String(err) } }));
    });
  }

  return {
    grants: () => call('GET', null, '/api/approval-broker/grants'),
    revoke: (ids) => call('POST', { ids }, '/api/approval-broker/grants/revoke'),
    get: () => call('GET'),
    patch: (body) => call('PATCH', body),
  };
}

test('approval settings default to off with key-free advisor metadata', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const res = await client.get();
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.approvalBroker.mode, 'off');
  assert.equal(res.body.approvalBroker.policyVersion, 'opencode-local-1');
  assert.equal(Object.prototype.hasOwnProperty.call(res.body.approvalBroker, 'advisor'), false);
  assert.equal(res.body.approvalAdvisorEnabled, false);
  assert.equal(res.body.approvalAdvisorEndpointConfigured, false);
  assert.equal(res.body.approvalAdvisorKeyEffective, false);
  assert.equal(res.body.approvalAdvisorKeyFromEnv, false);
  assert.equal(res.body.approvalAdvisorKeyStoredInSettings, false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.body, 'approvalAdvisorApiKey'), false);
});

test('PATCH persists broker mode and advisor config without a key', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const patched = await client.patch({
    approvalBroker: {
      mode: 'local_reads',
      policyVersion: 'hacked-version',
      advisor: {
        enabled: true,
        protocol: 'systemone',
        baseUrl: ENDPOINT,
        model: 'advisor-model',
        minProbability: 0.75,
        timeoutMs: 6000,
        dailyQuota: 50,
      },
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.ok, true);
  assert.equal(patched.body.approvalBroker.mode, 'local_reads');
  assert.equal(patched.body.approvalBroker.policyVersion, 'opencode-local-1', 'policyVersion must not be client-controlled');
  assert.deepEqual(patched.body.approvalBroker.advisor, {
    enabled: true,
    protocol: 'systemone',
    baseUrl: ENDPOINT,
    model: 'advisor-model',
    minProbability: 0.75,
    timeoutMs: 6000,
    dailyQuota: 50,
    riskScope: 'low_only',
    sendSensitiveCommand: false,
  });
  assert.equal(patched.body.approvalAdvisorEnabled, true);
  assert.equal(patched.body.approvalAdvisorEndpointConfigured, true);

  const reloaded = await client.get();
  assert.equal(reloaded.body.approvalBroker.mode, 'local_reads');
  assert.deepEqual(reloaded.body.approvalBroker.advisor, {
    enabled: true,
    protocol: 'systemone',
    baseUrl: ENDPOINT,
    model: 'advisor-model',
    minProbability: 0.75,
    timeoutMs: 6000,
    dailyQuota: 50,
    riskScope: 'low_only',
    sendSensitiveCommand: false,
  });
});

test('PATCH persists riskScope and sendSensitiveCommand; unknown riskScope falls back to low_only', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const scoped = await client.patch({
    approvalBroker: {
      mode: 'local_reads',
      advisor: {
        enabled: true,
        baseUrl: ENDPOINT,
        model: 'advisor-model',
        riskScope: 'advise_all',
        sendSensitiveCommand: true,
      },
    },
  });
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.approvalBroker.advisor.riskScope, 'advise_all');
  assert.equal(scoped.body.approvalBroker.advisor.sendSensitiveCommand, true);

  const reloaded = await client.get();
  assert.equal(reloaded.body.approvalBroker.advisor.riskScope, 'advise_all');
  assert.equal(reloaded.body.approvalBroker.advisor.sendSensitiveCommand, true);

  const unknownScope = await client.patch({
    approvalBroker: {
      mode: 'local_reads',
      advisor: { riskScope: 'totally_invalid' },
    },
  });
  assert.equal(unknownScope.body.approvalBroker.advisor.riskScope, 'low_only');
});

test('PATCH normalizes unknown protocol and out-of-range minProbability instead of rejecting', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const patched = await client.patch({
    approvalBroker: {
      mode: 'local_reads',
      advisor: {
        enabled: true,
        protocol: 'yolo',
        baseUrl: ENDPOINT,
        model: 'advisor-model',
        minProbability: 5,
      },
    },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.ok, true);
  assert.equal(patched.body.approvalBroker.advisor.protocol, 'openai_chat', 'unknown protocol normalizes to openai_chat');
  assert.equal(patched.body.approvalBroker.advisor.minProbability, 0.99, 'minProbability clamps to 0.99');

  const lowered = await client.patch({
    approvalBroker: { mode: 'local_reads', advisor: { minProbability: 0.1 } },
  });
  assert.equal(lowered.body.approvalBroker.advisor.minProbability, 0.5, 'minProbability clamps to 0.5');
  assert.equal(lowered.body.approvalBroker.advisor.protocol, 'openai_chat');
});

test('switching mode back to off keeps the advisor block but the mode gate deactivates it', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  await client.patch({ approvalBroker: { mode: 'off' } });
  const res = await client.get();
  assert.equal(res.body.approvalBroker.mode, 'off');
  assert.equal(res.body.approvalBroker.advisor.baseUrl, ENDPOINT);
  // The mode gate — not the stored advisor flag — is what prevents a network
  // call; prove it with the same pure resolver the websocket path uses.
  const plan = resolveApprovalAdvisorPlan(loadSettings(), {
    decision: 'allow',
    risk: 'low',
    categories: [],
    mode: 'local_reads',
  });
  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'mode_not_local_reads');
});

test('stored advisor key is write-only; Clear removes only the stored key', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const saved = await client.patch({ approvalAdvisorApiKey: `  ${STORED_KEY}  ` });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.approvalAdvisorKeyStoredInSettings, true);
  assert.equal(saved.body.approvalAdvisorKeyEffective, true);
  assert.equal(saved.body.approvalAdvisorKeyFromEnv, false);
  assert.equal(JSON.stringify(saved.body).includes(STORED_KEY), false, 'response must never echo the key');

  const afterSave = await client.get();
  assert.equal(afterSave.body.approvalAdvisorKeyStoredInSettings, true);
  assert.equal(JSON.stringify(afterSave.body).includes(STORED_KEY), false, 'GET must never expose the key');

  const cleared = await client.patch({ clearApprovalAdvisorApiKey: true });
  assert.equal(cleared.body.approvalAdvisorKeyStoredInSettings, false);
  assert.equal(cleared.body.approvalAdvisorKeyEffective, false);
  assert.equal(JSON.stringify(cleared.body).includes(STORED_KEY), false);
});

test('env key takes precedence and survives clearing the stored key', async () => {
  process.env[APPROVAL_ADVISOR_API_KEY_ENV] = ENV_KEY;
  try {
    const client = createSettingsClient();

    const fromEnv = await client.get();
    assert.equal(fromEnv.body.approvalAdvisorKeyFromEnv, true);
    assert.equal(fromEnv.body.approvalAdvisorKeyEffective, true);
    assert.equal(JSON.stringify(fromEnv.body).includes(ENV_KEY), false, 'GET must never expose the env key');

    const stored = await client.patch({ approvalAdvisorApiKey: STORED_KEY });
    assert.equal(stored.body.approvalAdvisorKeyFromEnv, true, 'env still wins after saving a stored key');
    assert.equal(stored.body.approvalAdvisorKeyStoredInSettings, true);
    assert.equal(JSON.stringify(stored.body).includes(STORED_KEY), false);
    assert.equal(JSON.stringify(stored.body).includes(ENV_KEY), false);

    const cleared = await client.patch({ clearApprovalAdvisorApiKey: true });
    assert.equal(cleared.body.approvalAdvisorKeyStoredInSettings, false, 'Clear removes the stored key');
    assert.equal(cleared.body.approvalAdvisorKeyFromEnv, true, 'Clear must not touch the env key');
    assert.equal(cleared.body.approvalAdvisorKeyEffective, true);
  } finally {
    delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  }
});

test('a tampered advisor.enabled outside local_reads still cannot reach the network', async () => {
  delete process.env[APPROVAL_ADVISOR_API_KEY_ENV];
  const client = createSettingsClient();

  const patched = await client.patch({
    approvalBroker: {
      mode: 'shadow',
      advisor: { enabled: true, baseUrl: ENDPOINT, model: 'advisor-model' },
    },
  });
  assert.equal(patched.body.approvalBroker.mode, 'shadow');
  // The raw API keeps the stored flag, but the mode gate makes the advisor
  // ineligible, so a stale/tampered flag can never widen automation.
  const plan = resolveApprovalAdvisorPlan(loadSettings(), {
    decision: 'allow',
    risk: 'low',
    categories: [],
    mode: 'local_reads',
  });
  assert.equal(plan.eligible, false);
  assert.equal(plan.reason, 'mode_not_local_reads');
});

test('permission management lists safe metadata and revokes only selected grants', async () => {
  const client = createSettingsClient();
  const claude = buildCanUseToolGrantKeys({ harness: 'claude', workspace: '/workspace/my-app', toolName: 'Bash', input: { command: 'echo private-argument' } });
  const qwen = buildCanUseToolGrantKeys({ harness: 'qwen', workspace: '/workspace/my-app', toolName: 'Write' });
  saveCanUseToolGrant(claude, 'tool');
  saveCanUseToolGrant(qwen, 'harness');
  const listed = await client.grants();
  assert.equal(listed.status, 200);
  assert.equal(listed.body.grants.length, 2);
  const row = listed.body.grants.find((grant) => grant.harness === 'claude');
  assert.equal(row.workspace, 'my-app');
  assert.equal(row.toolName, 'Bash');
  assert.equal(row.scope, 'tool');
  assert.ok(!JSON.stringify(listed.body).includes('/workspace'));
  assert.ok(!JSON.stringify(listed.body).includes('private-argument'));
  const invalid = await client.revoke(['invalid']);
  assert.equal(invalid.status, 400);
  assert.equal(hasCanUseToolGrant(claude), true);
  const revoked = await client.revoke([row.id]);
  assert.equal(revoked.body.revoked, 1);
  assert.equal(hasCanUseToolGrant(claude), false);
  assert.equal(hasCanUseToolGrant(qwen), true);
  const remaining = await client.grants();
  assert.equal((await client.revoke(remaining.body.grants.map((grant) => grant.id))).body.revoked, 1);
  assert.deepEqual((await client.grants()).body.grants, []);
});

test('harness category controls persist through settings PATCH and GET without replacing other harnesses', async () => {
  const client = createSettingsClient();
  const defaults = await client.get();
  assert.equal(defaults.body.harnessPermissionControls.claude.files, true);
  const patched = await client.patch({ harnessPermissionControls: { claude: { files: false, mcp: false } } });
  assert.equal(patched.body.harnessPermissionControls.claude.files, false);
  assert.equal(patched.body.harnessPermissionControls.qwen.files, true);
  await client.patch({ harnessPermissionControls: { qwen: { shell: false }, claude: { web: 'false' } } });
  const reread = await client.get();
  assert.equal(reread.body.harnessPermissionControls.claude.files, false);
  assert.equal(reread.body.harnessPermissionControls.claude.mcp, false);
  assert.equal(reread.body.harnessPermissionControls.claude.web, true);
  assert.equal(reread.body.harnessPermissionControls.qwen.shell, false);
  assert.equal(loadSettings().harnessPermissionControls.qwen.shell, false);
  await client.patch({ harnessPermissionControls: { claude: { files: true } } });
  assert.equal((await client.get()).body.harnessPermissionControls.claude.files, true);
});
