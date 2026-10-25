/**
 * Control marker that selects exactly ONE chat-history backend (stage 2a).
 *
 * `history-backend.json` lives in the storage control directory (outside every
 * restore path, next to the coordinator's lease/fence files). A missing marker
 * means `legacy` ONLY if nothing proves a cutover ever happened; an unreadable,
 * unknown or lost one FAILS CLOSED (never "default to legacy": that would let a
 * legacy writer run against a store that already took acknowledged writes).
 * Every transition first writes a separate durable WITNESS
 * (`history-cutover-witness.json`, same directory, never deleted, never
 * rewritten to a lower revision) and only then the marker; a missing marker, or a
 * marker older than the witness, refuses with `history_backend_marker_missing`
 * until an operator repairs it from the witness (`repairHistoryBackendMarker`).
 * The runtime additionally passes the store/pending directories it knows of
 * (`traceDirs`): a store file or pending entries next to a missing marker refuse
 * too, so safety never depends on the witness alone. Nothing reads the marker
 * implicitly or flips it:
 * transitions are explicit calls made by an operator tool that holds the
 * coordinator lease, and the allowed ones are deliberately few:
 *
 *   legacy            -> sqlite              cutover (stage 3), needs `confirmCutover`
 *   sqlite            -> rollback-readonly   emergency rollback, needs a verified export hash
 *   rollback-readonly -> (none)              a WRITABLE legacy backend after new ACKs is not
 *                                            certified (no atomic ledger + fencing), so there is no way back
 *
 * Every write is a compare-and-swap on `revision`, runs inside the coordinator's
 * owned-lease critical section (a stale owner after TTL/takeover is refused) and
 * is an atomic file replace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { replaceOwnFileDurable } from '../storage/history-migration-fs.js';
import { DATASET_GENERATION_PATTERN } from '../storage/command-receipts.js';
import { DEFAULT_STORAGE_DB_FILENAME } from '../storage/db-lifecycle.js';
import { refuseHistory } from './chat-history-errors.js';

export const HISTORY_BACKEND_MARKER_FILE = 'history-backend.json';
export const HISTORY_BACKEND_MARKER_SCHEMA = 'cretli-history-backend-marker-v1';
export const HISTORY_CUTOVER_WITNESS_FILE = 'history-cutover-witness.json';
export const HISTORY_CUTOVER_WITNESS_SCHEMA = 'cretli-history-cutover-witness-v1';
export const HISTORY_BACKENDS = Object.freeze(['legacy', 'sqlite', 'rollback-readonly']);
const ALLOWED_TRANSITIONS = Object.freeze({
  legacy: ['sqlite'],
  sqlite: ['rollback-readonly'],
  'rollback-readonly': [],
});

/**
 * @typedef {{
 *   schema: string, backend: 'legacy' | 'sqlite' | 'rollback-readonly', revision: number,
 *   datasetGeneration: string | null, exportManifestHash: string | null,
 *   selectedAt: string, selectedBy: string, fenceEpoch: number | null, previous: string | null, source: 'default' | 'file',
 * }} HistoryBackendMarker
 */

/** @param {string} controlDir @returns {string} */
function markerPath(controlDir) {
  if (typeof controlDir !== 'string' || !path.isAbsolute(controlDir)) throw new TypeError('controlDir must be an absolute path');
  return path.join(controlDir, HISTORY_BACKEND_MARKER_FILE);
}

/** @param {string} controlDir @returns {string} */
function witnessPath(controlDir) {
  return path.join(path.resolve(controlDir), HISTORY_CUTOVER_WITNESS_FILE);
}

/**
 * @typedef {{
 *   schema: string, backend: 'sqlite' | 'rollback-readonly', revision: number, datasetGeneration: string,
 *   exportManifestHash: string | null, selectedAt: string, selectedBy: string, fenceEpoch: number | null,
 * }} CutoverWitness
 */

/**
 * Read the durable cutover witness. `null` = no cutover was ever recorded.
 *
 * @param {string} controlDir
 * @returns {CutoverWitness | null}
 * @throws {ChatHistoryAdapterError} `history_backend_marker_invalid` for an unreadable or inconsistent witness
 */
export function readCutoverWitness(controlDir) {
  let text;
  try {
    text = fs.readFileSync(witnessPath(controlDir), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    return refuseHistory('history_backend_marker_invalid', 'The cutover witness cannot be read');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return refuseHistory('history_backend_marker_invalid', 'The cutover witness is not valid JSON');
  }
  if (!value || value.schema !== HISTORY_CUTOVER_WITNESS_SCHEMA || !['sqlite', 'rollback-readonly'].includes(value.backend)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.datasetGeneration !== 'string'
    || !DATASET_GENERATION_PATTERN.test(value.datasetGeneration)
    || (value.backend === 'rollback-readonly' && typeof value.exportManifestHash !== 'string')) {
    return refuseHistory('history_backend_marker_invalid', 'The cutover witness is inconsistent');
  }
  return {
    schema: value.schema, backend: value.backend, revision: value.revision, datasetGeneration: value.datasetGeneration,
    exportManifestHash: value.exportManifestHash ?? null, selectedAt: String(value.selectedAt ?? ''), selectedBy: String(value.selectedBy ?? ''),
    fenceEpoch: Number.isSafeInteger(value.fenceEpoch) ? value.fenceEpoch : null,
  };
}

/**
 * Traces of an earlier sqlite cutover next to the stores themselves. Used only
 * when the marker is missing; independent of the witness.
 *
 * @param {Record<string, any>} dirs
 * @returns {string | null} what was found
 */
function findCutoverTrace(dirs) {
  const nonEmptyDir = (dir) => {
    try {
      return fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  };
  if (typeof dirs.dbDir === 'string') {
    try {
      if (fs.statSync(path.join(dirs.dbDir, DEFAULT_STORAGE_DB_FILENAME)).size > 0) return 'store_file';
    } catch { /* absent */ }
  }
  if (typeof dirs.pendingDir === 'string') {
    for (const sub of ['entries', 'producers', 'quarantine']) {
      if (nonEmptyDir(path.join(dirs.pendingDir, sub))) return 'pending_buffer';
    }
  }
  return null;
}

/**
 * Read the selection. A missing file is `legacy` at revision 0 ONLY when no
 * cutover witness exists and `traceDirs` (the store/pending directories the
 * caller knows of) show no sqlite footprint; otherwise it refuses.
 *
 * @param {string} controlDir
 * @param {{ traceDirs?: { dbDir?: string, pendingDir?: string } }} [options]
 * @returns {HistoryBackendMarker}
 * @throws {ChatHistoryAdapterError} `history_backend_marker_invalid` for anything unreadable or inconsistent,
 *   `history_backend_marker_missing` for a lost or stale marker after a cutover
 */
export function readHistoryBackendMarker(controlDir, options = {}) {
  const file = markerPath(controlDir);
  const witness = readCutoverWitness(controlDir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (witness) {
        return refuseHistory('history_backend_marker_missing', 'The backend marker is missing but a cutover was recorded; repair it from the witness', { witnessed: witness.backend, revision: witness.revision });
      }
      const trace = findCutoverTrace(options.traceDirs ?? {});
      if (trace) {
        return refuseHistory('history_backend_marker_missing', 'The backend marker is missing but the sqlite store left a footprint; legacy writers stay blocked', { trace });
      }
      return { schema: HISTORY_BACKEND_MARKER_SCHEMA, backend: 'legacy', revision: 0, datasetGeneration: null, exportManifestHash: null,
        selectedAt: '', selectedBy: 'default', fenceEpoch: null, previous: null, source: 'default' };
    }
    return refuseHistory('history_backend_marker_invalid', 'The history backend marker cannot be read');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return refuseHistory('history_backend_marker_invalid', 'The history backend marker is not valid JSON');
  }
  if (!value || value.schema !== HISTORY_BACKEND_MARKER_SCHEMA || !HISTORY_BACKENDS.includes(value.backend)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || (value.backend !== 'legacy' && (typeof value.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(value.datasetGeneration)))
    || (value.backend === 'rollback-readonly' && typeof value.exportManifestHash !== 'string')) {
    return refuseHistory('history_backend_marker_invalid', 'The history backend marker is inconsistent');
  }
  if (witness && witness.revision > value.revision) {
    return refuseHistory('history_backend_marker_missing', 'The backend marker is older than the recorded cutover; repair it from the witness', { witnessed: witness.backend, revision: witness.revision, markerRevision: value.revision });
  }
  return {
    schema: value.schema, backend: value.backend, revision: value.revision,
    datasetGeneration: value.datasetGeneration ?? null, exportManifestHash: value.exportManifestHash ?? null,
    selectedAt: String(value.selectedAt ?? ''), selectedBy: String(value.selectedBy ?? ''),
    fenceEpoch: Number.isSafeInteger(value.fenceEpoch) ? value.fenceEpoch : null, previous: value.previous ?? null, source: 'file',
  };
}

/**
 * Explicitly select the next backend. This is an operator action: it needs the
 * coordinator (an owner whose lease is live), a `confirm*` flag naming the
 * transition and the revision the caller read.
 *
 * @param {{
 *   controlDir: string,
 *   coordinator: { state: string, epoch: number, withOwnedLease: Function },
 *   backend: 'sqlite' | 'rollback-readonly',
 *   expectedRevision: number,
 *   selectedBy: string,
 *   datasetGeneration: string,
 *   confirmCutover?: boolean,
 *   confirmRollback?: boolean,
 *   exportManifestHash?: string,
 *   traceDirs?: { dbDir?: string, pendingDir?: string },
 *   now?: () => number,
 * }} options
 * @returns {HistoryBackendMarker}
 */
export function selectHistoryBackend(options) {
  const { controlDir, coordinator, backend } = options;
  if (!coordinator || typeof coordinator.acquire !== 'function' || typeof coordinator.withOwnedLease !== 'function') throw new TypeError('selectHistoryBackend needs the coordinator');
  // The operator tool holds the lease but need not have a store host to activate yet (cutover happens before the first start).
  if (coordinator.state !== 'owner') refuseHistory('history_backend_transition_refused', 'The marker can only be changed by the live coordinator owner', { state: String(coordinator.state) });
  if (!HISTORY_BACKENDS.includes(backend)) refuseHistory('history_backend_transition_refused', `Unknown backend ${String(backend)}`);
  if (backend === 'sqlite' && options.confirmCutover !== true) refuseHistory('history_backend_transition_refused', 'Selecting sqlite needs confirmCutover: true');
  if (backend === 'rollback-readonly' && (options.confirmRollback !== true || typeof options.exportManifestHash !== 'string' || !options.exportManifestHash)) {
    refuseHistory('history_backend_transition_refused', 'Rollback needs confirmRollback: true and the manifest hash of a verified export');
  }
  if (typeof options.datasetGeneration !== 'string' || !DATASET_GENERATION_PATTERN.test(options.datasetGeneration)) {
    refuseHistory('history_backend_transition_refused', 'A valid datasetGeneration is required');
  }
  // The live-lease check, the CAS read and both durable writes happen under one control lock: a stale owner
  // (TTL expired and taken over) is fenced inside `withOwnedLease` and writes nothing.
  return ownedMarkerWrite(coordinator, 'history_backend_select', (epoch) => {
    const current = readHistoryBackendMarker(controlDir, { traceDirs: options.traceDirs });
    if (current.revision !== options.expectedRevision) {
      refuseHistory('history_backend_transition_refused', 'The marker changed since it was read', { expected: options.expectedRevision, actual: current.revision });
    }
    if (!ALLOWED_TRANSITIONS[current.backend].includes(backend)) {
      refuseHistory('history_backend_transition_refused', `Transition ${current.backend} -> ${backend} is not allowed`, { from: current.backend, to: backend });
    }
    const marker = {
      schema: HISTORY_BACKEND_MARKER_SCHEMA, backend, revision: current.revision + 1, datasetGeneration: options.datasetGeneration,
      exportManifestHash: backend === 'rollback-readonly' ? options.exportManifestHash : null,
      selectedAt: new Date((options.now ?? Date.now)()).toISOString(), selectedBy: String(options.selectedBy || 'operator'),
      fenceEpoch: Number.isSafeInteger(epoch) ? epoch : null, previous: current.backend,
    };
    return writeWitnessThenMarker(controlDir, marker);
  });
}

/**
 * Run `write` in the coordinator's owned-lease critical section and map a lost
 * lease to the typed transition refusal.
 *
 * @template T
 * @param {{ withOwnedLease: Function }} coordinator
 * @param {string} operation
 * @param {(epoch: number) => T} write
 * @returns {T}
 */
function ownedMarkerWrite(coordinator, operation, write) {
  try {
    return coordinator.withOwnedLease(operation, ({ epoch }) => write(epoch));
  } catch (error) {
    if (error?.name === 'ChatHistoryAdapterError') throw error;
    if (error?.code === 'conflict' && ['fenced', 'not_owner'].includes(error?.details?.conflictKind)) {
      return refuseHistory('history_backend_transition_refused', 'The coordinator no longer owns a live lease', { cause: error.details.conflictKind });
    }
    throw error;
  }
}

/**
 * Durable witness first, marker second: the marker can never be ahead of the witness.
 *
 * @param {string} controlDir
 * @param {Record<string, any>} marker
 * @returns {HistoryBackendMarker}
 */
function writeWitnessThenMarker(controlDir, marker) {
  fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const witness = {
    schema: HISTORY_CUTOVER_WITNESS_SCHEMA, backend: marker.backend, revision: marker.revision, datasetGeneration: marker.datasetGeneration,
    exportManifestHash: marker.exportManifestHash, selectedAt: marker.selectedAt, selectedBy: marker.selectedBy, fenceEpoch: marker.fenceEpoch,
  };
  replaceOwnFileDurable(witnessPath(controlDir), `${JSON.stringify(witness, null, 2)}\n`);
  replaceOwnFileDurable(markerPath(controlDir), `${JSON.stringify(marker, null, 2)}\n`);
  return { ...marker, source: 'file' };
}

/**
 * Operator repair after the marker was lost or restored to an older revision:
 * rebuilds it from the cutover witness. It never selects anything new.
 *
 * @param {{ controlDir: string, coordinator: { state: string, withOwnedLease: Function }, selectedBy: string, confirmRepair?: boolean, now?: () => number }} options
 * @returns {HistoryBackendMarker}
 */
export function repairHistoryBackendMarker(options) {
  const { controlDir, coordinator } = options;
  if (!coordinator || typeof coordinator.withOwnedLease !== 'function') throw new TypeError('repairHistoryBackendMarker needs the coordinator');
  if (options.confirmRepair !== true) refuseHistory('history_backend_transition_refused', 'Repair needs confirmRepair: true');
  return ownedMarkerWrite(coordinator, 'history_backend_repair', (epoch) => {
    const witness = readCutoverWitness(controlDir);
    if (!witness) refuseHistory('history_backend_transition_refused', 'There is no cutover witness to repair from');
    let existing = null;
    try {
      existing = readHistoryBackendMarker(controlDir);
    } catch (error) {
      if (error?.code !== 'history_backend_marker_missing') throw error;
    }
    if (existing && existing.revision >= witness.revision) refuseHistory('history_backend_transition_refused', 'The marker is not behind the witness');
    const marker = {
      schema: HISTORY_BACKEND_MARKER_SCHEMA, backend: witness.backend, revision: witness.revision, datasetGeneration: witness.datasetGeneration,
      exportManifestHash: witness.exportManifestHash, selectedAt: witness.selectedAt || new Date((options.now ?? Date.now)()).toISOString(),
      selectedBy: String(options.selectedBy || 'operator'), fenceEpoch: Number.isFinite(epoch) ? epoch : witness.fenceEpoch, previous: 'repair',
    };
    return writeWitnessThenMarker(controlDir, marker);
  });
}

/**
 * Runtime exclusivity: a backend refuses to start unless the marker selects it
 * (and, for sqlite, the same dataset generation).
 *
 * @param {string} controlDir
 * @param {'legacy' | 'sqlite' | 'rollback-readonly'} expected
 * @param {{ datasetGeneration?: string, traceDirs?: { dbDir?: string, pendingDir?: string } }} [options]
 * @returns {HistoryBackendMarker}
 */
export function assertHistoryBackendSelected(controlDir, expected, options = {}) {
  const marker = readHistoryBackendMarker(controlDir, { traceDirs: options.traceDirs });
  if (marker.backend !== expected) {
    refuseHistory('history_backend_mismatch', `The control marker selects ${marker.backend}, not ${expected}`, { selected: marker.backend, requested: expected });
  }
  if (expected !== 'legacy' && options.datasetGeneration !== undefined && marker.datasetGeneration !== options.datasetGeneration) {
    refuseHistory('history_generation_mismatch', 'The control marker selects another dataset generation', { selected: marker.datasetGeneration, requested: options.datasetGeneration });
  }
  return marker;
}
