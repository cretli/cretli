/**
 * Pure validation kernel for delegation ratings (parent/user feedback on a
 * finished job). No I/O here — persistence lives in
 * `lib/persist/delegation-ratings-persist.js`.
 *
 * Contract (product decisions recorded in the TODO body):
 * - stars 1..5 only, no thumbs and no alias scale;
 * - a rating is immutable per `(delegationId, rater)`: an identical replay
 *   succeeds, a changed payload conflicts;
 * - `user` is one app-wide slot in this installation (a multi-user key would
 *   break that uniqueness and needs its own design);
 * - the rater comes from the transport (MCP = parent, HTTP card = user) and is
 *   never read from a caller-supplied input field.
 */

import { createHash } from 'node:crypto';
import {
  DELEGATION_RATING_MAX_SCORE,
  DELEGATION_RATING_MIN_SCORE,
  DELEGATION_RATING_NEGATIVE_TAGS,
  DELEGATION_RATING_RATERS,
  DELEGATION_RATING_TAGS,
  DELEGATION_RATING_USER_WEIGHT,
  DELEGATION_RATING_PARENT_WEIGHT,
  MAX_DELEGATION_RATING_NOTE_LENGTH,
  MAX_DELEGATION_RATING_TAGS,
} from './delegation-rating-constants.js';
export {
  DELEGATION_RATING_MAX_SCORE,
  DELEGATION_RATING_MIN_SCORE,
  DELEGATION_RATING_NEGATIVE_TAGS,
  DELEGATION_RATING_POSITIVE_TAGS,
  DELEGATION_RATING_RATERS,
  DELEGATION_RATING_TAGS,
  DELEGATION_RATING_USER_WEIGHT,
  DELEGATION_RATING_PARENT_WEIGHT,
  MAX_DELEGATION_RATING_NOTE_LENGTH,
  MAX_DELEGATION_RATING_TAGS,
} from './delegation-rating-constants.js';

/** The praise tag that requires a good score; `caught_bug` stays score-free. */
const DELEGATION_RATING_GREAT_TAG = 'great';

/**
 * A critical tag claims the job failed the reviewer, so it cannot ride a good
 * score; `great` claims the job was excellent, so it cannot ride a bad one.
 * Rejecting the mix keeps the star mean honest — an accurate review FAIL was
 * historically mis-tagged `missed_bug` at 5 stars, inflating observed quality.
 *
 * @param {number} score
 * @param {string[]} tags
 * @returns {null | { code: string, error: string }}
 */
function contradictoryRatingTag(score, tags) {
  if (score >= 4) {
    const critical = tags.find((tag) => DELEGATION_RATING_NEGATIVE_TAGS.includes(tag));
    if (critical) {
      return {
        code: 'contradictory_rating',
        error: `The tag ${critical} only fits a critical score; use score ${DELEGATION_RATING_MIN_SCORE}..3, or report a correct review finding as score 4..5 with the tag caught_bug.`,
      };
    }
  }
  if (score <= 3 && tags.includes(DELEGATION_RATING_GREAT_TAG)) {
    return {
      code: 'contradictory_rating',
      error: `The tag ${DELEGATION_RATING_GREAT_TAG} only fits a good score; use score 4..${DELEGATION_RATING_MAX_SCORE}.`,
    };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {'' | 'parent' | 'user'}
 */
export function normalizeDelegationRatingRater(value) {
  const raw = String(value || '').trim().toLowerCase();
  return DELEGATION_RATING_RATERS.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDelegationRatingTag(value) {
  return DELEGATION_RATING_TAGS.includes(String(value || '').trim().toLowerCase());
}

/**
 * @param {unknown} rater
 * @returns {number}
 */
export function delegationRatingRaterWeight(rater) {
  return normalizeDelegationRatingRater(rater) === 'user'
    ? DELEGATION_RATING_USER_WEIGHT
    : DELEGATION_RATING_PARENT_WEIGHT;
}

/**
 * Validate and normalize one rating payload. Unknown extra fields are
 * deliberately ignored (never read), so no input can smuggle a `rater`.
 *
 * @param {unknown} input
 * @returns {{ ok: true, value: { score: number, tags: string[], note: string } }
 *   | { ok: false, status: number, code: string, error: string }}
 */
export function normalizeDelegationRatingPayload(input) {
  const source = input && typeof input === 'object'
    ? /** @type {Record<string, unknown>} */ (input)
    : {};
  const score = source.score;
  if (!Number.isInteger(score)
    || Number(score) < DELEGATION_RATING_MIN_SCORE
    || Number(score) > DELEGATION_RATING_MAX_SCORE) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_rating_score',
      error: `score must be an integer from ${DELEGATION_RATING_MIN_SCORE} to ${DELEGATION_RATING_MAX_SCORE}.`,
    };
  }
  /** @type {string[]} */
  const tags = [];
  const rawTags = source.tags;
  if (rawTags !== undefined && rawTags !== null) {
    if (!Array.isArray(rawTags)) {
      return { ok: false, status: 400, code: 'invalid_rating_tags', error: 'tags must be an array.' };
    }
    for (const entry of rawTags) {
      const tag = String(entry ?? '').trim().toLowerCase();
      if (!isDelegationRatingTag(tag)) {
        return { ok: false, status: 400, code: 'invalid_rating_tags', error: `Unknown rating tag: ${tag}` };
      }
      if (!tags.includes(tag)) tags.push(tag);
    }
    if (tags.length > MAX_DELEGATION_RATING_TAGS) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_rating_tags',
        error: `At most ${MAX_DELEGATION_RATING_TAGS} rating tags are allowed.`,
      };
    }
  }
  let note = '';
  const rawNote = source.note;
  if (rawNote !== undefined && rawNote !== null) {
    if (typeof rawNote !== 'string') {
      return { ok: false, status: 400, code: 'invalid_rating_note', error: 'note must be a string.' };
    }
    note = rawNote.trim();
    if (note.length > MAX_DELEGATION_RATING_NOTE_LENGTH) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_rating_note',
        error: `note must be at most ${MAX_DELEGATION_RATING_NOTE_LENGTH} characters.`,
      };
    }
  }
  const value = { score: Number(score), tags, note };
  // Runs last so the score/tags/note codes keep their existing precedence.
  const contradiction = contradictoryRatingTag(value.score, tags);
  if (contradiction) return { ok: false, status: 400, ...contradiction };
  return { ok: true, value };
}

/**
 * Payload fingerprint used for the `(delegationId, rater)` replay/conflict
 * decision. Tags are order-insensitive so a reordered replay still matches.
 *
 * @param {{ score?: unknown, tags?: unknown, note?: unknown }} value
 * @returns {string}
 */
export function fingerprintDelegationRating(value) {
  const tags = Array.isArray(value?.tags)
    ? [...new Set(value.tags.map((tag) => String(tag ?? '').trim().toLowerCase()))].sort()
    : [];
  const payload = {
    score: Number(value?.score),
    tags,
    note: String(value?.note ?? '').trim(),
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

/**
 * Unique key of one stored rating. Ratings are immutable per key.
 *
 * @param {unknown} delegationId
 * @param {unknown} rater
 * @returns {string}
 */
export function delegationRatingKey(delegationId, rater) {
  return `${String(delegationId || '')}:${normalizeDelegationRatingRater(rater)}`;
}

/**
 * Validate a record read back from disk. A truncated/corrupt JSONL line is
 * dropped instead of poisoning the aggregation.
 *
 * @param {unknown} value
 * @returns {null | {
 *   delegationId: string,
 *   parentChatId: string,
 *   harness: string,
 *   model: string,
 *   role: string,
 *   rater: 'parent' | 'user',
 *   score: number,
 *   tags: string[],
 *   note: string,
 *   ts: string,
 *   fingerprint: string,
 * }}
 */
export function normalizeDelegationRatingRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  const delegationId = String(source.delegationId || '').trim();
  const rater = normalizeDelegationRatingRater(source.rater);
  const score = source.score;
  if (!delegationId || !rater) return null;
  if (!Number.isInteger(score)
    || Number(score) < DELEGATION_RATING_MIN_SCORE
    || Number(score) > DELEGATION_RATING_MAX_SCORE) return null;
  const ts = String(source.ts || '');
  if (!Number.isFinite(Date.parse(ts))) return null;
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => String(tag ?? '').trim().toLowerCase()).filter(isDelegationRatingTag)
    : [];
  return {
    delegationId,
    parentChatId: String(source.parentChatId || '').trim(),
    harness: String(source.harness || '').trim().toLowerCase(),
    model: String(source.model || '').trim().toLowerCase(),
    role: String(source.role || '').trim().toLowerCase(),
    rater,
    score: Number(score),
    tags,
    note: String(source.note ?? '').trim(),
    ts,
    fingerprint: String(source.fingerprint || '').trim(),
  };
}

/**
 * Compact snapshot embedded in the delegation card payload — metadata only,
 * never the report body. The card shape is a subset of a stored record (no
 * job identity), so it is validated on its own terms; anything malformed
 * degrades to "not rated" instead of breaking the card.
 *
 * @param {unknown} value
 * @returns {null | { score: number, tags: string[], note: string, ts: string }}
 */
export function delegationRatingCardSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = /** @type {Record<string, unknown>} */ (value);
  const score = source.score;
  if (!Number.isInteger(score)
    || Number(score) < DELEGATION_RATING_MIN_SCORE
    || Number(score) > DELEGATION_RATING_MAX_SCORE) return null;
  const ts = String(source.ts || '');
  if (!Number.isFinite(Date.parse(ts))) return null;
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => String(tag ?? '').trim().toLowerCase()).filter(isDelegationRatingTag)
    : [];
  return { score: Number(score), tags, note: String(source.note ?? '').trim(), ts };
}

/**
 * Weighted mean over stored records: `user` counts twice per `parent`. The raw
 * count `rating_n` is the number of records, not the sum of weights.
 *
 * @param {unknown[]} records
 * @returns {{ rating_avg: number | null, rating_n: number }}
 */
export function summarizeDelegationRatings(records) {
  const list = Array.isArray(records) ? records : [];
  let weighted = 0;
  let weights = 0;
  let ratingN = 0;
  for (const entry of list) {
    const record = normalizeDelegationRatingRecord(entry);
    if (!record) continue;
    const weight = delegationRatingRaterWeight(record.rater);
    weighted += record.score * weight;
    weights += weight;
    ratingN += 1;
  }
  return {
    rating_avg: weights > 0 ? weighted / weights : null,
    rating_n: ratingN,
  };
}

/**
 * Ranking variant: only the `user` rater counts, so a parent cannot lift the
 * observed quality of the models it orchestrated (self-confirming feedback).
 * Parent ratings stay readable through `summarizeDelegationRatings` as
 * telemetry/display. With one rater the weight is a no-op, so the mean is the
 * plain user average and `rating_n` is the number of user records.
 *
 * @param {unknown[]} records
 * @returns {{ rating_avg: number | null, rating_n: number }}
 */
export function summarizeDelegationRatingsForScoring(records) {
  const list = Array.isArray(records) ? records : [];
  let total = 0;
  let count = 0;
  for (const entry of list) {
    const record = normalizeDelegationRatingRecord(entry);
    if (!record || record.rater !== 'user') continue;
    total += record.score;
    count += 1;
  }
  return {
    rating_avg: count > 0 ? total / count : null,
    rating_n: count,
  };
}
