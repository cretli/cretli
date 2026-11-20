/**
 * Light registry of `processLifecycle` hooks.
 *
 * Core harnesses own no long-lived OS processes, so the registry starts empty: a
 * repo plugin that does (`harnesses/<id>/`, manifest entry `lifecycle`) adds its
 * hook at boot. The provider descriptors (builtin-harness-providers.js) expose the
 * same hook objects, but that module pulls in every harness chat handler. Callers
 * that only need process state (the memory monitor, a CLI) read it from here so
 * they do not import the chat runtime.
 */

import type { HarnessProcessLifecycle } from './harness-plugin-contract.ts';

const PROCESS_LIFECYCLES: HarnessProcessLifecycle[] = [];

/**
 * Add a plugin's hook. A second hook for the same id is refused.
 *
 * @returns true when added, false for a duplicate id.
 */
export function registerProcessLifecycle(lifecycle: HarnessProcessLifecycle): boolean {
  if (!lifecycle || typeof lifecycle.id !== 'string' || PROCESS_LIFECYCLES.some((row) => row.id === lifecycle.id)) return false;
  PROCESS_LIFECYCLES.push(lifecycle);
  return true;
}

/**
 * @returns Fresh array, registration order.
 */
export function listBuiltinProcessLifecycles(): HarnessProcessLifecycle[] {
  return PROCESS_LIFECYCLES.slice();
}

export function getProcessLifecycle(id: string): HarnessProcessLifecycle | null {
  return PROCESS_LIFECYCLES.find((row) => row.id === id) || null;
}
