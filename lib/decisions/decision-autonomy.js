/**
 * Autonomy ladder of decision cards (docs/decision-cards.md, "Autonomy ladder"): per-kind statistics,
 * the `policy_upgrade` metacard, auto-decision eligibility, anti-reflex limits and metrics.
 * Policy lives in `data/decisions/autonomy.json`; nothing in it changes without a human accepting a metacard
 * or editing the settings explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDecision, listDecisions, changeDecision } from './decision-store.js';

/** Kinds that are never auto-decided and never receive a metacard (docs/workspace-watcher.md). */
export const HUMAN_ONLY_KINDS = Object.freeze(['plan_approval', 'integration', 'policy_upgrade']);
export const DEFAULT_AUTONOMY_POLICY = Object.freeze({
  /** Consecutive human decisions of one kind that took the recommendation before a metacard appears. */
  upgradeThreshold: 20,
  /** Gesture (swipe/key) decisions per UTC day; beyond it only buttons work. */
  dailyGestureLimit: 50,
  /** Every Nth human-decided card must be opened in details before it can be decided. */
  controlEvery: 20,
  /** How long an automatic decision can be undone. */
  undoWindowMs: 5 * 60 * 1000,
  /** Kinds a human promoted through an accepted `policy_upgrade` metacard. */
  autoDecideKinds: [],
});
const HARD_EXCEPTIONS = Object.freeze({
  dependency: /package(-lock)?\.json|\bnew dependenc|\bnpm (install|i|add)\b|\byarn add\b|\bpnpm add\b/i,
  secrets: /\bsecrets?\b|\bapi[ _-]?keys?\b|\bcredentials?\b|\bpasswords?\b|\btokens?\b|\bauth(entication|orization)?\b|\.env\b/i,
  mainBranch: /\b(push|merge|force[- ]push)\b[^.\n]*\b(main|master|trunk|production)\b|\b(main|master)\b[^.\n]*\b(push|merge)\b/i,
  dataDeletion: /\b(delete|drop|wipe|purge|erase|remove)\b[^.\n]*\b(data|database|table|records?|files?|branch|history|backups?)\b|\brm -rf\b/i,
  payments: /\b(payments?|billing|invoice|purchase|subscription|charge|top[- ]?up)\b/i,
});

function policyFile(dataDir) { return path.join(dataDir, 'decisions', 'autonomy.json'); }
function positive(value, fallback) { return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback; }

export function readAutonomyState(dataDir) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(policyFile(dataDir), 'utf8')); } catch { /* defaults */ }
  const p = raw.policy || {};
  return {
    policy: {
      upgradeThreshold: positive(p.upgradeThreshold, DEFAULT_AUTONOMY_POLICY.upgradeThreshold),
      dailyGestureLimit: Number.isFinite(p.dailyGestureLimit) && p.dailyGestureLimit >= 0 ? Math.floor(p.dailyGestureLimit) : DEFAULT_AUTONOMY_POLICY.dailyGestureLimit,
      controlEvery: positive(p.controlEvery, DEFAULT_AUTONOMY_POLICY.controlEvery),
      undoWindowMs: positive(p.undoWindowMs, DEFAULT_AUTONOMY_POLICY.undoWindowMs),
      autoDecideKinds: (Array.isArray(p.autoDecideKinds) ? p.autoDecideKinds : []).filter((k) => typeof k === 'string' && !HUMAN_ONLY_KINDS.includes(k)),
    },
    /** ISO time per kind after which a new streak is counted (set when a metacard is decided). */
    streakResetAt: raw.streakResetAt && typeof raw.streakResetAt === 'object' ? raw.streakResetAt : {},
  };
}
export function writeAutonomyState(dataDir, state) {
  fs.mkdirSync(path.dirname(policyFile(dataDir)), { recursive: true });
  fs.writeFileSync(policyFile(dataDir), JSON.stringify(state, null, 2), { mode: 0o600 });
}

/** Names the hard exception a card touches, or '' when none. Looks at every human-readable field. */
export function hardException(card) {
  const text = [card?.title, card?.summary, card?.why, ...(card?.options || []).flatMap((o) => [o.label, o.effect]),
    JSON.stringify(card?.evidence || [])].join('\n');
  const tags = Array.isArray(card?.hardExceptions) ? card.hardExceptions : [];
  for (const [name, pattern] of Object.entries(HARD_EXCEPTIONS)) if (tags.includes(name) || pattern.test(text)) return name;
  return '';
}

/** Server-side gate for automatic decisions: low risk + reversible, not human-only, promoted kind, no hard exception. */
export function canAutoDecide(card, policy) {
  if (!card || card.status !== 'pending' || HUMAN_ONLY_KINDS.includes(card.kind) || card.humanOnly === true) return false;
  if (card.risk !== 'low' || card.reversible !== true) return false;
  if (!policy.autoDecideKinds.includes(card.kind)) return false;
  if (!card.recommended || !card.options?.some((o) => o.id === card.recommended && o.risk === 'low' && o.reversible === true)) return false;
  return !hardException(card);
}

const isHumanDecided = (c) => c.status === 'decided' && c.decidedBy?.kind === 'human-session';
const ms = (a, b) => Date.parse(b) - Date.parse(a);
const median = (values) => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const sizeBucket = (n) => (!Number.isFinite(n) ? 'unknown' : n < 50 ? 'small' : n < 300 ? 'medium' : 'large');

/** Per kind (+ harness, diff-size bucket): recommendation vs other option, time to decision, time on card. */
export function computeDecisionStats(cards) {
  const groups = new Map();
  for (const card of cards.filter(isHumanDecided)) {
    const key = `${card.kind}|${card.harness || ''}|${sizeBucket(card.diffSize)}`;
    const g = groups.get(key) || { kind: card.kind, harness: card.harness || '', diffSize: sizeBucket(card.diffSize), decided: 0, recommended: 0, other: 0, tt: [], onCard: [] };
    g.decided += 1;
    if (card.optionId === card.recommended) g.recommended += 1; else g.other += 1;
    const tt = ms(card.createdAt, card.decidedAt);
    if (Number.isFinite(tt)) g.tt.push(tt);
    if (Number.isFinite(card.decisionMeta?.openedMs)) g.onCard.push(card.decisionMeta.openedMs);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ tt, onCard, ...g }) => ({ ...g, medianTimeToDecisionMs: median(tt), medianTimeOnCardMs: median(onCard) }));
}

/** Median time-to-decision, recommendation agreement and cards per day for the last 7 UTC days. */
export function computeDecisionMetrics(cards, now = Date.now()) {
  const human = cards.filter(isHumanDecided);
  const tts = human.map((c) => ms(c.createdAt, c.decidedAt)).filter(Number.isFinite);
  const withRec = human.filter((c) => c.recommended);
  const perDay = {};
  for (let i = 6; i >= 0; i -= 1) perDay[new Date(now - i * 86400000).toISOString().slice(0, 10)] = 0;
  for (const card of cards) {
    const day = String(card.createdAt || '').slice(0, 10);
    if (day in perDay) perDay[day] += 1;
  }
  return {
    medianTimeToDecisionMs: median(tts),
    recommendationAgreement: withRec.length ? withRec.filter((c) => c.optionId === c.recommended).length / withRec.length : null,
    cardsPerDay: Object.entries(perDay).map(([date, count]) => ({ date, count })),
    decided: human.length,
  };
}

export function gestureCountToday(cards, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return cards.filter((c) => c.decisionMeta?.gesture === true && String(c.decidedAt || '').slice(0, 10) === day).length;
}
/** Anti-reflex state: remaining gestures today and whether the next human decision is a control card. */
export function antiReflexState(cards, policy, now = Date.now()) {
  const humanCount = cards.filter(isHumanDecided).length;
  return {
    gesturesLeft: Math.max(0, policy.dailyGestureLimit - gestureCountToday(cards, now)),
    nextIsControl: (humanCount + 1) % policy.controlEvery === 0,
  };
}

/** Consecutive latest human decisions of a kind that picked the recommendation, after the last reset. */
export function recommendationStreak(cards, kind, since = '') {
  const rows = cards.filter((c) => isHumanDecided(c) && c.kind === kind && (!since || c.decidedAt > since))
    .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1));
  let n = 0;
  for (const row of rows) { if (row.recommended && row.optionId === row.recommended) n += 1; else break; }
  return n;
}

const upgradeOptions = [
  { id: 'accept', label: 'Allow automatic decisions', effect: 'Low-risk reversible cards of this kind are decided automatically, with undo' },
  { id: 'reject', label: 'Keep asking me', effect: 'Leave the policy unchanged and restart the streak' },
];
/** Creates a `policy_upgrade` metacard for every eligible kind that reached the threshold. Never for human-only kinds. */
export async function proposePolicyUpgrades(dataDir, workspaceFolder) {
  const { policy, streakResetAt } = readAutonomyState(dataDir);
  const cards = await listDecisions(dataDir, workspaceFolder);
  const created = [];
  for (const kind of new Set(cards.map((c) => c.kind))) {
    if (HUMAN_ONLY_KINDS.includes(kind) || policy.autoDecideKinds.includes(kind)) continue;
    const since = streakResetAt[kind] || '';
    const streak = recommendationStreak(cards, kind, since);
    if (streak < policy.upgradeThreshold) continue;
    created.push(await createDecision(dataDir, {
      kind: 'policy_upgrade', workspaceFolder, producer: 'autonomy',
      subject: { findingId: kind, updatedAt: `${kind}:${since || 'start'}` },
      title: `Allow automatic decisions for ${kind}?`,
      summary: `You chose the recommendation ${streak} times in a row for ${kind} cards.`,
      dedupeKey: `policy_upgrade:${workspaceFolder}:${kind}`, options: upgradeOptions, recommended: 'reject',
      why: 'Policy changes are always a human decision.', allowOther: false, onTimeout: 'nothing',
    }));
  }
  return created;
}

/** Effect of a `policy_upgrade` decision: accepting is the only way a kind joins the auto-decide list. */
export function applyPolicyUpgrade(dataDir, card, optionId) {
  const kind = card.subject?.findingId;
  if (!kind || HUMAN_ONLY_KINDS.includes(kind)) return { ok: false, reason: 'unsupported_kind' };
  const state = readAutonomyState(dataDir);
  if (optionId === 'accept') state.policy.autoDecideKinds = [...new Set([...state.policy.autoDecideKinds, kind])];
  state.streakResetAt[kind] = new Date().toISOString();
  writeAutonomyState(dataDir, state);
  return { ok: true };
}

/** Executes recommended options of pending cards that pass `canAutoDecide`; each stays undoable for the window. */
export async function runAutoDecisions(dataDir, workspaceFolder, execute) {
  const { policy } = readAutonomyState(dataDir);
  const done = [];
  for (const card of (await listDecisions(dataDir, workspaceFolder)).filter((c) => canAutoDecide(c, policy))) {
    const claimed = await changeDecision(dataDir, card.id, card.revision, 'deciding', { claimedAt: new Date().toISOString() });
    if (!claimed) continue;
    const result = await execute(card, card.recommended).catch(() => ({ ok: false }));
    const decidedAt = new Date().toISOString();
    done.push(await changeDecision(dataDir, card.id, claimed.revision, result.ok ? 'decided' : 'pending', result.ok ? {
      optionId: card.recommended, decidedAt, decidedBy: { kind: 'auto' },
      undoUntil: new Date(Date.now() + policy.undoWindowMs).toISOString(), response: result.response || { text: '' },
    } : {}, 'deciding'));
  }
  return done.filter((c) => c?.status === 'decided');
}

/** Undo of an automatic decision, valid only inside its window. Marks the card; the producer reacts to `undone`. */
export async function undoAutoDecision(dataDir, card, now = Date.now()) {
  if (card.status !== 'decided' || card.decidedBy?.kind !== 'auto' || card.undone) return { ok: false, reason: 'not_undoable' };
  if (!(Date.parse(card.undoUntil || '') >= now)) return { ok: false, reason: 'window_closed' };
  // Re-open as pending so the human decides; the auto-decision stays in history through `undoneAuto`.
  const reopened = await changeDecision(dataDir, card.id, card.revision, 'pending', {
    undone: true, undoneAt: new Date(now).toISOString(), undoneAuto: { optionId: card.optionId, decidedAt: card.decidedAt },
    optionId: undefined, decidedAt: undefined, decidedBy: undefined,
  }, 'decided');
  return reopened ? { ok: true, decision: reopened } : { ok: false, reason: 'conflict' };
}
