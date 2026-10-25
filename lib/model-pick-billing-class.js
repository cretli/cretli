/**
 * Production billing-class resolver for the model-pick shadow layer and the
 * statistics view (plan v10 §2.5-2.6).
 *
 * USD is only ever allowed for `api_metered` (docs/model-scoring-facts.md §3);
 * every other class keeps the RCU proxy. The resolver is pure and network-free.
 */

import { resolveTelemetryBillingClass } from './model-facts/telemetry.ts';
import { resolveHarnessProvider } from './usage/harness-usage.ts';

/**
 * @param {{ harness?: unknown }} candidate
 * @param {{ provider?: unknown } | null} [identity]
 * @returns {'api_metered' | 'subscription_quota' | 'local' | 'unknown'}
 */
export function billingClassOfCandidate(candidate, identity = null) {
  const harness = String(candidate?.harness || '').trim().toLowerCase();
  const provider = String(identity?.provider || '').trim().toLowerCase()
    || (harness ? resolveHarnessProvider(harness) : '');
  return resolveTelemetryBillingClass({ harness, provider });
}
