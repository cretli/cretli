/**
 * "Block new starts" helper over the durable runtime start gate
 * (workspace-watcher-runtime-control.js). The gate is already honoured by the
 * cycle and Scout launch guards, so blocking here is enough to drain work.
 *
 * The block is OWNED: a marker file records that post-integrate set it, so it
 * can be released after a restart (the restart script kills the process that
 * would otherwise unblock) without clobbering an operator's manual block.
 * Boot code must call releasePostIntegrateBlockIfOwned() once at startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataPath } from './runtime-paths.js';
import { writeJsonAtomic } from './persist/atomic-write.js';
import {
  getWorkspaceWatcherRuntimeControl,
  getWorkspaceWatcherRuntimeStatus,
  setWorkspaceWatcherStartsEnabled,
} from './workspace-watcher-runtime-control.js';

export const POST_INTEGRATE_OWNER = 'post-integrate';

function markerFile(dataDir) {
  return path.join(String(dataDir || '').trim() || resolveDataPath(), 'workspace-watcher-runtime-owner.json');
}

function readMarker(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(markerFile(dataDir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Block new starts. An already-blocked gate (operator or damaged control file)
 * is left alone and no ownership marker is written. If the marker cannot be
 * written the gate is reopened (when still ours) and the error is rethrown.
 * @param {{ dataDir?: string }} [input]
 * @returns {{ owned: boolean }}
 */
export function blockNewStarts(input = {}) {
  const control = getWorkspaceWatcherRuntimeControl({ dataDir: input.dataDir });
  if (control.controlError || !control.startsEnabled) return { owned: false };
  // Synchronous section (no await): gate first (carrying a random nonce), then a
  // marker with the same nonce. Any operator write replaces the gate record
  // without the nonce (even within the same millisecond), so the marker no longer
  // matches and boot leaves that block alone.
  const nonce = randomUUID();
  const row = setWorkspaceWatcherStartsEnabled({ dataDir: input.dataDir, startsEnabled: false, ownerNonce: nonce });
  try {
    writeJsonAtomic(markerFile(input.dataDir), {
      ownedBy: POST_INTEGRATE_OWNER, nonce, since: row.updatedAt,
    }, 'utf8');
  } catch (error) {
    // Without a marker nothing could ever release the gate: reopen it, but only
    // if it is still our record (an operator write in between stays untouched).
    try {
      const control = getWorkspaceWatcherRuntimeControl({ dataDir: input.dataDir });
      if (!control.controlError && !control.startsEnabled && control.ownerNonce === nonce) {
        setWorkspaceWatcherStartsEnabled({ dataDir: input.dataDir, startsEnabled: true });
      }
    } catch { /* best effort; the original error is what matters */ }
    throw error;
  }
  return { owned: true };
}

/**
 * Re-enable starts only when post-integrate owns the block, then clear the marker.
 * @param {{ dataDir?: string }} [input]
 * @returns {{ released: boolean }}
 */
export function releasePostIntegrateBlockIfOwned(input = {}) {
  const marker = readMarker(input.dataDir);
  if (marker?.ownedBy !== POST_INTEGRATE_OWNER) return { released: false };
  const control = getWorkspaceWatcherRuntimeControl({ dataDir: input.dataDir });
  // Release only the gate record we created (nonce match). A damaged file, an
  // already open gate or any later operator write is never touched.
  const ours = !control.controlError && !control.startsEnabled
    && typeof marker.nonce === 'string' && marker.nonce !== '' && marker.nonce === control.ownerNonce;
  if (ours) setWorkspaceWatcherStartsEnabled({ dataDir: input.dataDir, startsEnabled: true });
  fs.rmSync(markerFile(input.dataDir), { force: true });
  return { released: ours };
}

/** Alias used by the integrator: unblock == release if owned. */
export function unblockNewStarts(input = {}) {
  return releasePostIntegrateBlockIfOwned(input);
}

/**
 * Number of live watcher cycles. `unavailable` means the store could not be
 * read, so the caller must not treat 0 as "idle".
 * @param {{ dataDir?: string }} [input]
 */
export function getActiveCycleCount(input = {}) {
  const status = getWorkspaceWatcherRuntimeStatus({ dataDir: input.dataDir });
  return { count: status.activeWatcherCycles, unavailable: status.statusUnavailable };
}
