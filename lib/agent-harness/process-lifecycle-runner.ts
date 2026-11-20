/**
 * Core-side driver for provider `processLifecycle` hooks
 * (HarnessProcessLifecycle in harness-plugin-contract.js).
 *
 * server.js owns the call order (boot sweep, shutdown phase 1 before the child
 * registry, phase 2 after it); this module owns the per-provider mechanics so
 * the loop is unit-testable with a fake provider and every failure stays
 * isolated to the provider that raised it.
 */

import type { HarnessProcessLifecycle } from './harness-plugin-contract.ts';

export interface LifecycleProvider {
  processLifecycle: HarnessProcessLifecycle;
}

/**
 * Boot step for every provider, in order. A failing hook is logged and skipped.
 */
export async function startProcessLifecycles(
  providers: LifecycleProvider[],
  io: { log?: (line: string) => void, warn?: (line: string, detail: string) => void } = {},
): Promise<void> {
  const log = io.log || console.log;
  const warn = io.warn || console.warn;
  for (const { processLifecycle } of providers) {
    try {
      const started = await processLifecycle.start?.();
      if (started?.summary) log(`[cretli] ${processLifecycle.label} startup sweep: ${started.summary}`);
    } catch (err) {
      warn(`[cretli] ${processLifecycle.label} startup sweep failed:`, String((err as Error | undefined)?.message || err));
    }
  }
}

/**
 * Synchronous shutdown phase 1 for every provider. Never awaits.
 *
 * @returns Phase-1 summaries keyed by provider id.
 */
export function beginProcessLifecycleStop(
  providers: LifecycleProvider[],
  options: { signal: string, error?: (line: string) => void },
): Map<string, object | null> {
  const error = options.error || console.error;
  const phaseOne: Map<string, object | null> = new Map();
  for (const { processLifecycle } of providers) {
    try {
      phaseOne.set(processLifecycle.id, processLifecycle.beginStop?.() || null);
    } catch (err) {
      error(`[cretli] ${options.signal}: ${processLifecycle.label} phase-1 signal error: ${(err as Error | undefined)?.message || err}`);
    }
  }
  return phaseOne;
}

/**
 * Bounded shutdown phase 2 for every provider, in order; records one
 * `shutdown-<id>` diagnostics event each.
 */
export async function finishProcessLifecycleStop(
  providers: LifecycleProvider[],
  phaseOne: Map<string, object | null>,
  options: {
    signal: string,
    record: (event: string, detail: object) => void,
    error?: (line: string) => void,
  },
): Promise<void> {
  const error = options.error || console.error;
  for (const { processLifecycle } of providers) {
    let result = null;
    try {
      result = processLifecycle.finishStop ? await processLifecycle.finishStop() : null;
    } catch (err) {
      error(`[cretli] ${options.signal}: ${processLifecycle.label} shutdown phase error: ${(err as Error | undefined)?.message || err}`);
    }
    options.record(`shutdown-${processLifecycle.id}`, {
      signal: options.signal,
      ...(phaseOne.get(processLifecycle.id) || {}),
      ...(result || {}),
    });
    if (result && !result.ok) {
      const remaining = Array.isArray(result.remaining) ? result.remaining.length : 0;
      error(`[cretli] ${options.signal}: ${processLifecycle.label} shutdown incomplete; ${remaining} process(es) survived SIGKILL`);
    }
  }
}
