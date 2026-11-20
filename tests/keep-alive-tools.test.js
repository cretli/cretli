/**
 * Keep-alive MCP tools and the chat-run start observer.
 */
process.env.CRETLI_TEST_DATA_DIR ||= 'keep-alive-tools-test';

import { templateToString as _str } from './helpers/lit-template-string.js';
import assert from 'node:assert/strict';
import { KEEP_ALIVE_MCP_TOOLS } from '../lib/mcp/builtin/keep-alive-tools.js';
import { listBuiltinMcpMutatingToolNames, listBuiltinMcpReadToolNames } from '../lib/mcp/builtin/catalog.js';
import { observeChatRunStarts } from '../lib/chat-run-service.js';

const byName = Object.fromEntries(KEEP_ALIVE_MCP_TOOLS.map((tool) => [tool.name, tool]));
assert.deepEqual(Object.keys(byName).sort(), [
  'keepalive_config', 'keepalive_ping', 'keepalive_status', 'keepalive_stop',
]);
// Anything that can spend money or stop a plan is a mutating tool.
assert.equal(byName.keepalive_status.readOnly, true);
for (const name of ['keepalive_config', 'keepalive_ping', 'keepalive_stop']) {
  assert.equal(byName[name].readOnly, false, name);
}
// Registered in the single catalog under the right access class.
assert.ok(listBuiltinMcpMutatingToolNames().includes('keepalive_ping'));
assert.ok(listBuiltinMcpReadToolNames().includes('keepalive_status'));

const session = { chatId: 'ctrl', workspaceFolder: '/w' };
const calls = [];
const client = {
  async keepAlive(payload) {
    calls.push(payload);
    return client.next;
  },
};

// configure maps limits and never forwards a ping action.
client.next = { ok: true, plan: { mode: 'manual', budget: { remainingUsd: 1 } } };
await byName.keepalive_config.handler(
  { delegation_id: 'del-1', mode: 'manual', max_pings: 2, budget_usd: 1, idempotency_key: 'k' },
  { client, session },
);
assert.equal(calls[0].action, 'configure');
assert.equal(calls[0].controllerChatId, 'ctrl');
assert.equal(calls[0].limits.maxPings, 2);
assert.equal(calls[0].limits.budgetUsd, 1);

// The caller's chat is always the controller: it cannot be overridden by args.
await byName.keepalive_status.handler({ delegation_id: 'del-1', controller_chat_id: 'evil' }, { client, session });
assert.equal(calls[1].controllerChatId, 'ctrl');
assert.equal(calls[1].action, 'status');

// A refusal without a plan is an error that carries the reason.
client.next = { ok: false, code: 'auto_unavailable', reason: 'benchmark_no_go' };
await assert.rejects(
  byName.keepalive_config.handler({ delegation_id: 'del-1', mode: 'auto' }, { client, session }),
  /auto_unavailable.*benchmark_no_go/,
);

// A deferral or stop that carries the plan is information, with stop + budget.
client.next = { ok: false, code: 'stopped', reason: 'budget_exhausted', plan: { stopReason: 'budget_exhausted', budget: { remainingUsd: 0 } } };
const stopped = await byName.keepalive_ping.handler({ delegation_id: 'del-1' }, { client, session });
assert.match(JSON.stringify(stopped), /budget_exhausted/);

await assert.rejects(byName.keepalive_ping.handler({}, { client, session }), /delegation_id is required/);
await assert.rejects(byName.keepalive_status.handler({}, { client: {}, session }), /keepAlive is unavailable/);

// Observer plumbing exists and an unsubscribe is honoured.
let seen = 0;
const off = observeChatRunStarts(() => { seen += 1; });
off();
assert.equal(seen, 0);

console.log('keep-alive-tools tests passed');

// ---- UI renderer: stop reason, remaining budget (unknown when unmeasured),
// benchmark gate, and i18n keys exist in both languages.
{
  const { renderKeepAliveView: _renderKeepAliveView } = await import('../app_front/features/usage/usageInsightsView.js');
  const renderKeepAliveHtml = (...args) => _str(_renderKeepAliveView(...args));
  const { en } = await import('../app_front/i18n/en.js');
  const { pl } = await import('../app_front/i18n/pl.js');
  const dict = { ...en.usage };
  const t = (key, params = {}) => String(dict[key.replace(/^usage\./, '')] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  const html = renderKeepAliveHtml({
    gate: { decision: 'no_go', reasons: ['not_measured'] },
    plans: [
      { delegationId: 'abcdef12-0000', controllerChatId: 'ctrl', mode: 'auto', status: 'active', stopReason: null, lastDefer: { reason: 'busy' }, budget: { pingsRemaining: 2, remainingUsd: null, spentUsd: 0.04, costComplete: false, unknownCostPings: 1 } },
      { delegationId: 'fedcba98-0000', controllerChatId: 'ctrl', mode: 'manual', status: 'stopped', stopReason: 'budget_exhausted', lastDefer: null, budget: { pingsRemaining: 0, remainingUsd: 0, spentUsd: 1, costComplete: true, unknownCostPings: 0 } },
    ],
  }, { t, lang: 'en' });
  assert.match(html, /Stopped: budget exhausted/);
  assert.doesNotMatch(html, /budget_exhausted/);
  assert.match(html, /no-go \(not_measured\)/);
  assert.match(html, /Unknown/);
  assert.match(html, /deferred: busy/);
  assert.match(html, /data-keepalive-stop="abcdef12-0000"/);
  assert.doesNotMatch(html, /data-keepalive-stop="fedcba98-0000"/);
  // Every stop reason has a label in both languages; unknown codes fall back to the raw code.
  const { KEEP_ALIVE_STOP_REASON } = await import('../lib/usage/keep-alive-policy.ts');
  const { keepAliveStopReasonLabel, KEEP_ALIVE_STOP_REASON_LABELED } = await import('../app_front/features/usage/usageInsightsView.js');
  for (const code of Object.values(KEEP_ALIVE_STOP_REASON)) {
    assert.ok(KEEP_ALIVE_STOP_REASON_LABELED.includes(code), `stop reason ${code} has no UI label mapping`);
    assert.ok(en.usage[`keepAliveStopReason_${code}`], `en label for ${code}`);
    assert.ok(pl.usage[`keepAliveStopReason_${code}`], `pl label for ${code}`);
    assert.notEqual(keepAliveStopReasonLabel(code, t), code);
  }
  assert.equal(keepAliveStopReasonLabel('brand_new_reason', t), 'brand_new_reason');
  assert.equal(keepAliveStopReasonLabel('', t), '—');
  for (const key of Object.keys(en.usage).filter((k) => k.startsWith('keepAlive'))) {
    assert.ok(pl.usage[key], `pl.usage.${key} missing`);
  }
}
