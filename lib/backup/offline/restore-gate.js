/**
 * Cheap, read-only access to the control directory for long-lived server work.
 * A missing state file is deliberately the legacy state: no restore has ever
 * assigned a generation and existing callers continue unchanged.
 */
import { checkDatasetGeneration, isRestorePaused, readControlState } from './control-dir.js';

/**
 * @param {string} controlDir
 * @returns {{ isRestorePaused: () => boolean, checkRestoreGeneration: (generation?: unknown) => any, snapshot: () => Record<string, any> }}
 */
export function createRestoreGate(controlDir) {
  let pauseLogged = false;
  return Object.freeze({
    isRestorePaused: () => isRestorePaused(controlDir),
    shouldSkipAutomaticWork: (logger = console.warn) => {
      const paused = isRestorePaused(controlDir);
      if (paused && !pauseLogged) {
        pauseLogged = true;
        logger('Cretli: automatic work is paused after offline restore.');
      }
      if (!paused) pauseLogged = false;
      return paused;
    },
    checkRestoreGeneration: (generation) => checkDatasetGeneration(controlDir, generation),
    snapshot: () => {
      const state = readControlState(controlDir);
      return { paused: state.paused, restoreGeneration: state.datasetGeneration, fence: state.fence };
    },
  });
}

/** @param {{ checkRestoreGeneration?: (generation?: unknown) => any } | null | undefined} gate @param {unknown} generation */
export function checkExternalRestoreGeneration(gate, generation) {
  const result = gate?.checkRestoreGeneration?.(generation);
  if (!result || result.ok) return null;
  return {
    status: 409,
    body: { ok: false, code: result.code, error: `History write rejected: ${result.code}.`, restoreGeneration: result.current },
  };
}
