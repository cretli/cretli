import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Deliberately separate from runtime-paths.js: importing that module resolves (and caches) the data
// directory, which modules such as lib/storage must not do as an import side effect.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {NodeJS.ProcessEnv} env */
function isTestProcess(env) {
  return Boolean(env.NODE_TEST_CONTEXT) || env.CRETLI_TEST === '1';
}

/**
 * Hard write block: a test process (`node --test` or CRETLI_TEST=1) must never
 * write inside the real project data directory (`<repo>/data`). Tests redirect
 * the data dir with `tests/helpers/isolated-data-dir.js`; a write that still
 * lands in the real directory means a test is missing that isolation.
 *
 * `projectRoot` and `env` are injectable so tests can fake a "real" root.
 *
 * @param {string} targetPath file or directory about to be written
 * @param {{ projectRoot?: string, env?: NodeJS.ProcessEnv }} [options]
 */
export function assertDataWriteAllowed(targetPath, options = {}) {
  const env = options.env || process.env;
  if (!isTestProcess(env)) return;
  const realData = path.resolve(options.projectRoot || PROJECT_ROOT, 'data');
  const rel = path.relative(realData, path.resolve(String(targetPath)));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    const err = new Error(
      `Refusing to use ${path.basename(String(targetPath))} in the real data dir from a test process; ` +
        `load tests/helpers/isolated-data-dir.js first in the test`,
    );
    /** @type {any} */ (err).code = 'CRETLI_TEST_REAL_DATA_WRITE';
    throw err;
  }
}
