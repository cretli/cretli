/**
 * Static loader map of the front-end modules shipped by optional harness
 * plugins (`harnesses/<id>/`). Each entry uses a dynamic `import()` so webpack
 * emits a separate chunk per plugin at build time (nothing is read from the
 * file system at runtime) and the browser fetches it only for ids the server
 * reports as loaded (`optionalHarnesses` in GET /api/settings). Never add a
 * static `import ... from '../../../../harnesses/...'` here or in any other front file.
 * Add one entry per plugin (mistral is the pilot). A panel module may also export
 * `settingsHooks` (DOM behaviour a schema cannot express, registered with the schema):
 *
 *   { mistral: { panel: () => import('../../../../harnesses/mistral/front.js'),
 *                schema: () => import('../../../../harnesses/mistral/mistral-settings-schema.js') } }
 *
 * i18n packs (`mistral.en.js` / `mistral.pl.js`) are plain strings and stay in
 * the static i18n bundle.
 */

/**
 * @typedef {Object} OptionalHarnessPanel
 * @property {() => void} init
 * @property {() => void} refresh
 * @property {Record<string, Function>} [settingsHooks] DOM behaviour registered with the schema.
 * @property {(keys: unknown) => string[]} [normalizeEnabledModels] Favorite-id normalizer for the harness.
 */

/**
 * @typedef {Object} OptionalHarnessLoaders
 * @property {() => Promise<OptionalHarnessPanel>} panel Resolves to a module exporting `init` and `refresh`.
 * @property {() => Promise<{ settingsSchema: import('../../../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema }>} [schema]
 */

/** @type {Readonly<Record<string, OptionalHarnessLoaders>>} */
export const OPTIONAL_HARNESS_LOADERS = Object.freeze({
  openrouter: {
    // No `schema`: the OpenRouter key row is core (harnessSettingsSchemas.js).
    panel: () => import('../../../../harnesses/openrouter/front.js'),
  },
  deepseek: {
    panel: () => import('../../../../harnesses/deepseek/front.js'),
    schema: () => import('../../../../harnesses/deepseek/deepseek-settings-schema.js'),
  },
  codebuddy: {
    panel: () => import('../../../../harnesses/codebuddy/front.js'),
    schema: () => import('../../../../harnesses/codebuddy/codebuddy-settings-schema.js'),
  },
  mistral: {
    panel: () => import('../../../../harnesses/mistral/front.js'),
    schema: () => import('../../../../harnesses/mistral/mistral-settings-schema.js'),
  },
  qwen: {
    panel: () => import('../../../../harnesses/qwen/front.js'),
    schema: () => import('../../../../harnesses/qwen/qwen-settings-schema.js'),
  },
  opencode: {
    panel: () => import('../../../../harnesses/opencode/front.js'),
    schema: () => import('../../../../harnesses/opencode/opencode-settings-schema.js'),
  },
  zai: {
    panel: () => import('../../../../harnesses/zai/front.js'),
    schema: () => import('../../../../harnesses/zai/zai-settings-schema.js'),
  },
  mimo: {
    panel: () => import('../../../../harnesses/mimo/front.js'),
    schema: () => import('../../../../harnesses/mimo/mimo-settings-schema.js'),
  },
});
