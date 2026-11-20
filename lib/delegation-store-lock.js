/**
 * Serialize JSON persist work for delegations.
 * The store is a single-writer file; overlapping ticks or flush from
 * boot/bridge/runtime must not rewrite stale snapshots.
 */

/** @type {Promise<unknown>} */
let chain = Promise.resolve();
let inFlight = 0;

/**
 * @returns {boolean}
 */
export function isDelegationStoreWorkBusy() {
  return inFlight > 0;
}

/**
 * Run `work` after previous store jobs. Failures do not skip later jobs.
 *
 * @param {() => (Promise<T> | T)} work
 * @returns {Promise<T>}
 * @template T
 */
export function enqueueDelegationStoreWork(work) {
  const run = chain.then(async () => {
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
    }
  }, async () => {
    inFlight += 1;
    try {
      return await work();
    } finally {
      inFlight -= 1;
    }
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}
