/**
 * Shared identifier vocabulary for the recovery registry (leaf R2).
 *
 * Every durable recovery entity gets an opaque, prefixed token. The token is a
 * *stable* string accepted by the telemetry normalizers in
 * `lib/usage/usage-event.js` (`shortCode` trims and slices to 64 chars) and by
 * `lib/usage/usage-contract.js#buildLogicalUsageIdentity` (which applies
 * `String(value ?? '').trim()`). Keeping the format a single trimmed token —
 * no spaces, no newlines — means `logicalRunId` can later be passed as the
 * telemetry `runId` and `attemptId` as the telemetry `attemptId` unchanged.
 * This module intentionally does NOT import or modify the telemetry modules.
 *
 * Contract invariant (documented in docs/recovery-store.md): `logicalRunId`
 * and `attemptId` created here are the exact same values that recovery hands to
 * telemetry as `runId` / `attemptId`.
 *
 * The module is pure: no clock and no I/O. When `uuid` is injected the output
 * is fully deterministic; when it is omitted a random v4 UUID is generated.
 * An injected but malformed UUID is rejected loudly (no silent fallback).
 */

import { randomUUID } from 'node:crypto';

/** Entity kinds that may own a recovery id. */
export const RECOVERY_ID_KINDS = Object.freeze(['logical_run', 'attempt', 'request', 'cycle']);

/** Canonical prefix per kind. */
export const RECOVERY_ID_PREFIXES = Object.freeze({
  logical_run: 'lrun_',
  attempt: 'att_',
  request: 'req_',
  cycle: 'cyc_',
});

const PREFIX_BY_KIND = RECOVERY_ID_PREFIXES;
const KIND_BY_PREFIX = new Map(
  Object.entries(RECOVERY_ID_PREFIXES).map(([kind, prefix]) => [prefix, kind])
);

/**
 * Canonical UUID shape (8-4-4-4-12 hex). Any RFC 4122/9562 version is accepted
 * (v1..v8), not only v4; the requirement is a *valid* UUID, not a specific
 * version.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string} a lowercased, validated UUID, or '' when invalid
 */
function normalizeUuid(value) {
  const raw = text(value).toLowerCase();
  return UUID_RE.test(raw) ? raw : '';
}

/**
 * @param {unknown} kind
 * @returns {string} the canonical prefix, or ''
 */
function prefixFor(kind) {
  const id = text(kind);
  return RECOVERY_ID_KINDS.includes(id) ? PREFIX_BY_KIND[id] : '';
}

/**
 * Build one prefixed recovery id.
 *
 * @param {unknown} kind one of `RECOVERY_ID_KINDS`
 * @param {{ uuid?: string }} [options] injected UUID; generated when omitted
 * @returns {string} e.g. `att_3f1c...`
 * @throws {TypeError} for an unknown kind or a malformed injected UUID
 */
export function newRecoveryId(kind, { uuid } = {}) {
  const prefix = prefixFor(kind);
  if (!prefix) {
    throw new TypeError(
      `newRecoveryId: unknown kind ${JSON.stringify(text(kind))}; expected one of ${RECOVERY_ID_KINDS.join(', ')}`
    );
  }
  const normalized = normalizeUuid(uuid === undefined || uuid === null ? randomUUID() : uuid);
  if (!normalized) {
    throw new TypeError(`newRecoveryId: invalid uuid ${JSON.stringify(text(uuid))}`);
  }
  return `${prefix}${normalized}`;
}

/**
 * Parse a recovery id back into `{ kind, uuid }`.
 *
 * @param {unknown} value
 * @returns {{ kind: string, uuid: string } | null} null for anything malformed
 */
export function parseRecoveryId(value) {
  const raw = text(value);
  if (!raw) return null;
  for (const [prefix, kind] of KIND_BY_PREFIX) {
    if (!raw.startsWith(prefix)) continue;
    const uuid = normalizeUuid(raw.slice(prefix.length));
    if (!uuid) return null;
    return { kind, uuid };
  }
  return null;
}

/**
 * @param {unknown} value
 * @param {string} [kind] when given, the id must match this kind
 * @returns {boolean}
 */
export function isRecoveryId(value, kind) {
  const parsed = parseRecoveryId(value);
  if (!parsed) return false;
  if (kind === undefined || kind === null || kind === '') return true;
  return parsed.kind === text(kind);
}

/**
 * Create the four ids of one logical run from a single UUID, so a run's
 * `logicalRunId`, `attemptId`, `requestId` and `cycleId` share the same UUID
 * and differ only by prefix.
 *
 * @param {{ uuid?: string }} [options]
 * @returns {{ logicalRunId: string, attemptId: string, requestId: string, cycleId: string }}
 */
export function createRecoveryIds({ uuid } = {}) {
  const seed = uuid === undefined || uuid === null ? randomUUID() : uuid;
  return {
    logicalRunId: newRecoveryId('logical_run', { uuid: seed }),
    attemptId: newRecoveryId('attempt', { uuid: seed }),
    requestId: newRecoveryId('request', { uuid: seed }),
    cycleId: newRecoveryId('cycle', { uuid: seed }),
  };
}
