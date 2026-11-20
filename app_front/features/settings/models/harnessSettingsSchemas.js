/**
 * Front-end composition root for the per-harness Settings screens
 * (docs/ts-migration-and-core-harnesses-plan.md, B2). Collects each harness's
 * `settingsSchema` (pure data exported next to lib/<id>/<id>-settings.js) and the
 * few DOM behaviours a schema cannot express. The generic renderer
 * (features/settings/harnessSettingsRenderer.js) never names a harness.
 */

import { settingsSchema as openrouterSchema } from '../../../../lib/providers/openrouter/openrouter-settings-schema.ts';

/** @typedef {import('../../../../lib/agent-harness/harness-settings-patch.ts').HarnessSettingsSchema} HarnessSettingsSchema */

/**
 * DOM behaviour of a harness screen that is not plain data.
 *
 * @typedef {Object} HarnessSettingsHooks
 * @property {(data: Record<string, any> | undefined) => void} [afterApply] Runs after a settings snapshot was rendered.
 * @property {(field: string, value: string) => Record<string, string>} [extraSavePayload] Extra PATCH fields sent
 *   with a credential save.
 */

/** @type {HarnessSettingsSchema[]} Core schemas; optional plugin schemas are appended at runtime. */
const SCHEMAS = ([
  openrouterSchema,
]);

/** @type {Set<(schema: HarnessSettingsSchema) => void>} */
const addedListeners = new Set();

/** @type {Record<string, HarnessSettingsHooks>} DOM behaviour registered together with an optional plugin schema. */
const HOOKS = {};

/**
 * @returns {readonly HarnessSettingsSchema[]} Schemas of every non-core harness.
 */
export function listHarnessSettingsSchemas() {
  return [...SCHEMAS];
}

/**
 * @param {string} harness
 * @returns {HarnessSettingsHooks}
 */
export function getHarnessSettingsHooks(harness) {
  return HOOKS[harness] || {};
}

/**
 * Registers the schema of an optional harness plugin the server loaded.
 * Idempotent per harness id.
 *
 * @param {HarnessSettingsSchema} schema
 * @param {HarnessSettingsHooks} [hooks] DOM behaviour of the screen, stored before listeners render it.
 * @returns {boolean} False when the harness already had a schema.
 */
export function registerHarnessSettingsSchema(schema, hooks) {
  if (!schema || SCHEMAS.some((row) => row.harness === schema.harness)) return false;
  SCHEMAS.push(schema);
  if (hooks) HOOKS[schema.harness] = Object.freeze({ ...hooks });
  for (const listener of addedListeners) listener(schema);
  return true;
}

/**
 * @param {(schema: HarnessSettingsSchema) => void} listener Called for every schema registered later.
 * @returns {() => void} Unsubscribe.
 */
export function onHarnessSettingsSchemaAdded(listener) {
  addedListeners.add(listener);
  return () => addedListeners.delete(listener);
}
