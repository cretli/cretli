/**
 * Shared Scout occupancy predicate (stage 3).
 *
 * A Scout slot is held by more than an unexpired submit token: a reservation
 * without a chat yet, a live/uncertain process and the review children of a
 * finished scan all occupy one shared Scout slot. The scheduler, the drain /
 * boot reconciliation and `readyForRestart` must agree on this predicate, so it
 * lives in one small dependency-free module instead of drifting between them.
 *
 * `expiresAt` (the submit TTL) never decides occupancy on its own: a launched
 * scan that is past its TTL but still busy stays occupied until a liveness probe
 * says otherwise.
 */

import {
  WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES,
  getActiveScoutScans,
} from './persist/workspace-watchers-persist.js';
import { isDelegationSlotOccupied } from './delegation-status.js';
import { listDelegationsForParent as defaultListDelegationsForParent } from './persist/delegations-persist.js';

/**
 * Whether one active-scan record still holds a Scout slot. A never-launched
 * reservation only holds it until its start deadline; after that it is
 * drainable — but ONLY if the owner instance is confirmed dead. Pass
 * `instanceId` (the current server instance) so a live reservation is never
 * freed before reconciliation confirms the owner is gone.
 *
 * @param {object | null | undefined} scan
 * @param {number} now
 * @param {string} [instanceId] current server instance id
 * @returns {boolean}
 */
export function isScoutScanOccupied(scan, now, instanceId) {
  if (!scan || !scan.scanId) return false;
  if (!WORKSPACE_SCOUT_SCAN_NON_TERMINAL_STATUSES.includes(String(scan.status || ''))) return false;
  if (scan.launchIssued === true || String(scan.acceptedAt || '').trim()) return true;
  const startDeadline = Date.parse(String(scan.startDeadlineAt || ''));
  if (Number.isFinite(startDeadline) && now >= startDeadline) {
    // Past deadline: only grant drain/restart when the owner is confirmed dead.
    // If instanceId is provided and matches the scan owner, the owner is still
    // alive — keep the slot occupied until reconciliation handles it.
    const owner = String(scan.ownerInstance || '').trim();
    const current = String(instanceId || '').trim();
    if (owner && current && owner === current) return true;
    return false;
  }
  if (Number.isFinite(startDeadline)) return true; // before deadline
  const expiresAt = Date.parse(String(scan.expiresAt || ''));
  if (Number.isFinite(expiresAt)) return now < expiresAt;
  // No deadline at all: treat as a live reservation (fail safe, occupied).
  return true;
}

/**
 * Number of occupied scan records on one row, iterating the collection so a
 * reservation without a chat is counted too.
 *
 * @param {object | null | undefined} row
 * @param {number} now
 * @param {string} [instanceId] current server instance id
 * @returns {number}
 */
export function countOccupiedScoutScans(row, now, instanceId) {
  let count = 0;
  for (const scan of getActiveScoutScans(row)) {
    if (isScoutScanOccupied(scan, now, instanceId)) count += 1;
  }
  return count;
}

/**
 * Occupancy of one row: scan slots plus the review delegations that hang off a
 * live scan chat. Reviews are optional (`deps`) so pure callers (unit tests,
 * the runtime status without a delegation store) can skip them.
 *
 * @param {{
 *   row?: object,
 *   now?: number,
 *   instanceId?: string,
 *   deps?: {
 *     listDelegationsForParent?: (parentChatId: string) => object[],
 *     isDelegationSlotOccupied?: (row: object, nowMs: number) => boolean,
 *   },
 * }} [input]
 * @returns {{ scans: number, review: number, total: number }}
 */
export function countScoutOccupancy(input = {}) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const instanceId = String(input.instanceId || '').trim() || undefined;
  const scans = countOccupiedScoutScans(input.row, now, instanceId);
  const deps = input.deps && typeof input.deps === 'object' ? input.deps : {};
  const listChildren = typeof deps.listDelegationsForParent === 'function'
    ? deps.listDelegationsForParent
    : defaultListDelegationsForParent;
  const occupied = typeof deps.isDelegationSlotOccupied === 'function'
    ? deps.isDelegationSlotOccupied
    : isDelegationSlotOccupied;
  let review = 0;
  if (listChildren) {
    for (const scan of getActiveScoutScans(input.row)) {
      if (!isScoutScanOccupied(scan, now, instanceId) || !scan.chatId) continue;
      try {
        const children = listChildren(scan.chatId) || [];
        if (Array.isArray(children) && children.some((child) => occupied(child, now))) review += 1;
      } catch {
        // A delegation-store failure must never invent or free a slot.
      }
    }
  }
  return { scans, review, total: scans + review };
}
