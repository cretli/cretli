/**
 * Test-only fake harness transport.
 *
 * Core tests (delegations, watcher, recovery) need *a* valid transport id but
 * must not depend on a concrete harness such as opencode or deepseek. Importing
 * this module registers `testfake` as an accepted transport id for the current
 * test process and installs a mock chat-run adapter for it. Nothing under lib/
 * imports this file, and `testfake` is never part of `VALID_TRANSPORTS`, so it
 * cannot leak into production composition roots, Settings or catalogs.
 *
 * `testfake` mirrors the static policy tables of one built-in harness through
 * `profileOf` (capabilities, review traits, session-id field), so tests keep
 * their original assertions without naming that harness.
 */

import { registerTestAgentTransport } from '../../lib/agent-transport.js';
import { registerMockChatRunAdapter } from '../../lib/chat-run/mock-adapter.ts';

/** Transport id of the fake harness. */
export const FAKE_TRANSPORT = 'testfake';

/** Second fake transport, for tests that need two distinct harnesses. */
export const FAKE_TRANSPORT_B = 'testfakeb';

/** Model id used by tests as an arbitrary model of the fake transport. */
export const FAKE_MODEL = 'testfake/test';

registerTestAgentTransport(FAKE_TRANSPORT, { profileOf: 'opencode' });
registerTestAgentTransport(FAKE_TRANSPORT_B, { profileOf: 'deepseek' });

/**
 * (Re-)register the mock chat-run adapter for the fake transport. Call it
 * after `resetMockChatRuns()` when a test resets the mock adapter state.
 *
 * @returns {void}
 */
export function registerFakeTransportAdapter() {
  registerMockChatRunAdapter(FAKE_TRANSPORT);
  registerMockChatRunAdapter(FAKE_TRANSPORT_B);
}
