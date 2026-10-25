/**
 * Shared recovery owner for a delegation family (leaf R10).
 *
 * A *family* is the parent chat plus everything it owns: its child delegations,
 * the mailbox messages between them and its workflow state. After a restart
 * exactly one owner (the parent/orchestrator side) recovers the family; a child
 * delegation never starts, retries or resumes on its own.
 *
 * This module is the single place that:
 * - derives the family key (`resolveFamilyKey`),
 * - plans what boot recovery may do for a family (`planFamilyRecovery`, pure),
 * - claims a family durably with the R3 owner token + generation
 *   (`claimFamilyRecovery`, CAS in `recovery_meta`),
 * - redelivers the family outbox once, after boot reconciliation
 *   (`runFamilyBootRecovery`).
 *
 * Firm boundaries:
 * - Recovery never mutates workflow rounds, token/cost budgets, deadlines or
 *   todo/leaf claims. The plan carries no such mutation and the runner never
 *   writes them; the R1 accounting stays with the owner of the cycle.
 * - Recovery never starts a child. The single `server_restart` continuation
 *   stays an explicit, once-per-record retry (`interruptContinuedAt`); the plan
 *   only reports which rows are still eligible for it.
 * - A slot held by an active row, or by a terminal row with an unconfirmed stop
 *   (`runStoppingAt`), stays occupied. A row being stopped is never resumed.
 * - Mailbox `uncertain` rows are never auto-redelivered (acceptance unknown).
 */

import { checkRecoveryOwnerFence } from './recovery-owner-lease.ts';
import { getRecoveryStoreDatabase } from './recovery-store.ts';
import {
  DELEGATION_INTERRUPT_SERVER_RESTART,
  isDelegationSlotOccupied,
  normalizeDelegationInterruptCode,
} from '../delegation-status.js';

/** Shape version of the durable family claim record. */
export const FAMILY_RECOVERY_SCHEMA_VERSION = 1;

/** `recovery_meta` key prefix; one row per family. */
export const FAMILY_RECOVERY_META_PREFIX = 'familyRecovery:';

/** Why a claim attempt was refused or accepted. */
export const FAMILY_CLAIM_REASONS = Object.freeze([
  'claimed',
  'renewed',
  'takeover',
  'stale_generation',
  'fence_rejected',
  'invalid_input',
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Family key of a delegation row or mailbox message: the parent chat owns the
 * family. A row without a parent chat is its own one-member family.
 *
 * @param {{ parentChatId?: unknown, id?: unknown, delegationId?: unknown } | null | undefined} row
 * @returns {string}
 */
export function resolveFamilyKey(row: { parentChatId?: unknown, id?: unknown, delegationId?: unknown } | null | undefined): string {
  const parent = text(row?.parentChatId);
  if (parent) return `family:${parent}`;
  const own = text(row?.id) || text(row?.delegationId);
  return own ? `family:orphan:${own}` : '';
}

/**
 * Pure plan for boot recovery of every family. Reads rows only.
 *
 * @param {{
 *   delegations?: object[],
 *   mailbox?: object[],
 *   now?: number,
 * }} [input]
 * @returns {{
 *   families: Array<{
 *     familyKey: string,
 *     ownerChatId: string,
 *     childIds: string[],
 *     slotOccupied: boolean,
 *     occupiedChildIds: string[],
 *     stoppingChildIds: string[],
 *     noResumeChildIds: string[],
 *     restartRetryEligibleIds: string[],
 *     autoStartChildIds: string[],
 *     outboxIds: string[],
 *     outboxRecipientChatIds: string[],
 *     uncertainOutboxIds: string[],
 *     budgetMutations: string[],
 *   }>,
 * }}
 */
type FamilyPlan = { familyKey: string, ownerChatId: string, childIds: string[], slotOccupied: boolean, occupiedChildIds: string[], stoppingChildIds: string[], noResumeChildIds: string[], restartRetryEligibleIds: string[], autoStartChildIds: string[], outboxIds: string[], outboxRecipientChatIds: string[], uncertainOutboxIds: string[], budgetMutations: string[], };

export function planFamilyRecovery(input: { delegations?: Record<string, any>[], mailbox?: Record<string, any>[], now?: number, } = {}): { families: FamilyPlan[], } {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const mailbox = Array.isArray(input.mailbox) ? input.mailbox : [];
  const byId: Map<string, Record<string, any>> = new Map();
  const families: Map<string, FamilyPlan> = new Map();
  const ensure = (key: string, ownerChatId: string): FamilyPlan => {
    if (!families.has(key)) {
      families.set(key, {
        familyKey: key,
        ownerChatId,
        childIds: [],
        slotOccupied: false,
        occupiedChildIds: [],
        stoppingChildIds: [],
        noResumeChildIds: [],
        restartRetryEligibleIds: [],
        // Children are never started by recovery; kept as an explicit invariant.
        autoStartChildIds: [],
        outboxIds: [],
        outboxRecipientChatIds: [],
        uncertainOutboxIds: [],
        // Rounds, budgets, deadlines and claims are never touched by recovery.
        budgetMutations: [],
      });
    }
    return families.get(key) as FamilyPlan;
  };
  for (const row of delegations) {
    const key = resolveFamilyKey(row);
    const id = text(row?.id);
    if (!key || !id) continue;
    byId.set(id, row);
    const family = ensure(key, text(row.parentChatId));
    family.childIds.push(id);
    if (isDelegationSlotOccupied(row, now)) {
      family.slotOccupied = true;
      family.occupiedChildIds.push(id);
    }
    if (text(row.runStoppingAt)) {
      family.stoppingChildIds.push(id);
      family.noResumeChildIds.push(id);
    }
    if (
      text(row.status) === 'interrupted'
      && normalizeDelegationInterruptCode(row.interruptCode) === DELEGATION_INTERRUPT_SERVER_RESTART
      && !text(row.interruptContinuedAt)
      && !text(row.runStoppingAt)
    ) {
      family.restartRetryEligibleIds.push(id);
    }
  }
  for (const message of mailbox) {
    if (!message || text(message.status) === 'delivered') continue;
    const linked = byId.get(text(message.delegationId));
    const key = linked
      ? resolveFamilyKey(linked)
      : resolveFamilyKey({ parentChatId: text(message.toChatId) || text(message.fromChatId) });
    const id = text(message.id);
    if (!key || !id) continue;
    const family = ensure(key, text(linked?.parentChatId) || text(message.toChatId));
    if (text(message.status) === 'uncertain') {
      family.uncertainOutboxIds.push(id);
      continue;
    }
    if (text(message.status) !== 'queued') continue;
    family.outboxIds.push(id);
    const recipient = text(message.toChatId);
    if (recipient && !family.outboxRecipientChatIds.includes(recipient)) {
      family.outboxRecipientChatIds.push(recipient);
    }
  }
  return { families: [...families.values()] };
}

/**
 * @param {string} familyKey
 * @returns {string}
 */
function metaKey(familyKey: string): string {
  return `${FAMILY_RECOVERY_META_PREFIX}${familyKey}`;
}

/**
 * @param {object} db
 * @param {string} familyKey
 * @returns {object | null}
 */
function readClaim(db: Record<string, any>, familyKey: string): Record<string, any> | null {
  const row = db.prepare('SELECT value FROM recovery_meta WHERE key = ?').get(metaKey(familyKey));
  if (!row) return null;
  try {
    const parsed = JSON.parse(String(row.value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

type GetFamilyClaimInput = { familyKey: string, store?: Record<string, any> };

/**
 * Read the durable claim of a family without mutating it.
 *
 * @param {{ familyKey: string, store?: object }} input
 * @returns {object | null}
 */
export function getFamilyClaim(input: GetFamilyClaimInput = {} as GetFamilyClaimInput): Record<string, any> | null {
  return readClaim(getRecoveryStoreDatabase(input.store), text(input.familyKey));
}

type ClaimFamilyRecoveryInput = { familyKey: string, ownerToken: string, generation: number, now?: number, bootId?: string, store?: Record<string, any>, ttlMs?: number, };

/**
 * Claim a family for recovery. One CAS in an IMMEDIATE transaction decides:
 * absent -> `claimed`; same token+generation -> `renewed`; a claim under
 * another token or an older generation -> `takeover` (the recorded outbox
 * progress is kept so nothing is redelivered); the same token with a newer
 * stored generation -> `stale_generation`. Mutual exclusion between two live
 * owners comes from the R3 fence: a caller without the live lease is refused
 * with `fence_rejected`, so a second live owner never reaches the CAS.
 *
 * @param {{
 *   familyKey: string, ownerToken: string, generation: number,
 *   now?: number, bootId?: string, store?: object, ttlMs?: number,
 * }} input
 * @returns {{ ok: boolean, reason: string, claim: object | null }}
 */
export function claimFamilyRecovery(input: ClaimFamilyRecoveryInput = {} as ClaimFamilyRecoveryInput): { ok: boolean, reason: string, claim: Record<string, any> | null } {
  const familyKey = text(input.familyKey);
  const ownerToken = text(input.ownerToken);
  const generation = Math.floor(Number(input.generation));
  if (!familyKey || !ownerToken || !Number.isFinite(generation) || generation < 1) {
    return { ok: false, reason: 'invalid_input', claim: null };
  }
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const fence = checkRecoveryOwnerFence({ store: input.store, ownerToken, generation, now, ttlMs: input.ttlMs });
  if (!fence.ok) return { ok: false, reason: 'fence_rejected', claim: null };
  const db = getRecoveryStoreDatabase(input.store);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readClaim(db, familyKey);
    let reason = 'claimed';
    if (current) {
      const storedGeneration = Math.floor(Number(current.generation)) || 0;
      if (text(current.ownerToken) === ownerToken) {
        if (storedGeneration > generation) {
          db.exec('ROLLBACK');
          return { ok: false, reason: 'stale_generation', claim: current };
        }
        reason = storedGeneration === generation ? 'renewed' : 'takeover';
      } else {
        // The fence above proves the caller is the only live lease holder, so
        // a claim under another token belongs to a released or dead owner. The
        // R3 lease row is deleted on release and generations restart at 1, so
        // token/generation of the old claim cannot be compared: always take
        // over and keep `outboxDone` (no redelivery).
        reason = 'takeover';
      }
    }
    const claim = {
      schemaVersion: FAMILY_RECOVERY_SCHEMA_VERSION,
      familyKey,
      ownerToken,
      generation,
      bootId: text(input.bootId) || text(current?.bootId),
      claimedAt: new Date(now).toISOString(),
      completedAt: reason === 'renewed' ? text(current?.completedAt) : '',
      outboxDone: Array.isArray(current?.outboxDone) ? current.outboxDone.slice() : [],
    };
    db.prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
      .run(metaKey(familyKey), JSON.stringify(claim));
    db.exec('COMMIT');
    return { ok: true, reason, claim };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original failure is the useful one.
    }
    throw err;
  }
}

type AuthorizeFamilyRecoveryActionInput = { familyKey: string, ownerToken?: string, generation?: number, store?: Record<string, any> };

/**
 * Whether the caller currently is the recorded owner of the family. A child
 * delegation has no token of its own, so it can never pass this gate.
 *
 * @param {{ familyKey: string, ownerToken?: string, generation?: number, store?: object }} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export function authorizeFamilyRecoveryAction(input: AuthorizeFamilyRecoveryActionInput = {} as AuthorizeFamilyRecoveryActionInput): { allowed: boolean, reason: string } {
  const claim = getFamilyClaim({ familyKey: input.familyKey, store: input.store });
  if (!claim) return { allowed: false, reason: 'no_family_claim' };
  if (!text(input.ownerToken) || text(claim.ownerToken) !== text(input.ownerToken)) {
    return { allowed: false, reason: 'not_family_owner' };
  }
  if ((Math.floor(Number(claim.generation)) || 0) !== Math.floor(Number(input.generation))) {
    return { allowed: false, reason: 'generation_mismatch' };
  }
  return { allowed: true, reason: 'family_owner' };
}

type UpdateFamilyClaimInput = { familyKey: string, ownerToken: string, generation: number, outboxDone?: string[], completed?: boolean, now?: number, store?: Record<string, any>, };

/**
 * Record redelivered outbox ids and/or the completion of the family pass, only
 * while the caller still owns the claim (token + generation CAS).
 *
 * @param {{
 *   familyKey: string, ownerToken: string, generation: number,
 *   outboxDone?: string[], completed?: boolean, now?: number, store?: object,
 * }} input
 * @returns {{ ok: boolean, reason: string, claim: object | null }}
 */
export function updateFamilyClaim(input: UpdateFamilyClaimInput = {} as UpdateFamilyClaimInput): { ok: boolean, reason: string, claim: Record<string, any> | null } {
  const familyKey = text(input.familyKey);
  const db = getRecoveryStoreDatabase(input.store);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readClaim(db, familyKey);
    if (
      !current
      || text(current.ownerToken) !== text(input.ownerToken)
      || (Math.floor(Number(current.generation)) || 0) !== Math.floor(Number(input.generation))
    ) {
      db.exec('ROLLBACK');
      return { ok: false, reason: current ? 'not_family_owner' : 'no_family_claim', claim: current };
    }
    const done = new Set(Array.isArray(current.outboxDone) ? current.outboxDone : []);
    for (const id of Array.isArray(input.outboxDone) ? input.outboxDone : []) done.add(text(id));
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const next = {
      ...current,
      outboxDone: [...done].filter(Boolean),
      completedAt: input.completed === true ? new Date(now).toISOString() : text(current.completedAt),
    };
    db.prepare('INSERT OR REPLACE INTO recovery_meta(key, value) VALUES(?, ?)')
      .run(metaKey(familyKey), JSON.stringify(next));
    db.exec('COMMIT');
    return { ok: true, reason: 'updated', claim: next };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The original failure is the useful one.
    }
    throw err;
  }
}

type RunFamilyBootRecoveryInput = { delegations?: Record<string, any>[], mailbox?: Record<string, any>[], ownerToken: string, generation: number, bootReconciled?: boolean, drainRecipient: (chatId: string, opts: { onlyIds: string[] }) => Promise<Record<string, any>[]> | Record<string, any>[], now?: number, bootId?: string, store?: Record<string, any>, };

/**
 * Boot pass over every family: claim, redeliver the queued outbox once, mark
 * the family complete. Runs only after boot reconciliation (R8); a family held
 * by another owner is skipped, never raced. Children are not started here.
 *
 * @param {{
 *   delegations?: object[],
 *   mailbox?: object[],
 *   ownerToken: string,
 *   generation: number,
 *   bootReconciled?: boolean,
 *   drainRecipient: (chatId: string, opts: { onlyIds: string[] }) => Promise<object[]> | object[],
 *   now?: number,
 *   bootId?: string,
 *   store?: object,
 * }} input
 * @returns {Promise<{ ok: boolean, reason: string, families: object[] }>}
 */
export async function runFamilyBootRecovery(input: RunFamilyBootRecoveryInput = {} as RunFamilyBootRecoveryInput): Promise<{ ok: boolean, reason: string, families: Record<string, any>[] }> {
  if (input.bootReconciled !== true) {
    return { ok: false, reason: 'boot_not_reconciled', families: [] };
  }
  const plan = planFamilyRecovery({ delegations: input.delegations, mailbox: input.mailbox, now: input.now });
  const results = [];
  for (const family of plan.families) {
    // A family without queued outbox needs no claim (no row growth per boot).
    if (family.outboxIds.length === 0) continue;
    try {
      results.push(await recoverFamilyOutbox(family, input));
    } catch (err) {
      results.push({
        familyKey: family.familyKey,
        claimed: false,
        reason: 'family_failed',
        error: err instanceof Error ? err.message : String(err || 'family_failed'),
        redelivered: [],
      });
    }
  }
  return { ok: true, reason: 'completed', families: results };
}

/**
 * Claim one family and redeliver only its own queued outbox rows.
 *
 * @param {{ familyKey: string, outboxIds: string[], outboxRecipientChatIds: string[], slotOccupied: boolean }} family
 * @param {object} input
 * @returns {Promise<object>}
 */
async function recoverFamilyOutbox(family: { familyKey: string, outboxIds: string[], outboxRecipientChatIds: string[], slotOccupied: boolean }, input: Record<string, any>): Promise<Record<string, any>> {
  const claim = claimFamilyRecovery({
    familyKey: family.familyKey,
    ownerToken: input.ownerToken,
    generation: input.generation,
    now: input.now,
    bootId: input.bootId,
    store: input.store,
  });
  if (!claim.ok) {
    return { familyKey: family.familyKey, claimed: false, reason: claim.reason, redelivered: [] };
  }
  const already = new Set(claim.claim?.outboxDone);
  const pending = new Set(family.outboxIds.filter((id: string) => !already.has(id)));
  const redelivered: string[] = [];
  try {
    if (pending.size > 0) {
      for (const chatId of family.outboxRecipientChatIds) {
        const delivered = await input.drainRecipient(chatId, { onlyIds: [...pending] });
        for (const row of Array.isArray(delivered) ? delivered : []) {
          const id = text(row?.id);
          if (pending.has(id) && text(row?.status) === 'delivered' && !redelivered.includes(id)) {
            redelivered.push(id);
          }
        }
      }
    }
  } finally {
    // Record what was really delivered, even when a later recipient threw.
    updateFamilyClaim({
      familyKey: family.familyKey,
      ownerToken: input.ownerToken,
      generation: input.generation,
      outboxDone: redelivered,
      completed: true,
      now: input.now,
      store: input.store,
    });
  }
  return {
    familyKey: family.familyKey,
    claimed: true,
    reason: claim.reason,
    redelivered,
    slotOccupied: family.slotOccupied,
  };
}
