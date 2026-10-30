/**
 * Web Push for decision cards. Only cards the server classified as low-risk, reversible and not
 * human-only get [Yes, No] actions and a per-device action token; every other card gets a plain
 * push that deep-links to the card. The token travels only inside the encrypted Web Push payload.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { listPushSubscriptions, sendPushToEndpoint, isPushAvailable } from '../push.js';
import { normalizePushPreferences } from '../push-preferences.js';
import { isQuietHoursActive, normalizeQuietHours } from '../push-quiet-hours.js';
import { msg } from '../messages.js';

export const DECISION_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Kinds that must never receive an action token, whatever the stored classification says. */
export const NEVER_TOKEN_KINDS = Object.freeze(['plan_approval', 'integration', 'policy_upgrade']);
export const DECISION_PUSH_CHANNEL = 'push';

/** Per-process signing secret: tokens do not survive a restart, which is acceptable for a short TTL. */
const SECRET = randomBytes(32);
/** jti -> record. Deleted on first use or expiry (single use). */
const issued = new Map();

const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('base64url');

/** Test helper. */
export function resetDecisionTokens() { issued.clear(); }

/**
 * The server-side gate: low risk, reversible, not human-only, not a gate kind, exactly two options.
 * @returns {{ yes: string, no: string } | null} option ids mapped to the Yes/No actions
 */
export function resolveYesNoOptions(card) {
  if (!card || card.status !== 'pending') return null;
  if (NEVER_TOKEN_KINDS.includes(card.kind)) return null;
  if (card.risk !== 'low' || card.reversible !== true || card.humanOnly !== false) return null;
  if (!Array.isArray(card.options) || card.options.length !== 2) return null;
  const yes = card.options.find((o) => o.id === card.recommended) || card.options[0];
  const no = card.options.find((o) => o.id !== yes.id);
  return no ? { yes: yes.id, no: no.id } : null;
}

/** Issue a token bound to decisionId, revision and the device subscription endpoint. */
export function issueDecisionToken(card, endpoint, now = Date.now()) {
  const options = resolveYesNoOptions(card);
  if (!options || !endpoint) return null;
  const jti = randomBytes(16).toString('base64url');
  issued.set(jti, {
    decisionId: card.id, revision: card.revision, endpointHash: hash(endpoint), options,
    expiresAt: now + DECISION_TOKEN_TTL_MS,
  });
  for (const [key, rec] of issued) if (rec.expiresAt < now) issued.delete(key);
  return `${jti}.${sign(jti)}`;
}

/**
 * Consume a token (single use). The caller then checks the card revision/status itself.
 * @param {unknown} token
 * @param {{ choice?: string, endpoint?: string, now?: number }} [options]
 * @returns {{ ok: true, record: { decisionId: string, revision: number, endpointHash: string, options: { yes: string, no: string }, expiresAt: number }, optionId: string } | { ok: false, reason: string }}
 */
export function consumeDecisionToken(token, { choice, endpoint, now = Date.now() } = {}) {
  const [jti, sig] = String(token || '').split('.');
  if (!jti || !sig) return { ok: false, reason: 'invalid_token' };
  const expected = Buffer.from(sign(jti));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'invalid_token' };
  const record = issued.get(jti);
  if (!record) return { ok: false, reason: 'used_or_unknown' };
  if (record.expiresAt < now) { issued.delete(jti); return { ok: false, reason: 'expired' }; }
  if (record.endpointHash !== hash(endpoint || '')) return { ok: false, reason: 'wrong_subscription' };
  if (choice !== 'yes' && choice !== 'no') return { ok: false, reason: 'invalid_choice' };
  issued.delete(jti);
  return { ok: true, record, optionId: record.options[choice] };
}

function preferenceEventFor(card) {
  return card.kind === 'permission' || card.kind === 'browser_consent' ? 'permission' : 'question';
}

/** Per-device gate from lib/push-preferences.js and the quiet window (read only). */
export function deviceAllowsDecisionPush(sub, card, now = new Date()) {
  const prefs = normalizePushPreferences(sub.preferences);
  if (prefs.enabled === false || prefs.events[preferenceEventFor(card)] === false) return false;
  const quiet = normalizeQuietHours(sub.preferences?.quietHours ?? sub.quietHours);
  return !(quiet.enabled && isQuietHoursActive(now, quiet));
}

/** Notification payload for one device; `token` present only for low-risk cards. */
export function buildDecisionPushPayload(card, token, req = null) {
  const data = {
    type: 'decision-card', kind: card.kind, decisionId: card.id,
    url: `/?source=pwa&panel=decisions&decision=${encodeURIComponent(card.id)}`, at: Date.now(),
  };
  const payload = {
    title: msg(req, 'decisionPush.title'),
    body: String(card.title || '').slice(0, 140),
    tag: `cretli-decision-${card.id}`,
    data,
  };
  if (token) {
    data.decisionToken = token;
    data.decisionRevision = card.revision;
    payload.actions = [
      { action: 'yes', title: msg(req, 'decisionPush.yes') },
      { action: 'no', title: msg(req, 'decisionPush.no') },
    ];
  }
  return payload;
}

/**
 * Fire-and-forget push for a newly pending card. Deps are injectable for tests.
 * @returns {Promise<{ sent: number, skipped: number }>}
 */
export async function notifyDecisionCard(card, deps = {}) {
  const list = deps.listSubscriptions || listPushSubscriptions;
  const send = deps.send || sendPushToEndpoint;
  if (!deps.send && !isPushAvailable()) return { sent: 0, skipped: 0 };
  let sent = 0;
  let skipped = 0;
  for (const sub of list()) {
    if (!deviceAllowsDecisionPush(sub, card, deps.now)) { skipped++; continue; }
    const token = issueDecisionToken(card, sub.endpoint);
    const result = await send(sub.endpoint, buildDecisionPushPayload(card, token));
    if (result?.ok) sent++; else skipped++;
  }
  return { sent, skipped };
}
