import { ISOLATED_DATA_DIR, removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import nodeCrypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { addChat } from '../lib/persist/chats-persist.js';
import { createInProcessMcpClient } from '../lib/mcp/mcp-inprocess-client.js';
import { BILLING_MCP_TOOLS } from '../lib/mcp/builtin/billing-tools.js';
import { createCretliMcpToolHandlers } from '../lib/mcp/mcp-builtin-tools.js';
import { getBuiltinMcpMutatingTools, getBuiltinMcpReadTools, resolveMcpPlanToolDecision } from '../lib/mcp/mcp-policy.js';
import { createBuiltinCretliServer } from '../lib/mcp/mcp-config.js';
import { createAccount, readLedgerView } from '../lib/credit-ledger/credit-ledger-store.ts';
import { resolveDataPath } from '../lib/runtime-paths.js';

after(() => removeIsolatedDataDir());

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-mcp-'));
const uploads = path.join(ISOLATED_DATA_DIR, 'uploads');
fs.mkdirSync(uploads, { recursive: true });
const parent = addChat('s-bill', 'Billing', null, workspace, 'm', { agentTransport: 'opencode', sdkMode: 'agent' });
const child = addChat('s-bill-c', 'Child', null, workspace, 'm', {
  agentTransport: 'opencode', sdkMode: 'agent', delegationParentChatId: parent.id,
});

function handlersFor(chat, mode = 'agent') {
  const client = createInProcessMcpClient({ harness: 'opencode', chatId: chat.id, workspaceFolder: workspace });
  return createCretliMcpToolHandlers(client, {
    chatId: chat.id, workspaceFolder: workspace, harness: 'opencode', mode, builtinClient: client,
  });
}
const h = handlersFor(parent);
let seq = 0;
function upload(content = `img-${seq += 1}-${Math.random()}`) {
  const name = `${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(uploads, name), content);
  return name;
}
const ledgerPath = resolveDataPath('credit-ledger.json');
const { account } = createAccount({ filePath: ledgerPath, label: 'Main', walletCurrency: 'USD' });
const topup = (extra = {}) => ({
  kind: 'transaction', account_id: account.id, type: 'topup', occurred_at: '2026-03-04T10:00:00Z',
  credit: { amount: '10.00', currency: 'USD' }, ...extra,
});

test('billing tools: reads allowed in plan/review, mutations denied by policy and handler', async () => {
  assert.ok(getBuiltinMcpReadTools().includes('billing_list'));
  assert.ok(getBuiltinMcpReadTools().includes('billing_show'));
  assert.ok(getBuiltinMcpMutatingTools().includes('billing_create'));
  assert.ok(getBuiltinMcpMutatingTools().includes('billing_update'));
  const server = createBuiltinCretliServer();
  assert.equal(resolveMcpPlanToolDecision({ mode: 'plan', toolName: 'billing_create', server }).deny, true);
  assert.equal(resolveMcpPlanToolDecision({ mode: 'plan', toolName: 'billing_list', server }).deny, false);
  assert.equal(resolveMcpPlanToolDecision({ assignment: 'review', toolName: 'billing_update', server }).deny, true);
  const plan = handlersFor(parent, 'plan');
  const denied = await plan.billing_create(topup({ save: true }));
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /PLAN_MODE_DENIED/);
  assert.equal((await plan.billing_update({ kind: 'transaction', id: 'x' })).isError, true);
  assert.equal((await plan.billing_list({ kind: 'account' })).isError, false);
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, 0);
});

test('delegation child gets no finance access', async () => {
  const c = handlersFor(child);
  for (const res of [await c.billing_list({ kind: 'account' }), await c.billing_create(topup())]) {
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /OUT_OF_SCOPE/);
  }
});

test('import transaction from screenshot: saved with fields, id and correction path', async () => {
  const ref = upload();
  const res = await h.billing_create(topup({ save: true, attachment_ref: path.join(uploads, ref), idempotency_key: 'k1', payment: { amount: '10.00', currency: 'USD' } }));
  assert.equal(res.isError, false);
  const out = res.structuredContent;
  assert.equal(out.status, 'saved');
  assert.match(out.id, /^tx_/);
  assert.equal(out.parsed.credit.amount, '10.00');
  assert.equal(out.correct.tool, 'billing_update');
  assert.equal(out.attachment.state, 'present');
  const shown = await h.billing_show({ kind: 'transaction', id: out.id });
  assert.equal(shown.structuredContent.item.attachmentRef, ref);
  assert.equal(shown.structuredContent.item.attachmentState, 'present');
});

test('import snapshot from screenshot, and re-sending the same file dedups', async () => {
  const ref = upload();
  const snap = { kind: 'snapshot', save: true, account_id: account.id, currency: 'USD', total_balance: '4.20', observed_at: '2026-03-04T11:00:00Z', attachment_ref: ref };
  const first = (await h.billing_create({ ...snap, idempotency_key: 'a' })).structuredContent;
  assert.equal(first.status, 'saved');
  assert.match(first.id, /^snap_/);
  const again = (await h.billing_create({ ...snap, idempotency_key: 'b' })).structuredContent;
  assert.equal(again.id, first.id);
  assert.equal(again.deduplicated, 'image_hash');
});

test('re-submitted file with a new idempotency_key returns the existing transaction', async () => {
  const ref = upload();
  const a = (await h.billing_create(topup({ save: true, attachment_ref: ref, idempotency_key: 'one', credit: { amount: '7.00', currency: 'USD' }, occurred_at: '2026-04-01T10:00:00Z' }))).structuredContent;
  const before = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const b = (await h.billing_create(topup({ save: true, attachment_ref: ref, idempotency_key: 'two', credit: { amount: '7.00', currency: 'USD' }, occurred_at: '2026-04-01T10:00:00Z' }))).structuredContent;
  assert.equal(b.status, 'saved');
  assert.equal(b.id, a.id);
  assert.equal(b.deduplicated, 'image_hash');
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, before);
});

test('identical transaction on a different screenshot stays a draft until acknowledged', async () => {
  const fields = { credit: { amount: '15.00', currency: 'USD' }, occurred_at: '2026-05-01T10:00:00Z' };
  const first = (await h.billing_create(topup({ save: true, ...fields, attachment_ref: upload() }))).structuredContent;
  assert.equal(first.status, 'saved');
  const before = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const second = (await h.billing_create(topup({ save: true, ...fields, attachment_ref: upload() }))).structuredContent;
  assert.equal(second.status, 'draft');
  assert.equal(second.reason, 'possible_duplicate');
  assert.deepEqual(second.possibleDuplicateOf, [first.id]);
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, before);
  const forced = (await h.billing_create(topup({ save: true, ...fields, attachment_ref: upload(), allow_duplicate: true }))).structuredContent;
  assert.equal(forced.status, 'saved');
  assert.notEqual(forced.id, first.id);
});

test('unreadable or unclear fields keep a draft and write nothing', async () => {
  const before = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const unreadable = (await h.billing_create(topup({ attachment_ref: upload(), unreadable: ['credit.amount'], credit: { currency: 'USD' } }))).structuredContent;
  assert.equal(unreadable.status, 'draft');
  assert.ok(unreadable.missing.includes('credit.amount'));
  const noCurrency = (await h.billing_create(topup({ credit: { amount: '3' } }))).structuredContent;
  assert.ok(noCurrency.missing.includes('credit.currency'));
  const noTime = (await h.billing_create(topup({ occurred_at: undefined }))).structuredContent;
  assert.ok(noTime.missing.includes('occurredAt'));
  const noAccount = (await h.billing_create(topup({ account_id: undefined }))).structuredContent;
  assert.ok(noAccount.missing.includes('accountId'));
  const badAccount = (await h.billing_create(topup({ account_id: 'acct_nope' }))).structuredContent;
  assert.equal(badAccount.reason, 'account_not_found');
  const preview = (await h.billing_create(topup({ save: false, credit: { amount: '99', currency: 'USD' } }))).structuredContent;
  assert.equal(preview.reason, 'save_not_requested');
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, before);
});

test('omitting save documents and returns a save_not_requested draft, then saves explicitly', async () => {
  const tool = BILLING_MCP_TOOLS.find((t) => t.name === 'billing_create');
  assert.equal(tool.inputSchema.properties.save.default, false);
  assert.doesNotMatch(tool.description, /defaults to true/i);
  assert.match(tool.description, /save=true/);
  const before = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const fields = { credit: { amount: '42.00', currency: 'USD' }, occurred_at: '2026-09-01T10:00:00Z' };
  const draftRes = (await h.billing_create(topup(fields))).structuredContent;
  assert.equal(draftRes.status, 'draft');
  assert.equal(draftRes.reason, 'save_not_requested');
  assert.equal(draftRes.parsed.credit.amount, '42.00');
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, before);
  const saved = (await h.billing_create(topup({ ...fields, save: true }))).structuredContent;
  assert.equal(saved.status, 'saved');
  assert.match(saved.id, /^tx_/);
});

test('no-vision harness without an attachment asks for manual entry', async () => {
  const before = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const asked = (await h.billing_create({ kind: 'transaction', image_read: 'none' })).structuredContent;
  assert.equal(asked.status, 'draft');
  assert.equal(asked.reason, 'no_vision');
  assert.match(asked.next, /ask the user/i);
  assert.ok(asked.missing.includes('accountId'));
  assert.ok(asked.missing.includes('credit.amount'));
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, before);
  const snapshot = (await h.billing_create({ kind: 'snapshot', image_read: 'none' })).structuredContent;
  assert.equal(snapshot.reason, 'no_vision');
  const typed = (await h.billing_create(topup({
    save: true, image_read: 'none', credit: { amount: '4.00', currency: 'USD' }, occurred_at: '2026-10-01T10:00:00Z',
  }))).structuredContent;
  assert.equal(typed.status, 'saved');
});

test('harness without vision: asks for manual entry, but typed fields save', async () => {
  const ref = upload();
  const asked = (await h.billing_create({ kind: 'transaction', image_read: 'none', attachment_ref: ref })).structuredContent;
  assert.equal(asked.status, 'draft');
  assert.equal(asked.reason, 'no_vision');
  assert.match(asked.next, /ask the user/i);
  const typed = (await h.billing_create(topup({ save: true, image_read: 'none', attachment_ref: ref, credit: { amount: '1.25', currency: 'USD' }, occurred_at: '2026-06-01T09:00:00Z' }))).structuredContent;
  assert.equal(typed.status, 'saved');
});

test('invalid attachment references are rejected as drafts', async () => {
  const traversal = (await h.billing_create(topup({ attachment_ref: '../../etc/passwd' }))).structuredContent;
  assert.equal(traversal.reason, 'attachment_invalid');
  const gone = (await h.billing_create(topup({ attachment_ref: `${crypto.randomUUID()}.jpg` }))).structuredContent;
  assert.equal(gone.reason, 'attachment_missing');
});

test('deleting the image keeps the reference and reports state missing', async () => {
  const ref = upload();
  const saved = (await h.billing_create(topup({ save: true, attachment_ref: ref, credit: { amount: '2.50', currency: 'USD' }, occurred_at: '2026-07-01T10:00:00Z' }))).structuredContent;
  fs.rmSync(path.join(uploads, ref));
  const shown = (await h.billing_show({ kind: 'transaction', id: saved.id })).structuredContent.item;
  assert.equal(shown.attachmentRef, ref);
  assert.equal(shown.attachmentState, 'missing');
  const listed = (await h.billing_list({ kind: 'transaction' })).structuredContent.items.find((r) => r.id === saved.id);
  assert.equal(listed.attachmentState, 'missing');
});

test('update appends a correction; withdraw tombstones; accounts can be created and renamed', async () => {
  const saved = (await h.billing_create(topup({ save: true, credit: { amount: '3.00', currency: 'USD' }, occurred_at: '2026-08-01T10:00:00Z' }))).structuredContent;
  const fixed = (await h.billing_update({ kind: 'transaction', id: saved.id, patch: { credit: { amount: '3.50', currency: 'USD' } } })).structuredContent;
  assert.equal(fixed.transaction.supersedes, saved.id);
  assert.equal(fixed.transaction.credit.value, '3.50');
  const gone = (await h.billing_update({ kind: 'transaction', id: fixed.transaction.id, withdraw: true, patch: { reason: 'typo' } })).structuredContent;
  assert.equal(gone.transaction.tombstone, true);
  const acct = (await h.billing_create({ kind: 'account', label: 'Second', wallet_currency: 'EUR' })).structuredContent;
  const renamed = (await h.billing_update({ kind: 'account', id: acct.account.id, patch: { label: 'Renamed' } })).structuredContent;
  assert.equal(renamed.account.label, 'Renamed');
  const missing = await h.billing_show({ kind: 'transaction', id: 'tx_nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /NOT_FOUND/);
});

test('subscription kinds: draft until save=true, payment needs evidence, child and plan denied', async () => {
  const sub = {
    kind: 'subscription', label: 'Codex Plus', provider: 'codex', plan: 'Plus', source: 'screenshot',
    price: { amount: '20.00', currency: 'USD' }, cycle: { interval: 'month', anchorDate: '2026-01-31' },
  };
  const txBefore = readLedgerView({ filePath: ledgerPath }).transactions.length;
  const draft = (await h.billing_create(sub)).structuredContent;
  assert.equal(draft.status, 'draft');
  assert.equal((await h.billing_list({ kind: 'subscription' })).structuredContent.items.length, 0);
  const saved = (await h.billing_create({ ...sub, save: true })).structuredContent;
  assert.equal(saved.status, 'saved');
  const pay = { kind: 'subscription_payment', subscription_id: saved.id, due_date: '2026-02-28', paid_at: '2026-02-28', paid: { amount: '20.00', currency: 'USD' }, source: 'manual', save: true };
  assert.equal((await h.billing_create(pay)).isError, true);
  const ok = (await h.billing_create({ ...pay, provider_transaction_id: 'rcpt-1' })).structuredContent;
  assert.equal(ok.status, 'saved');
  const listed = (await h.billing_list({ kind: 'subscription' })).structuredContent.items[0];
  assert.equal(listed.payments.length, 1);
  assert.equal(listed.nextPayment.confirmed, false);
  assert.equal((await h.billing_update({ kind: 'subscription', id: saved.id, patch: { state: 'cancelled' } })).structuredContent.subscription.state, 'cancelled');
  assert.equal((await handlersFor(parent, 'plan').billing_create({ ...sub, save: true })).isError, true);
  assert.equal((await handlersFor(child).billing_list({ kind: 'subscription' })).isError, true);
  // Subscription cash never lands in the prepaid wallet ledger.
  assert.equal(readLedgerView({ filePath: ledgerPath }).transactions.length, txBefore);
});

test('subscription_payment via MCP: fabricated attachment rejected, real upload accepted; extra subscription fields mapped', async () => {
  const created = (await h.billing_create({
    kind: 'subscription', label: 'Cursor Pro', provider: 'cursor', plan: 'Pro', source: 'manual', save: true,
    price: { amount: '20.00', currency: 'USD' }, cycle: { interval: 'month', anchorDate: '2026-01-15' },
    ends_at: '2026-12-31', billing_account_id: 'ba-1', limit: { label: 'monthly', utilization: 10 },
  })).structuredContent;
  const shown = (await h.billing_show({ kind: 'subscription', id: created.id })).structuredContent.item;
  assert.equal(shown.endsAt, '2026-12-31');
  assert.equal(shown.billingAccountId, 'ba-1');
  assert.equal(shown.limit.label, 'monthly');
  const pay = { kind: 'subscription_payment', subscription_id: created.id, due_date: '2026-01-15', paid_at: '2026-01-15', paid: { amount: '20.00', currency: 'USD' }, source: 'screenshot', save: true };
  const fake = await h.billing_create({ ...pay, attachment_ref: `${crypto.randomUUID()}.jpg` });
  assert.equal(fake.isError, true);
  assert.match(fake.content[0].text, /attachment_missing/);
  assert.match((await h.billing_create({ ...pay, image_hash: 'a'.repeat(64) })).content[0].text, /image_hash_unverifiable/);
  const ref = upload();
  const hash = nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(uploads, ref))).digest('hex');
  assert.match((await h.billing_create({ ...pay, attachment_ref: ref, image_hash: 'b'.repeat(64) })).content[0].text, /image_hash_mismatch/);
  const ok = (await h.billing_create({ ...pay, attachment_ref: ref, image_hash: hash })).structuredContent;
  assert.equal(ok.status, 'saved');
  assert.equal(ok.payment.imageHash, hash);
});
