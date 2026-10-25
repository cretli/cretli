/**
 * Test helper: load the repo harness plugins that are enabled by default
 * (manifest `defaultEnabled: true`) into the provider, backend and
 * MCP adapter registries, the way server.js does at boot. Import it for its
 * side effect (top-level await) in tests that exercise a harness which lives in
 * `harnesses/<id>/`.
 *
 * Loading the plugins pulls in lib/persist/* modules, which resolve their data
 * paths at import time. The isolated data dir must be set up first, otherwise a
 * test's `saveSettings({})` overwrites the operator's real data/config.json
 * (this wiped it on 2026-10-22).
 */
import './isolated-data-dir.js';
import { loadOptionalHarnessPlugins } from '../../lib/agent-harness/optional-harness-plugins.ts';

delete process.env.CRETLI_OPTIONAL_HARNESSES;

export const defaultOptionalHarnessLoad = await loadOptionalHarnessPlugins();

if (defaultOptionalHarnessLoad.errors.length > 0) {
  throw new Error(`default optional harness plugins failed to load: ${JSON.stringify(defaultOptionalHarnessLoad.errors)}`);
}
