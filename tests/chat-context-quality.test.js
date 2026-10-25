import assert from 'node:assert/strict';
import {
  applyClaudeMeasuredContextUsage,
  applyServerContextOccupancy,
  buildChatContextSnapshot,
  resetChatContextMeterState,
} from '../app_front/features/chat/chatContextMeter.js';
import {
  describeContextQuality,
  describeContextQualityRows,
  formatContextQualityNote,
} from '../app_front/features/chat/chatContextQuality.js';
import { updateChatContextAdvisoryUi } from '../app_front/features/chat/chatContextAdvisory.js';
import { evaluateAutoContextCompressionGate } from '../lib/context-compression.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';

const dict = en.chat ?? en.default?.chat ?? en;
const t = (key, params = {}) => String((dict[key.replace(/^chat\./, '')] ?? key))
  .replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
const snap = (chat) => buildChatContextSnapshot(chat, chat.model);

// exact: fresh reported Claude reading
const exact = { agentTransport: 'claude', model: 'claude-sonnet-4-20250514' };
applyClaudeMeasuredContextUsage(exact, { totalTokens: 100000 }, exact.model, 200000);
const exactSnap = snap(exact);
assert.equal(exactSnap.quality.quality, 'reported');
assert.equal(exactSnap.quality.scope, 'current_prompt');
assert.equal(exactSnap.quality.limitSource, 'provider');
assert.equal(exactSnap.quality.percentReliable, true);
assert.equal(exactSnap.quality.autoEligible, true);
assert.equal(exactSnap.fillPercent, 50);
const rows = describeContextQualityRows(exactSnap, t);
assert.equal(rows.quality, 'Reported by the provider');
assert.equal(rows.limit, 'Context window (reported by the provider)');
assert.equal(rows.granularity, 'run');

// estimated: transcript fallback is labelled and never auto-eligible
const est = { agentTransport: 'sdk', model: 'gpt-5-mini', _buffer: 'hello world '.repeat(200) };
const estSnap = snap(est);
assert.equal(estSnap.quality.quality, 'estimated');
assert.equal(estSnap.quality.autoEligible, false);
assert.equal(estSnap.quality.percentReliable, false);
assert.match(formatContextQualityNote(estSnap.quality, t), /estimate/);

// unknown: no data at all
const unk = { agentTransport: 'claude', model: 'sonnet' };
const unkSnap = snap(unk);
assert.equal(unkSnap.quality.quality, 'unknown');
assert.equal(unkSnap.quality.autoEligible, false);
assert.equal(unkSnap.fillPercent, null);

// stale: 11 minutes old reported reading keeps its number but loses eligibility
const now = Date.now();
const staleQ = describeContextQuality({ ...exactSnap, updatedAt: now - 11 * 60 * 1000 }, { now });
assert.equal(staleQ.stale, true);
assert.equal(staleQ.autoEligible, false);
assert.ok(staleQ.reasons.includes('stale_or_unknown_time'));
assert.match(describeContextQualityRows({ ...exactSnap, updatedAt: now - 11 * 60 * 1000 }, t, { now }).age, /11 min ago · stale/);
assert.match(formatContextQualityNote(staleQ, t), /stale/);

// zero: reported zero tokens is not a decision input
const zeroQ = describeContextQuality({ ...exactSnap, inputTokens: 0 }, { now });
assert.equal(zeroQ.autoEligible, false);

// unknown limit: no percent, no eligibility
const noLimit = { agentTransport: 'sdk', model: 'unknown-model-xyz', _contextUsageInputTokens: 5000, _contextUsageUpdatedAt: now, _contextUsageEpoch: 0 };
const noLimitSnap = snap(noLimit);
assert.equal(noLimitSnap.contextWindowTokens, null);
assert.equal(noLimitSnap.fillPercent, null);
assert.equal(noLimitSnap.quality.limitType, 'unknown');
assert.equal(noLimitSnap.quality.autoEligible, false);
assert.equal(describeContextQualityRows(noLimitSnap, t).limit, 'Unknown (no percentage)');

// unknown semantics: transport outside the usage matrix gives no percent
const unkSem = { agentTransport: 'mystery', model: 'gpt-5-mini', _contextUsageInputTokens: 5000 };
const unkSemSnap = snap(unkSem);
assert.equal(unkSemSnap.quality.semantics, 'unknown');
assert.equal(unkSemSnap.fillPercent, null);
assert.equal(unkSemSnap.quality.autoEligible, false);

// after compaction: epoch bump drops the old reading
resetChatContextMeterState(exact, { reason: 'compaction', markFreshSession: true });
const afterSnap = snap(exact);
assert.equal(afterSnap.quality.quality, 'unknown');
assert.equal(afterSnap.quality.autoEligible, false);
assert.equal(afterSnap.fillPercent, null);
// a pre-compaction snapshot against the new epoch is rejected
const mismatch = describeContextQuality({ ...exactSnap, contextMeterEpoch: 1 }, { now });
assert.ok(mismatch.reasons.includes('context_epoch_mismatch'));
assert.equal(mismatch.autoEligible, false);

// advisory carries the quality note
let shown;
updateChatContextAdvisoryUi({
  chat: { agentTransport: 'sdk', contextAdvisoryEnabled: true },
  fillPercent: 99,
  label: 'x',
  qualityNote: 'NOTE',
  richView: { updateContextAdvisory: (o) => { shown = o; } },
  t,
});
assert.equal(shown?.visible, true);
assert.match(shown.message, /NOTE$/);

// auto gate still rejects what the quality view rejects
assert.equal(evaluateAutoContextCompressionGate({ ...estSnap, currentEpoch: estSnap.contextMeterEpoch }, { thresholdPercent: 1 }).allowed, false);

// PL/EN parity of the new keys
const keys = Object.keys(dict).filter((k) => k.startsWith('contextQuality'));
assert.ok(keys.length >= 25);
const plDict = pl.chat ?? pl.default?.chat ?? pl;
for (const k of keys) assert.ok(plDict[k], `pl missing ${k}`);

// server occupancy for a non-claude/codex harness: age counts from the source observation time
const srcAt = Date.now() - 11 * 60 * 1000;
const serverEvent = (limitSource, limitTokens = 128000) => ({
  type: 'context_usage',
  usage: { inputTokens: 999999 },
  usageMeta: {
    observedAt: new Date().toISOString(),
    sourceObservedAt: new Date(srcAt).toISOString(),
    contextEpoch: 0,
    occupancy: { source: 'snapshot', promptTokens: 64000, limitTokens, limitSource },
  },
});
const srv = { agentTransport: 'opencode', model: 'gpt-5-mini' };
assert.equal(applyServerContextOccupancy(srv, serverEvent('provider')), true);
assert.equal(srv._contextUsageInputTokens, 64000); // server prompt tokens, not raw usage.inputTokens
assert.equal(srv._contextUsageUpdatedAt, srcAt);
const srvSnap = snap(srv);
assert.equal(srvSnap.quality.stale, true);
assert.ok(srvSnap.quality.ageMs >= 11 * 60 * 1000);
assert.equal(srvSnap.fillPercent, 50);

// a billing total without a snapshot is never promoted to occupancy
const bill = { agentTransport: 'opencode', model: 'gpt-5-mini' };
assert.equal(applyServerContextOccupancy(bill, { type: 'usage', usage: { inputTokens: 5000 }, usageMeta: { occupancy: { source: 'estimated', promptTokens: null } } }), false);
assert.equal(bill._contextUsageInputTokens, undefined);

// every limit source maps to its own text (en + pl)
const plT = (key) => String(plDict[key.replace(/^chat\./, '')] ?? key);
const texts = new Set();
for (const source of ['provider', 'catalog', 'manual']) {
  const c = { agentTransport: 'opencode', model: 'gpt-5-mini' };
  applyServerContextOccupancy(c, serverEvent(source));
  const s = snap(c);
  assert.equal(s.quality.limitSource, source);
  const en1 = describeContextQualityRows(s, t).limit;
  assert.ok(!en1.startsWith('chat.'));
  assert.ok(!plT(`chat.contextQualityLimit${source[0].toUpperCase()}${source.slice(1)}`).startsWith('chat.'));
  texts.add(en1);
}
const noLimitServer = snap({ agentTransport: 'opencode', model: 'unknown-model-xyz' });
assert.equal(noLimitServer.quality.limitSource, 'unknown');
texts.add(describeContextQualityRows(noLimitServer, t).limit);
assert.equal(texts.size, 4);
// no server source: the static table is reported as catalog
assert.equal(snap({ agentTransport: 'sdk', model: 'gpt-5-mini' }).quality.limitSource, 'catalog');

// known -> unknown on the SAME meter: the stale server window/source must not survive
const seq = { agentTransport: 'opencode', model: 'unknown-model-xyz' };
applyServerContextOccupancy(seq, serverEvent('provider'));
assert.equal(snap(seq).quality.limitSource, 'provider');
applyServerContextOccupancy(seq, serverEvent('unknown', null));
assert.equal(seq._contextServerLimitTokens, undefined);
assert.equal(seq._contextServerLimitSource, undefined);
const seqSnap = snap(seq);
assert.equal(seqSnap.contextWindowTokens, null);
assert.equal(seqSnap.quality.limitSource, 'unknown');

console.log('chat-context-quality.test.js OK');
