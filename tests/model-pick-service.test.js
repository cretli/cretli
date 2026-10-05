import test from 'node:test';
import assert from 'node:assert/strict';
import { pickModelForPurpose, listPurposeUses } from '../lib/model-pick-service.js';

const harnesses = [
  { id: 'a', enabled: true, ready: true, can_delegate: true },
  { id: 'b', enabled: true, ready: true, can_delegate: true },
];
const modelsByHarness = {
  a: { favorites_configured: true, items: [{ id: 'm-a', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] },
  b: { favorites_configured: true, items: [{ id: 'm-b', roles: ['implement'], cost_tier: 1, quality_tier: 3, speed_tier: 3 }] },
};

test('listPurposeUses counts only tagged chats inside the window', () => {
  const now = Date.now();
  const chats = [
    { pickPurpose: 'scout', agentTransport: 'a', model: 'm-a', createdAt: new Date(now - 1000).toISOString() },
    { pickPurpose: 'scout', agentTransport: 'a', model: 'm-a', createdAt: new Date(now - 30 * 86400000).toISOString() },
    { pickPurpose: 'other', agentTransport: 'b', model: 'm-b', createdAt: new Date(now).toISOString() },
  ];
  assert.equal(listPurposeUses('scout', { chats, now }).length, 1);
  assert.equal(listPurposeUses('', { chats, now }).length, 0);
});

test('extra purpose uses shift the pick to the least-used harness', async () => {
  const { buildModelPickHistory } = await import('../lib/model-pick-history.js');
  const now = Date.now();
  const base = { role: 'implement', harnesses, modelsByHarness, rotation: { mode: 'balanced' }, explore: false, now };
  const firstHistory = buildModelPickHistory({ role: 'implement', harnesses, delegations: [], now, lockouts: [], planLimits: [] });
  const first = pickModelForPurpose({ ...base, history: firstHistory });
  assert.equal(first.ok, true);
  const used = first.pick.harness;
  const extraUses = Array.from({ length: 3 }, () => ({
    harness: used,
    model: used === 'a' ? 'm-a' : 'm-b',
    createdAt: new Date(now - 1000).toISOString(),
  }));
  const history = buildModelPickHistory({ role: 'implement', harnesses, delegations: [], extraUses, now, lockouts: [], planLimits: [] });
  const second = pickModelForPurpose({ ...base, history });
  assert.equal(second.ok, true);
  assert.notEqual(second.pick.harness, used);
});

test('insufficient balance locks the whole harness for hours', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const m = await import('../lib/harness-usage-limits.js');
  assert.equal(m.isInsufficientBalanceMessage('Insufficient Balance (request_id: x)'), true);
  assert.equal(m.isInsufficientBalanceMessage('see line 402'), false);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bal-'));
  assert.equal(m.noteHarnessUsageLimit({ harness: 'deepseek', model: 'deepseek-chat', message: 'Insufficient Balance', dataDir }), true);
  const rows = m.listHarnessUsageLimits(dataDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, '');
  assert.equal(rows[0].code, 'insufficient_balance');
  assert.ok(Date.parse(rows[0].resetAt) - Date.now() > 5 * 3600 * 1000);
});

test('unclassified run errors are logged once per signature', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const m = await import('../lib/harness-usage-limits.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unc-'));
  const input = { harness: 'x', message: 'Weird failure code 123', dataDir };
  assert.equal(m.noteUnclassifiedRunError(input), true);
  assert.equal(m.noteUnclassifiedRunError({ ...input, message: 'Weird failure code 456' }), false);
  assert.equal(m.noteUnclassifiedRunError({ ...input, message: 'Insufficient Balance' }), false);
});
