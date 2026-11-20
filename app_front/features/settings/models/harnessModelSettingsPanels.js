/**
 * Front-end composition root for the per-harness model Settings panels
 * (docs/ts-migration-and-core-harnesses-plan.md, B2). App.js iterates this list
 * instead of importing each harness panel by name. The Cursor SDK panel
 * (`modelSettings.js`) is core and stays wired in App.js.
 */

import { OPTIONAL_HARNESS_LOADERS } from './optionalHarnessPanels.js';
import { registerHarnessSettingsSchema } from './harnessSettingsSchemas.js';
import { registerHarnessEnabledModelsNormalizer } from '../../../core/harness/harnessUiRegistry.js';
import { getSettings } from '../../../core/api/index.js';
import { initClaudeModelSettings, refreshClaudeModelSettingsPanel } from './claudeModelSettings.js';
import { initCodexModelSettings, refreshCodexModelSettingsPanel } from './codexModelSettings.js';

/**
 * @typedef {Object} HarnessModelSettingsPanel
 * @property {string} harness Transport id; the panel lives under `harness-<id>-models`.
 * @property {() => void} init Binds the panel once, when Settings first opens.
 * @property {() => void} refresh Re-renders the panel when its tab is shown.
 */

/**
 * Order is the previous init/refresh order in App.js.
 *
 * Not frozen: optional harness plugins append their panel at runtime through
 * {@link syncOptionalHarnessPanels}; App.js iterates this array at call time.
 *
 * @type {HarnessModelSettingsPanel[]}
 */
export const HARNESS_MODEL_SETTINGS_PANELS = [
  { harness: 'claude', init: initClaudeModelSettings, refresh: refreshClaudeModelSettingsPanel },
  { harness: 'codex', init: initCodexModelSettings, refresh: refreshCodexModelSettingsPanel },
].map((panel) => Object.freeze(panel));

/**
 * Load, register and init the panels (and Settings schemas) of the optional
 * plugins the server loaded. Idempotent; a harness without an entry in the
 * static loader map is ignored. The plugin modules are fetched here, on
 * demand, so a disabled plugin never reaches the browser. The schema is
 * registered before the panel so the Settings screen is wired first.
 *
 * @param {readonly string[]} ids
 * @returns {Promise<string[]>} Ids whose panel was added by this call.
 */
export async function activateOptionalHarnessPanels(ids) {
  const added = [];
  for (const id of ids) {
    const loaders = Object.hasOwn(OPTIONAL_HARNESS_LOADERS, id) ? OPTIONAL_HARNESS_LOADERS[id] : null;
    if (!loaders || HARNESS_MODEL_SETTINGS_PANELS.some((row) => row.harness === id)) continue;
    try {
      const [panel, schemaModule] = await Promise.all([loaders.panel(), loaders.schema?.()]);
      if (schemaModule?.settingsSchema) registerHarnessSettingsSchema(schemaModule.settingsSchema, panel.settingsHooks);
      if (HARNESS_MODEL_SETTINGS_PANELS.some((row) => row.harness === id)) continue;
      if (typeof panel.normalizeEnabledModels === 'function') registerHarnessEnabledModelsNormalizer(id, panel.normalizeEnabledModels);
      HARNESS_MODEL_SETTINGS_PANELS.push(Object.freeze({ harness: id, init: panel.init, refresh: panel.refresh }));
      panel.init();
      added.push(id);
    } catch {
      // A chunk that fails to load leaves the built-in panels untouched.
    }
  }
  return added;
}

/**
 * Ask the server which optional plugins are loaded and activate their panels.
 * Best effort: a failed request leaves the built-in panels untouched.
 *
 * @returns {Promise<string[]>}
 */
export async function syncOptionalHarnessPanels() {
  if (Object.keys(OPTIONAL_HARNESS_LOADERS).length === 0) return [];
  try {
    const settings = await getSettings();
    return await activateOptionalHarnessPanels(Array.isArray(settings?.optionalHarnesses) ? settings.optionalHarnesses : []);
  } catch {
    return [];
  }
}
