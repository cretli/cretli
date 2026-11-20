/**
 * Worker pool sizing for background job execution.
 *
 * The pool scales with the machine (one slot per core by default) so heavy
 * background work uses the hardware instead of a fixed small cap. Priority
 * classes decide ORDER, never a limit on how many jobs of a class may run.
 */
import os from 'node:os';

export const MAX_POOL_SIZE = 256;

/**
 * @param {{ cores?: number, env?: NodeJS.ProcessEnv }} [options]
 * @returns {number}
 */
export function resolvePoolSize(options = {}) {
  const env = options.env ?? process.env;
  const override = Number.parseInt(String(env.CRETLI_JOB_WORKERS ?? ''), 10);
  if (Number.isInteger(override) && override > 0) return Math.min(override, MAX_POOL_SIZE);
  const cores = options.cores ?? (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
  return Math.min(Math.max(1, Math.floor(cores) || 1), MAX_POOL_SIZE);
}
