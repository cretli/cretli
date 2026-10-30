import './helpers/isolated-data-dir.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { ISOLATED_DATA_DIR as dataDir } from './helpers/isolated-data-dir.js';
import { makeTempDir } from './helpers/temp-dir.js';
import { createDecision, changeDecision, closeDecisionStores, listDecisions } from '../lib/decisions/decision-store.js';
import {
  HUMAN_ONLY_KINDS, applyPolicyUpgrade, canAutoDecide, computeDecisionMetrics, computeDecisionStats, hardException,
  proposePolicyUpgrades, readAutonomyState, recommendationStreak, runAutoDecisions, undoAutoDecision, writeAutonomyState, antiReflexState,
} from '../lib/decisions/decision-autonomy.js';
import { gesturesAllowed } from '../app_front/features/decisions/decisionLogic.js';

after(() => closeDecisionStores());
const ws = makeTempDir('cretli-autonomy-');
const opts = [{ id: 'yes', label: 'Yes', effect: 'Do it' }, { id: 'no', label: 'No', effect: 'Skip' }];
let n = 0;
async function card(kind, extra = {}) {
  n += 1;
  return createDecision(dataDir, { kind, workspaceFolder: ws, title: `T${n}`, subject: { findingId: `f${n}`, updatedAt: String(n) },
    dedupeKey: `k${n}`, options: opts, recommended: 'yes', why: 'because', ...extra });
}
async function humanDecide(c, optionId = 'yes', extra = {}) {
  const claimed = await changeDecision(dataDir, c.id, c.revision, 'deciding', {});
  return changeDecision(dataDir, c.id, claimed.revision, 'decided', { optionId, decidedAt: new Date().toISOString(), decidedBy: { kind: 'human-session' }, ...extra }, 'deciding');
}
const base = readAutonomyState(dataDir).policy;
const lowPolicy = { ...base, autoDecideKinds: ['question'] };
const lowCard = (extra = {}) => ({ status: 'pending', kind: 'question', risk: 'low', reversible: true, humanOnly: false, recommended: 'yes',
  title: 'Rename a label', summary: '', options: [{ id: 'yes', label: 'Yes', effect: 'Rename', risk: 'low', reversible: true }], ...extra });

test('defaults: threshold 20, 50 gestures, control every 20th', () => {
  assert.equal(base.upgradeThreshold, 20);
  assert.equal(base.dailyGestureLimit, 50);
  assert.equal(base.controlEvery, 20);
});

test('stats per kind with harness and diff size, metrics for 7 days', async () => {
  const a = await card('question', { harness: 'claude', diffSize: 10 });
  const b = await card('question', { harness: 'claude', diffSize: 10 });
  await humanDecide(a, 'yes', { decisionMeta: { openedMs: 4000 } });
  await humanDecide(b, 'no');
  const all = await listDecisions(dataDir, ws);
  const stats = computeDecisionStats(all).find((s) => s.kind === 'question' && s.harness === 'claude');
  assert.equal(stats.decided, 2); assert.equal(stats.recommended, 1); assert.equal(stats.other, 1);
  assert.equal(stats.diffSize, 'small'); assert.equal(stats.medianTimeOnCardMs, 4000);
  const now = Date.parse('2026-06-10T12:00:00Z');
  const fixtures = [
    { status: 'decided', decidedBy: { kind: 'human-session' }, recommended: 'a', optionId: 'a', createdAt: '2026-06-10T10:00:00Z', decidedAt: '2026-06-10T10:00:10Z' },
    { status: 'decided', decidedBy: { kind: 'human-session' }, recommended: 'a', optionId: 'b', createdAt: '2026-06-09T10:00:00Z', decidedAt: '2026-06-09T10:00:30Z' },
    { status: 'decided', decidedBy: { kind: 'human-session' }, recommended: 'a', optionId: 'a', createdAt: '2026-06-09T11:00:00Z', decidedAt: '2026-06-09T11:00:20Z' },
    { status: 'pending', createdAt: '2026-05-01T10:00:00Z' },
  ];
  const m = computeDecisionMetrics(fixtures, now);
  assert.equal(m.medianTimeToDecisionMs, 20000);
  assert.ok(Math.abs(m.recommendationAgreement - 2 / 3) < 1e-9);
  assert.equal(m.cardsPerDay.length, 7);
  assert.equal(m.cardsPerDay.find((d) => d.date === '2026-06-09').count, 2);
  assert.equal(m.cardsPerDay.find((d) => d.date === '2026-06-10').count, 1);
});

test('threshold creates a policy_upgrade metacard; nothing changes until a human accepts', async () => {
  const ws2 = makeTempDir('cretli-autonomy-2-');
  writeAutonomyState(dataDir, { policy: { ...base, upgradeThreshold: 3 }, streakResetAt: {} });
  for (let i = 0; i < 3; i += 1) {
    n += 1;
    const c = await createDecision(dataDir, { kind: 'scout_finding', workspaceFolder: ws2, title: 'S', subject: { findingId: `s${n}`, updatedAt: '1' }, dedupeKey: `s${n}`, options: opts, recommended: 'yes' });
    await humanDecide(c);
  }
  const [meta] = await proposePolicyUpgrades(dataDir, ws2);
  assert.equal(meta.kind, 'policy_upgrade'); assert.equal(meta.humanOnly, true); assert.equal(meta.subject.findingId, 'scout_finding');
  assert.deepEqual(readAutonomyState(dataDir).policy.autoDecideKinds, []);
  assert.equal((await proposePolicyUpgrades(dataDir, ws2)).length, 1); // deduped, still the same card
  assert.deepEqual(readAutonomyState(dataDir).policy.autoDecideKinds, []);
  assert.deepEqual(applyPolicyUpgrade(dataDir, meta, 'accept'), { ok: true });
  assert.deepEqual(readAutonomyState(dataDir).policy.autoDecideKinds, ['scout_finding']);
  writeAutonomyState(dataDir, { policy: base, streakResetAt: {} });
});

for (const kind of HUMAN_ONLY_KINDS) {
  test(`humanOnly kind ${kind} is never auto-decided and gets no metacard`, async () => {
    const ws3 = makeTempDir('cretli-autonomy-3-');
    writeAutonomyState(dataDir, { policy: { ...base, upgradeThreshold: 1, autoDecideKinds: [kind] }, streakResetAt: {} });
    assert.deepEqual(readAutonomyState(dataDir).policy.autoDecideKinds, []); // sanitized on read
    assert.equal(canAutoDecide(lowCard({ kind, humanOnly: true }), { ...base, autoDecideKinds: [kind] }), false);
    assert.equal(canAutoDecide(lowCard({ kind }), { ...base, autoDecideKinds: [kind] }), false);
    n += 1;
    const c = await createDecision(dataDir, { kind, workspaceFolder: ws3, title: 'H', subject: { findingId: `h${n}`, updatedAt: '1' }, dedupeKey: `h${n}`, options: opts, recommended: 'yes' });
    await humanDecide(c);
    const metas = (await proposePolicyUpgrades(dataDir, ws3)).filter((m) => m.subject.findingId === kind);
    assert.equal(metas.length, 0);
    assert.deepEqual(applyPolicyUpgrade(dataDir, { subject: { findingId: kind } }, 'accept'), { ok: false, reason: 'unsupported_kind' });
    writeAutonomyState(dataDir, { policy: base, streakResetAt: {} });
  });
}

test('auto-decision only for low + reversible promoted kinds', () => {
  assert.equal(canAutoDecide(lowCard(), lowPolicy), true);
  assert.equal(canAutoDecide(lowCard({ risk: 'medium' }), lowPolicy), false);
  assert.equal(canAutoDecide(lowCard({ reversible: false }), lowPolicy), false);
  assert.equal(canAutoDecide(lowCard(), base), false);
});

const hardCases = {
  dependency: 'Add a new dependency to package.json',
  secrets: 'Rotate the API key and update the .env secrets',
  mainBranch: 'Push to main after the merge',
  dataDeletion: 'Delete the production database records',
  payments: 'Pay the invoice for the subscription',
};
for (const [name, text] of Object.entries(hardCases)) {
  test(`hard exception ${name} is never automated`, () => {
    const c = lowCard({ title: text });
    assert.equal(hardException(c), name);
    assert.equal(canAutoDecide(c, lowPolicy), false);
    assert.equal(canAutoDecide(lowCard({ hardExceptions: [name] }), lowPolicy), false);
  });
}

test('auto-decision is recorded, visible in history and undoable only inside the window', async () => {
  const ws4 = makeTempDir('cretli-autonomy-4-');
  const c = await createDecision(dataDir, { kind: 'question', workspaceFolder: ws4, title: 'Auto', subject: { findingId: 'auto1', updatedAt: '1' }, dedupeKey: 'auto1',
    options: opts, recommended: 'yes' });
  // Server classification makes real `question` cards medium risk, so nothing is auto-decided today.
  writeAutonomyState(dataDir, { policy: { ...base, autoDecideKinds: ['question'] }, streakResetAt: {} });
  assert.equal((await runAutoDecisions(dataDir, ws4, async () => ({ ok: true }))).length, 0);
  // Simulate a decided auto row to exercise the undo window.
  const claimed = await changeDecision(dataDir, c.id, c.revision, 'deciding', {});
  const done = await changeDecision(dataDir, c.id, claimed.revision, 'decided', { optionId: 'yes', decidedAt: new Date().toISOString(),
    decidedBy: { kind: 'auto' }, undoUntil: new Date(Date.now() + 60000).toISOString() }, 'deciding');
  assert.equal((await undoAutoDecision(dataDir, { ...done, undoUntil: new Date(Date.now() - 1).toISOString() })).reason, 'window_closed');
  const undone = await undoAutoDecision(dataDir, done);
  assert.equal(undone.ok, true); assert.equal(undone.decision.status, 'pending'); assert.equal(undone.decision.undone, true);
  assert.equal(undone.decision.undoneAuto.optionId, 'yes');
  writeAutonomyState(dataDir, { policy: base, streakResetAt: {} });
});

test('anti-reflex: gesture limit and every 20th card is a control card', () => {
  const human = (i, gesture) => ({ status: 'decided', decidedBy: { kind: 'human-session' }, decidedAt: new Date().toISOString(), decisionMeta: { gesture }, kind: 'q', id: String(i) });
  const cards19 = Array.from({ length: 19 }, (_, i) => human(i, false));
  assert.equal(antiReflexState(cards19, base).nextIsControl, true);
  assert.equal(antiReflexState(cards19.slice(0, 5), base).nextIsControl, false);
  const gestures = Array.from({ length: 50 }, (_, i) => human(i, true));
  const state = antiReflexState(gestures, base);
  assert.equal(state.gesturesLeft, 0);
  assert.equal(gesturesAllowed(state), false);
  assert.equal(gesturesAllowed({ gesturesLeft: 3, nextIsControl: true }), false);
  assert.equal(gesturesAllowed({ gesturesLeft: 3, nextIsControl: false }), true);
  assert.equal(recommendationStreak([], 'q'), 0);
});

test('cards derive harness from the source chat and diff size from evidence', async () => {
  const { deriveDiffSize } = await import('../lib/decisions/decision-store.js');
  assert.equal(deriveDiffSize([{ filesChanged: 7 }]), 7);
  assert.equal(deriveDiffSize([{ diffStat: '3 files changed, 10 insertions(+), 4 deletions(-)' }]), 14);
  assert.equal(deriveDiffSize([{ label: 'x' }]), null);
  const { addChat } = await import('../lib/persist/chats-persist.js');
  const chat = addChat('sess-harness', 'Harness chat', null, ws, 'm', { agentTransport: 'codex' });
  const viaChat = await createDecision(dataDir, { kind: 'question', workspaceFolder: ws, title: 'C', subject: { chatId: chat.id, updatedAt: '1' },
    dedupeKey: 'harness-chat', options: opts, recommended: 'yes' });
  assert.equal(viaChat.harness, 'codex');
  const direct = await card('question', { harness: 'codex', evidence: [{ filesChanged: 400 }] });
  assert.equal(direct.harness, 'codex');
  assert.equal(direct.diffSize, 400);
  const stats = computeDecisionStats([{ ...direct, status: 'decided', decidedBy: { kind: 'human-session' }, optionId: 'yes', decidedAt: direct.createdAt }]);
  assert.equal(stats[0].harness, 'codex'); assert.equal(stats[0].diffSize, 'large');
});
