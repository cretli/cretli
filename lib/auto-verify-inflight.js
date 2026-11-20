/**
 * Registry of whole auto-verify chains (queue wait + raw run + baseline
 * classification). Standalone on purpose: it must not import
 * delegation-service.js (import cycle with the review gate).
 */

/** @type {Map<string, Set<Promise<unknown>>>} */
const chains = new Map();

function chainKey({ delegationId, projectRoot, materialRevision }) {
  return [delegationId, projectRoot, materialRevision].map((v) => String(v ?? '').trim()).join('\u0000');
}

/**
 * Track a chain promise until it settles.
 *
 * @param {{ delegationId: string, projectRoot: string, materialRevision?: string, promise: Promise<unknown> }} input
 * @returns {void}
 */
export function trackAutoVerifyChain(input) {
  const key = chainKey(input);
  const promise = input.promise;
  let set = chains.get(key);
  if (!set) {
    set = new Set();
    chains.set(key, set);
  }
  set.add(promise);
  const release = () => untrackAutoVerifyChain({ ...input, promise });
  Promise.resolve(promise).then(release, release);
}

/**
 * @param {{ delegationId: string, projectRoot: string, materialRevision?: string, promise: Promise<unknown> }} input
 * @returns {void}
 */
function untrackAutoVerifyChain(input) {
  const key = chainKey(input);
  const set = chains.get(key);
  if (!set) return;
  set.delete(input.promise);
  if (set.size === 0) chains.delete(key);
}

/**
 * @param {{ delegationId: string, projectRoot: string, materialRevision?: string }} input
 * @returns {boolean}
 */
export function isAutoVerifyChainInFlight(input) {
  return (chains.get(chainKey(input))?.size || 0) > 0;
}

/** Test-only: drop every tracked chain. */
export function resetAutoVerifyChainsForTests() {
  chains.clear();
}

/**
 * Number of tracked auto-verify chains (queue wait + run + classification), for
 * the job-queue metrics export.
 *
 * @returns {number}
 */
export function countAutoVerifyChainsInFlight() {
  let total = 0;
  for (const set of chains.values()) total += set.size;
  return total;
}
