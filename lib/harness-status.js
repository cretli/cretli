import { listBuiltinHarnessBackends } from './agent-harness/builtin-harness-backends.ts';

/**
 * @typedef {import('./agent-harness/builtin-harness-backends.ts').HarnessBackendStatus} HarnessBackendStatus
 * @typedef {Record<import('./agent-transport.js').AgentTransport, HarnessBackendStatus> & {
 *   anyConfigured: boolean,
 * }} HarnessStatus
 */

/**
 * Snapshot of which chat backends are installed and have credentials.
 * Used by Settings and the first-run harness wizard (no secrets).
 *
 * @returns {Promise<HarnessStatus>}
 */
export async function getHarnessStatus() {
  /** @type {Record<string, HarnessBackendStatus>} */
  const byHarness = {};
  let anyConfigured = false;
  // Sequential on purpose: the availability probes load optional SDKs.
  for (const backend of listBuiltinHarnessBackends()) {
    const status = await backend.status();
    byHarness[backend.id] = status;
    anyConfigured = anyConfigured || status.configured;
  }
  return /** @type {HarnessStatus} */ ({ ...byHarness, anyConfigured });
}
