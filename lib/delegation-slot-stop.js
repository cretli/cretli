/**
 * Slot hold and stop proof fields for delegation cancel paths.
 */

import { getChatRunAdapterCapabilities } from './chat-run-service.js';
import {
  DELEGATION_SLOT_HELD_BY_RUNNING,
  isCancelUnconfirmedDelegationSlot,
  normalizeDelegationSlotHeldBy,
} from './delegation-status.js';
import { getDelegationById, updateDelegationRecord } from './persist/delegations-persist.js';
import { getTodo, updateTodo } from './persist/todos-store.js';
import { resolveDataPath } from './runtime-paths.js';

/** @typedef {import('./shared-types/index.js').DelegationRecord} DelegationRecord */

export {
  DELEGATION_SLOT_HELD_BY_CANCEL_UNCONFIRMED,
  DELEGATION_SLOT_HELD_BY_RUNNING,
  isCancelUnconfirmedDelegationSlot,
  normalizeDelegationSlotHeldBy,
  readDelegationSlotHeldBy,
} from './delegation-status.js';

export const TODO_BLOCKED_REASON_CANCEL_UNCONFIRMED = 'cancel_unconfirmed';

/**
 * @param {Record<string, any>} value
 * @returns {Record<string, any> | null}
 */
export function normalizeDelegationStopProof(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || '').trim().toLowerCase();
  if (!kind) return null;
  const at = String(value.at || '').trim();
  if (!at) return null;
  return {
    kind,
    at,
    attemptId: String(value.attemptId || '').trim(),
    runId: String(value.runId || '').trim(),
    source: String(value.source || '').trim(),
    note: String(value.note || '').trim(),
  };
}

/**
 * @param {DelegationRecord | null | undefined} row
 * @returns {Record<string, any> | null}
 */
export function readDelegationStopProof(row) {
  return normalizeDelegationStopProof(row?.stopProof);
}

/**
 * @param {Record<string, any>} row
 * @returns {boolean}
 */
export function delegationHarnessSupportsAbort(row) {
  const transport = String(row?.executor?.transport || '').trim();
  if (!transport) return false;
  return getChatRunAdapterCapabilities(transport).canCancel === true;
}

/**
 * @param {DelegationRecord} row
 * @param {{ kind: string, source?: string, note?: string }} input
 * @returns {Record<string, any> | null}
 */
export function writeDelegationStopProof(row, input) {
  if (!row?.id) return null;
  const proof = {
    kind: String(input.kind || '').trim().toLowerCase(),
    at: new Date().toISOString(),
    attemptId: String(row.attemptId || '').trim(),
    runId: String(row.runId || '').trim(),
    source: String(input.source || '').trim(),
    note: String(input.note || '').trim(),
  };
  return updateDelegationRecord(row.id, {
    stopProof: proof,
    slotHeldBy: DELEGATION_SLOT_HELD_BY_RUNNING,
  }) || row;
}

/**
 * Per-leaf tail of the todo writes issued for the cancel-unconfirmed block. The deadline path that
 * raises the block is synchronous (it must not wait for the todo store), so the write is queued here
 * and a later release for the same leaf runs after it instead of racing it.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const pendingTodoBlockWrites = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} write
 * @returns {Promise<T | null>}
 */
function queueTodoBlockWrite(key, write) {
  const previous = pendingTodoBlockWrites.get(key) || Promise.resolve();
  const run = previous.then(write).catch(() => null);
  pendingTodoBlockWrites.set(key, run);
  void run.finally(() => {
    if (pendingTodoBlockWrites.get(key) === run) pendingTodoBlockWrites.delete(key);
  });
  return run;
}

/** Resolves once every queued cancel-unconfirmed todo write has settled. */
export async function settleCancelUnconfirmedTodoWrites() {
  while (pendingTodoBlockWrites.size > 0) await Promise.all([...pendingTodoBlockWrites.values()]);
}

/**
 * Best-effort: a todo write failure never aborts the cancel path.
 *
 * @param {DelegationRecord} row
 * @returns {Promise<Record<string, any> | null>}
 */
export function blockTodoForCancelUnconfirmed(row) {
  const leafId = String(row.leafId || '').trim();
  const cwd = String(row.workspaceFolder || '').trim();
  if (!leafId || !cwd) return Promise.resolve(null);
  return queueTodoBlockWrite(`${cwd}\n${leafId}`, () => updateTodo(resolveDataPath(), cwd, leafId, {
    blockedReason: TODO_BLOCKED_REASON_CANCEL_UNCONFIRMED,
    appendChangelog: {
      kind: 'note',
      text: `Delegation ${row.id} stop was not confirmed; workspace slot remains held until manual release.`,
    },
  }));
}

/**
 * @param {DelegationRecord} row
 * @param {string} note
 * @returns {Promise<Record<string, any> | null>}
 */
export function clearTodoCancelUnconfirmedBlock(row, note) {
  const leafId = String(row.leafId || '').trim();
  const cwd = String(row.workspaceFolder || '').trim();
  if (!leafId || !cwd) return Promise.resolve(null);
  return queueTodoBlockWrite(`${cwd}\n${leafId}`, () => updateTodo(resolveDataPath(), cwd, leafId, {
    blockedReason: '',
    appendChangelog: {
      kind: 'note',
      text: note,
    },
  }));
}

/**
 * @param {Record<string, any>} row
 * @param {string} note
 * @returns {Promise<Record<string, any> | null>}
 */
async function appendManualReleaseChangelog(row, note) {
  const leafId = String(row.leafId || '').trim();
  const cwd = String(row.workspaceFolder || '').trim();
  if (leafId && cwd) {
    // Let a block still queued for this leaf land first, so the release cannot be overwritten by it.
    await settleCancelUnconfirmedTodoWrites();
    /** @type {Record<string, any> | null} */
    let leaf = null;
    try {
      leaf = await getTodo(resolveDataPath(), cwd, leafId);
    } catch {
      leaf = null;
    }
    if (leaf) {
      return clearTodoCancelUnconfirmedBlock(row, note);
    }
  }
  try {
    return updateDelegationRecord(row.id, {
      errorAppend: [{
        at: new Date().toISOString(),
        code: 'manual_slot_release',
        message: note,
        attemptId: String(row.attemptId || '').trim(),
      }],
    });
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} row
 * @param {{ confirmation?: unknown, note?: string, actor?: string }} input
 * @returns {Promise<{ ok: boolean, status?: number, code?: string, error?: string, delegation?: DelegationRecord }>}
 */
export async function confirmDelegationManualSlotRelease(row, input = {}) {
  if (!row?.id) {
    return { ok: false, status: 404, error: 'Delegation not found.', code: 'not_found' };
  }
  if (!isCancelUnconfirmedDelegationSlot(row)) {
    return {
      ok: false,
      status: 409,
      error: 'Manual slot release applies only to cancel_unconfirmed delegations.',
      code: 'not_cancel_unconfirmed',
    };
  }
  const confirmed = input.confirmation === true
    || String(input.confirmation || '').trim().toLowerCase() === 'true';
  if (!confirmed) {
    return {
      ok: false,
      status: 400,
      error: 'Explicit human confirmation is required (confirmation=true).',
      code: 'confirmation_required',
    };
  }
  const note = String(input.note || '').trim()
    || 'Operator confirmed the executor process was stopped outside the system; delegation slot released.';
  const actor = String(input.actor || 'human').trim() || 'human';
  const withProof = writeDelegationStopProof(row, {
    kind: 'manual',
    source: actor,
    note,
  }) || row;
  const released = updateDelegationRecord(withProof.id, {
    runStoppingAt: '',
    idleObservedAt: '',
    slotHeldBy: DELEGATION_SLOT_HELD_BY_RUNNING,
  }) || withProof;
  await appendManualReleaseChangelog(released, note);
  return { ok: true, status: 200, delegation: getDelegationById(released.id) || released };
}
