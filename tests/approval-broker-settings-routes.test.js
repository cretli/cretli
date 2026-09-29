/**
 * Approval Broker settings route contract tests.
 *
 * Boots the real `registerSettingsRoutes` handlers against the isolated data
 * dir and checks the GET/PATCH contract used by the OpenCode settings panel:
 * safe defaults, advisor metadata only, write-only key, env precedence and
 * clear-only-stored semantics. No network and no real HTTP server.
 */
import './helpers/isolated-data-dir.js';
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

  function call(method, body) {
    const handler = handlers.get(`${method} /api/settings`);
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
  });
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
