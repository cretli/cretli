import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools, getBuiltinMcpReadTools } from '../lib/mcp/mcp-policy.js';
import { appendUsageEvent } from '../lib/persist/usage-persist.js';
import { loadSettings } from '../lib/persist/settings.js';

after(() => removeIsolatedDataDir());

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mcp-'));
const parent = addChat('s-usage', 'Usage', null, workspace, 'm', { agentTransport: 'opencode', sdkMode: 'agent' });
const child = addChat('s-usage-c', 'Child', null, workspace, 'm', {
  agentTransport: 'opencode', sdkMode: 'agent', delegationParentChatId: parent.id,
});

function handlersFor(chat, mode = 'agent') {
  const client = createInProcessMcpClient({ harness: 'opencode', chatId: chat.id, workspaceFolder: workspace });
  return createCretliMcpToolHandlers(client, {
    chatId: chat.id, workspaceFolder: workspace, harness: 'opencode', mode, builtinClient: client,
  });
}

test('usage tools: reads are read-only, settings writes are mutating', () => {
  const reads = getBuiltinMcpReadTools();
  const writes = getBuiltinMcpMutatingTools();
  for (const name of ['usage_summary', 'usage_plan_limits', 'usage_settings', 'billing_forecast']) {
    assert.ok(reads.includes(name), name);
  }
  for (const name of ['usage_settings_set', 'usage_resume_stop']) {
    assert.ok(writes.includes(name), name);
  }
});

test('usage_summary returns the same totals the Usage tab reads', async () => {
  const at = new Date().toISOString();
  appendUsageEvent({ at, harness: 'opencode', model: 'm1', inputTokens: 100, outputTokens: 20 });
  const res = await handlersFor(parent).usage_summary({ range: '24h', tz: 'UTC' });
  assert.equal(res.isError, false, res.content?.[0]?.text);
  const summary = res.structuredContent.summary;
  assert.ok(summary, 'summary present');
  assert.ok(summary.buckets && summary.kpi && summary.coverage);
  assert.equal(res.structuredContent.tz, 'UTC');
});

test('usage_summary rejects an invalid window', async () => {
  const res = await handlersFor(parent).usage_summary({ range: 'forever' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /VALIDATION_ERROR/);
});

test('usage_plan_limits answers without waiting for a slow Codex read', async () => {
  const started = Date.now();
  const res = await handlersFor(parent).usage_plan_limits({});
  assert.equal(res.isError, false, res.content?.[0]?.text);
  assert.ok(Array.isArray(res.structuredContent.planLimits));
  assert.ok(Array.isArray(res.structuredContent.lockouts));
  assert.ok(Date.now() - started < 6000);
});

test('usage_settings_set writes usage and auto-resume settings; show reads them back', async () => {
  const h = handlersFor(parent);
  const res = await h.usage_settings_set({
    usage: { retentionDays: 45, alerts: { budget: true, dailyBudgetUsd: 3.5 } },
    limit_resume: { enabled: true, maxChain: 1 },
  });
  assert.equal(res.isError, false, res.content?.[0]?.text);
  assert.equal(res.structuredContent.usage.retentionDays, 45);
  assert.equal(res.structuredContent.usage.alerts.budget, true);
  assert.equal(res.structuredContent.limitResume.enabled, true);
  assert.equal(res.structuredContent.limitResume.maxChain, 1);
  assert.equal(loadSettings().usage.retentionDays, 45);
  const shown = await h.usage_settings({});
  assert.equal(shown.structuredContent.usage.retentionDays, 45);
  assert.ok(Array.isArray(shown.structuredContent.pendingResumes));
  assert.equal((await h.usage_settings_set({})).isError, true);
});

test('settings writes are denied in plan mode and to delegation children', async () => {
  const plan = handlersFor(parent, 'plan');
  const denied = await plan.usage_settings_set({ usage: { retentionDays: 10 } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /PLAN_MODE_DENIED/);
  assert.equal((await plan.usage_settings({})).isError, false);
  const c = handlersFor(child);
  const res = await c.usage_settings_set({ usage: { retentionDays: 10 } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /OUT_OF_SCOPE/);
  assert.notEqual(loadSettings().usage.retentionDays, 10);
});

test('usage_resume_stop reports an unknown id', async () => {
  const res = await handlersFor(parent).usage_resume_stop({ id: 'missing' });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NOT_FOUND/);
});

test('billing_forecast reads the balance forecast', async () => {
  const res = await handlersFor(parent).billing_forecast({});
  assert.equal(res.isError, false, res.content?.[0]?.text);
  assert.ok(Array.isArray(res.structuredContent.forecasts));
});
