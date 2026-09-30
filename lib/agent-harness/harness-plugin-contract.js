/**
 * Pure, versioned harness plugin manifest / provider contract.
 *
 * This module is intentionally side-effect free: it performs no filesystem,
 * network, settings, or transport access. It only describes and validates the
 * shape of a harness plugin manifest and the shared provider/status metadata.
 * Loading plugins is a later iteration and deliberately out of scope here.
 *
 * Contract summary (apiVersion 1):
 *   {
 *     apiVersion: 1,                 // integer, must equal HARNESS_PLUGIN_API_VERSION
 *     id: 'my-harness',              // stable lowercase id, never a built-in transport
 *     version: '1.0.0',              // semver string
 *     hostMin: '0.4.0',              // semver string, minimum Cretli host version
 *     label: 'My Harness',           // non-empty string
 *     description: 'What it does',   // non-empty string
 *     origin: 'local',               // 'builtin' | 'local'
 *     entry: './index.js',           // safe relative path; required for local only
 *     capabilities: { chat: true },  // closed boolean set; missing keys default false
 *     models: [{ id: 'model-id', label: 'Model label' }], // optional static catalog
 *   }
 */

import { AGENT_TRANSPORTS } from '../agent-transport.js';

/** Manifest schema version this host understands. */
export const HARNESS_PLUGIN_API_VERSION = 1;

/** Supported plugin origins. */
export const HARNESS_PLUGIN_ORIGINS = Object.freeze(['builtin', 'local']);

/**
 * Closed capability set. Every manifest gets all of these keys; anything not
 * declared is `false`. A plugin must not claim a capability it does not support.
 */
export const HARNESS_PLUGIN_CAPABILITY_KEYS = Object.freeze([
  'chat',
  'models',
  'status',
  'settings',
  'mcp',
  'delegation',
  'serverRun',
]);

/** Current built-in transports; their ids are reserved and cannot be plugins. */
export const HARNESS_BUILTIN_IDS = Object.freeze([...AGENT_TRANSPORTS]);

/**
 * Additional ids reserved for legacy aliases so a plugin cannot shadow them
 * (`cursor` normalizes to the built-in `sdk` transport).
 */
export const HARNESS_RESERVED_IDS = Object.freeze([...AGENT_TRANSPORTS, 'cursor']);

/** Stable lowercase id: starts with a letter, hyphen-separated alphanumerics. */
export const HARNESS_PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Minimal semver string (`1.2.3`, optional pre-release/build). */
export const HARNESS_PLUGIN_SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Safe relative entry path: forward slashes only, no scheme, no leading slash,
 * no backslash, no null byte, no `..` segment.
 */
export const HARNESS_PLUGIN_ENTRY_PATTERN =
  /^(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*\\)(?!.*\0)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

const MANIFEST_KEYS = Object.freeze([
  'apiVersion',
  'id',
  'version',
  'hostMin',
  'label',
  'description',
  'origin',
  'entry',
  'capabilities',
  'models',
]);

const ID_MIN_LENGTH = 2;
const ID_MAX_LENGTH = 40;
const LABEL_MAX_LENGTH = 64;
const DESCRIPTION_MAX_LENGTH = 280;
const ENTRY_MAX_LENGTH = 256;
const MODEL_ID_MAX_LENGTH = 160;
const MODEL_LABEL_MAX_LENGTH = 160;
const MODELS_MAX_COUNT = 200;

/**
 * @typedef {Object} HarnessPluginCapabilities
 * @property {boolean} chat
 * @property {boolean} models
 * @property {boolean} status
 * @property {boolean} settings
 * @property {boolean} mcp
 * @property {boolean} delegation
 * @property {boolean} serverRun
 */

/**
 * @typedef {Object} HarnessPluginManifest
 * @property {number} apiVersion
 * @property {string} id
 * @property {string} version
 * @property {string} hostMin
 * @property {string} label
 * @property {string} description
 * @property {'builtin' | 'local'} origin
 * @property {string} [entry]
 * @property {Array<{id: string, label?: string}>} [models]
 * @property {HarnessPluginCapabilities} capabilities
 */

/**
 * @typedef {Object} ContractResult
 * @property {boolean} ok
 * @property {string} [code]
 * @property {string} [error]
 * @property {string} [field]
 */

/** @returns {ContractResult} */
function fail(code, error, field = '') {
  return { ok: false, code, error, ...(field ? { field } : {}) };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {string} value @returns {boolean} */
function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isHarnessPluginSemver(value) {
  return typeof value === 'string' && HARNESS_PLUGIN_SEMVER_PATTERN.test(value.trim());
}

/**
 * Safe relative entry path check (no filesystem access).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeHarnessPluginEntry(value) {
  if (typeof value !== 'string') return false;
  const entry = value.trim();
  if (!entry || entry.length > ENTRY_MAX_LENGTH) return false;
  return HARNESS_PLUGIN_ENTRY_PATTERN.test(entry);
}

/**
 * Normalize a capability object into the closed capability set. Missing keys
 * become `false`; unknown keys and non-boolean values throw a coded error.
 *
 * @param {unknown} raw
 * @returns {HarnessPluginCapabilities}
 */
export function normalizeHarnessPluginCapabilities(raw) {
  if (raw === undefined) {
    return Object.freeze(Object.fromEntries(HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, false])));
  }
  if (!isPlainObject(raw)) {
    const err = new Error('capabilities must be an object');
    err.code = 'manifest_invalid';
    err.field = 'capabilities';
    throw err;
  }
  for (const key of Object.keys(raw)) {
    if (!HARNESS_PLUGIN_CAPABILITY_KEYS.includes(key)) {
      const err = new Error(`Unknown capability "${key}"`);
      err.code = 'manifest_invalid';
      err.field = `capabilities.${key}`;
      throw err;
    }
    if (typeof raw[key] !== 'boolean') {
      const err = new Error(`Capability "${key}" must be a boolean`);
      err.code = 'manifest_invalid';
      err.field = `capabilities.${key}`;
      throw err;
    }
  }
  return Object.freeze(
    Object.fromEntries(HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, raw[key] === true])),
  );
}

/**
 * Normalize and validate the static model catalog from a plugin manifest.
 * Model identifiers are scoped by their harness in the catalog API; control
 * characters are rejected so values remain safe across logs and clients.
 *
 * @param {unknown} raw
 * @returns {Array<{id: string, label?: string}>}
 */
function normalizeManifestModels(raw) {
  if (!Array.isArray(raw)) {
    const err = new Error('models must be an array');
    err.code = 'manifest_invalid';
    err.field = 'models';
    throw err;
  }
  if (raw.length > MODELS_MAX_COUNT) {
    const err = new Error(`models must contain at most ${MODELS_MAX_COUNT} entries`);
    err.code = 'manifest_invalid';
    err.field = 'models';
    throw err;
  }

  const seen = new Set();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      const err = new Error(`models[${index}] must be an object`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}`;
      throw err;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'id' && key !== 'label') {
        const err = new Error(`Unknown model field "${key}"`);
        err.code = 'manifest_invalid';
        err.field = `models.${index}.${key}`;
        throw err;
      }
    }
    if (typeof item.id !== 'string') {
      const err = new Error(`models[${index}].id must be a string`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}.id`;
      throw err;
    }
    const id = item.id.trim();
    if (!id || id.length > MODEL_ID_MAX_LENGTH || hasControlCharacters(id)) {
      const err = new Error(`models[${index}].id must be non-empty and at most ${MODEL_ID_MAX_LENGTH} safe characters`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}.id`;
      throw err;
    }
    if (seen.has(id)) {
      const err = new Error(`Duplicate model id "${id}"`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}.id`;
      throw err;
    }
    seen.add(id);

    if (item.label === undefined) return Object.freeze({ id });
    if (typeof item.label !== 'string') {
      const err = new Error(`models[${index}].label must be a string`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}.label`;
      throw err;
    }
    const label = item.label.trim();
    if (!label || label.length > MODEL_LABEL_MAX_LENGTH || hasControlCharacters(label)) {
      const err = new Error(`models[${index}].label must be non-empty and at most ${MODEL_LABEL_MAX_LENGTH} safe characters`);
      err.code = 'manifest_invalid';
      err.field = `models.${index}.label`;
      throw err;
    }
    return Object.freeze({ id, label });
  });
}

/**
 * Validate a single harness plugin manifest.
 *
 * @param {unknown} raw
 * @param {{ reservedIds?: readonly string[] }} [options]
 * @returns {{ ok: true, manifest: HarnessPluginManifest } | (ContractResult & { ok: false })}
 */
export function validateHarnessPluginManifest(raw, options = {}) {
  const reservedIds = new Set(
    Array.isArray(options.reservedIds) ? options.reservedIds : HARNESS_RESERVED_IDS,
  );
  if (!isPlainObject(raw)) {
    return fail('manifest_invalid', 'Harness plugin manifest must be an object');
  }

  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.includes(key)) {
      return fail('manifest_invalid', `Unknown manifest field "${key}"`, key);
    }
  }

  if (raw.apiVersion !== HARNESS_PLUGIN_API_VERSION) {
    return fail(
      'manifest_invalid',
      `Unsupported apiVersion ${JSON.stringify(raw.apiVersion)}; expected ${HARNESS_PLUGIN_API_VERSION}`,
      'apiVersion',
    );
  }

  if (typeof raw.id !== 'string') {
    return fail('manifest_invalid', 'id must be a string', 'id');
  }
  const id = raw.id.trim();
  if (id.length < ID_MIN_LENGTH || id.length > ID_MAX_LENGTH) {
    return fail(
      'manifest_invalid',
      `id must be ${ID_MIN_LENGTH}-${ID_MAX_LENGTH} characters`,
      'id',
    );
  }
  if (!HARNESS_PLUGIN_ID_PATTERN.test(id)) {
    return fail(
      'manifest_invalid',
      'id must be lowercase, start with a letter, and use only letters, digits, and single hyphens',
      'id',
    );
  }
  if (reservedIds.has(id)) {
    return fail('id_reserved', `Harness id "${id}" is reserved by a built-in transport`, 'id');
  }

  for (const field of ['version', 'hostMin']) {
    if (typeof raw[field] !== 'string' || !isHarnessPluginSemver(raw[field])) {
      return fail(
        'manifest_invalid',
        `${field} must be a semver string like "1.2.3"`,
        field,
      );
    }
  }

  for (const field of ['label', 'description']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      return fail('manifest_invalid', `${field} must be a non-empty string`, field);
    }
    const max = field === 'label' ? LABEL_MAX_LENGTH : DESCRIPTION_MAX_LENGTH;
    if (raw[field].trim().length > max) {
      return fail('manifest_invalid', `${field} must be at most ${max} characters`, field);
    }
  }

  if (raw.origin !== 'builtin' && raw.origin !== 'local') {
    return fail(
      'manifest_invalid',
      `origin must be one of: ${HARNESS_PLUGIN_ORIGINS.join(', ')}`,
      'origin',
    );
  }

  const hasEntry = raw.entry !== undefined && raw.entry !== null && raw.entry !== '';
  if (raw.origin === 'local') {
    if (!isSafeHarnessPluginEntry(raw.entry)) {
      return fail(
        'manifest_invalid',
        'local plugins require a safe relative entry path (no absolute path, no "..", no backslash)',
        'entry',
      );
    }
  } else if (hasEntry) {
    return fail('manifest_invalid', 'builtin plugins must not declare an entry path', 'entry');
  }

  let capabilities;
  try {
    capabilities = normalizeHarnessPluginCapabilities(raw.capabilities);
  } catch (err) {
    return fail(err.code || 'manifest_invalid', err.message, err.field || 'capabilities');
  }

  let models;
  if (raw.models !== undefined) {
    if (capabilities.models !== true) {
      return fail('manifest_invalid', 'models requires capabilities.models to be true', 'models');
    }
    try {
      models = normalizeManifestModels(raw.models);
    } catch (err) {
      return fail(err.code || 'manifest_invalid', err.message, err.field || 'models');
    }
  }

  /** @type {HarnessPluginManifest} */
  const manifest = {
    apiVersion: HARNESS_PLUGIN_API_VERSION,
    id,
    version: raw.version.trim(),
    hostMin: raw.hostMin.trim(),
    label: raw.label.trim(),
    description: raw.description.trim(),
    origin: raw.origin,
    ...(raw.origin === 'local' ? { entry: raw.entry.trim() } : {}),
    capabilities,
    ...(models !== undefined ? { models: Object.freeze(models) } : {}),
  };
  return { ok: true, manifest: Object.freeze(manifest) };
}

/**
 * Validate a list of manifests and detect duplicate ids (`id_collision`).
 * All entries are inspected so callers can report every problem at once.
 *
 * @param {unknown} rawList
 * @param {{ reservedIds?: readonly string[] }} [options]
 * @returns {{
 *   ok: boolean,
 *   manifests: HarnessPluginManifest[],
 *   errors: Array<{ index: number, code: string, error: string, field?: string }>,
 *   duplicateIds: string[],
 * }}
 */
export function validateHarnessPluginSet(rawList, options = {}) {
  if (!Array.isArray(rawList)) {
    return {
      ok: false,
      manifests: [],
      errors: [{ index: -1, code: 'manifest_invalid', error: 'plugins must be an array', field: 'plugins' }],
      duplicateIds: [],
    };
  }
  /** @type {HarnessPluginManifest[]} */
  const manifests = [];
  /** @type {Array<{ index: number, code: string, error: string, field?: string }>} */
  const errors = [];
  /** @type {string[]} */
  const duplicateIds = [];
  const seen = new Set();
  rawList.forEach((raw, index) => {
    const result = validateHarnessPluginManifest(raw, options);
    if (!result.ok) {
      errors.push({ index, code: result.code, error: result.error, field: result.field });
      return;
    }
    const { id } = result.manifest;
    if (seen.has(id)) {
      if (!duplicateIds.includes(id)) duplicateIds.push(id);
      errors.push({ index, code: 'id_collision', error: `Duplicate harness plugin id "${id}"`, field: 'id' });
      return;
    }
    seen.add(id);
    manifests.push(result.manifest);
  });
  return { ok: errors.length === 0, manifests, errors, duplicateIds };
}

/**
 * UI/catalog-safe provider metadata. Deliberately omits `entry`: a local path
 * is host-internal and must never leak to clients.
 *
 * @param {unknown} rawManifest
 * @param {{ reservedIds?: readonly string[] }} [options]
 * @returns {{ ok: true, metadata: object } | (ContractResult & { ok: false })}
 */
export function buildHarnessProviderMetadata(rawManifest, options = {}) {
  const result = validateHarnessPluginManifest(rawManifest, options);
  if (!result.ok) return result;
  const { manifest } = result;
  return {
    ok: true,
    metadata: Object.freeze({
      id: manifest.id,
      label: manifest.label,
      description: manifest.description,
      origin: manifest.origin,
      version: manifest.version,
      hostMin: manifest.hostMin,
      apiVersion: manifest.apiVersion,
      capabilities: manifest.capabilities,
      ...(manifest.models !== undefined ? { models: manifest.models } : {}),
    }),
  };
}

/**
 * Runtime status shape for one plugin. `enabled` defaults to true for builtin
 * plugins and false for local plugins (local plugins opt in when saved).
 *
 * @param {unknown} rawManifest
 * @param {{
 *   enabled?: boolean,
 *   available?: boolean,
 *   configured?: boolean,
 *   reason?: string,
 * }} [runtime]
 * @param {{ reservedIds?: readonly string[] }} [options]
 * @returns {{ ok: true, status: object } | (ContractResult & { ok: false })}
 */
export function buildHarnessPluginStatus(rawManifest, runtime = {}, options = {}) {
  const result = validateHarnessPluginManifest(rawManifest, options);
  if (!result.ok) return result;
  const { manifest } = result;
  const local = manifest.origin === 'local';
  return {
    ok: true,
    status: Object.freeze({
      id: manifest.id,
      label: manifest.label,
      origin: manifest.origin,
      enabled: typeof runtime.enabled === 'boolean' ? runtime.enabled : !local,
      available: runtime.available === true,
      configured: runtime.configured === true,
      canDelegate: manifest.capabilities.delegation === true,
      capabilities: manifest.capabilities,
      reason: typeof runtime.reason === 'string' ? runtime.reason : '',
    }),
  };
}

/**
 * Resolve a validated manifest to a runnable provider. Distinguishes an
 * unknown id (`unknown_harness`) from a known-but-unavailable plugin
 * (`plugin_unavailable`) and from a known-but-disabled plugin
 * (`plugin_disabled`). Both `available: false` and `enabled: false` reject the
 * resolution; routing must never run a plugin the user turned off just because
 * its backend happens to be installed.
 *
 * @param {{
 *   id?: unknown,
 *   providers?: readonly HarnessPluginManifest[],
 *   statuses?: Record<string, { available?: boolean, enabled?: boolean } | undefined>,
 * }} [input]
 * @returns {{ ok: true, manifest: HarnessPluginManifest, status: object | null }
 *   | (ContractResult & { ok: false } & { manifest?: HarnessPluginManifest })}
 */
export function resolveHarnessProvider(input = {}) {
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) return fail('manifest_invalid', 'harness id is required', 'id');
  const providers = Array.isArray(input.providers) ? input.providers : [];
  const manifest = providers.find((row) => row && row.id === id);
  if (!manifest) {
    return fail('unknown_harness', `Unknown harness "${id}"`);
  }
  const status = input.statuses && input.statuses[id] ? input.statuses[id] : null;
  if (status && status.enabled === false) {
    return {
      ok: false,
      code: 'plugin_disabled',
      error: `Harness "${id}" is disabled`,
      manifest,
      status,
    };
  }
  if (status && status.available === false) {
    return {
      ok: false,
      code: 'plugin_unavailable',
      error: `Harness "${id}" is known but unavailable`,
      manifest,
      status,
    };
  }
  return { ok: true, manifest, status };
}

/**
 * Built-in-enabled invariant. Keeps existing backward compatibility:
 * a missing/empty/full built-in list means every built-in stays enabled, and
 * local plugins only ever turn on for an explicit saved list that is not the
 * full built-in set. A saved list equal to every builtin (even when it also
 * lists discovered locals) therefore leaves `enabledLocalIds` empty. The legacy
 * `cursor` alias is normalized to the built-in `sdk` id before resolution,
 * matching `normalizeEnabledHarnesses`, so an old saved list keeps enabling the
 * SDK. Unknown saved ids are returned as `preservedUnknownIds` so the caller
 * can persist them, but they are never emitted inside `enabledBuiltinIds`.
 *
 * @param {{
 *   builtinIds?: readonly string[],
 *   localIds?: readonly string[],
 *   savedIds?: readonly string[] | null,
 * }} [input]
 * @returns {{
 *   builtinIds: string[],
 *   localIds: string[],
 *   enabledBuiltinIds: string[],
 *   enabledLocalIds: string[],
 *   enabledIds: string[],
 *   preservedUnknownIds: string[],
 *   allBuiltinsEnabled: boolean,
 * }}
 */
export function resolveHarnessEnabledState(input = {}) {
  const builtinIds = uniqueStrings(
    Array.isArray(input.builtinIds) ? input.builtinIds : HARNESS_BUILTIN_IDS,
  );
  const localIds = uniqueStrings(Array.isArray(input.localIds) ? input.localIds : []);
  const savedProvided = Array.isArray(input.savedIds);
  const savedIds = savedProvided
    ? uniqueStrings(input.savedIds.map(canonicalizeSavedHarnessId))
    : [];
  const savedSet = new Set(savedIds);
  const knownSet = new Set([...builtinIds, ...localIds]);

  const preservedUnknownIds = savedIds.filter((id) => !knownSet.has(id));
  const allBuiltinsEnabled = !savedProvided
    || savedIds.length === 0
    || builtinIds.every((id) => savedSet.has(id));

  const enabledBuiltinIds = allBuiltinsEnabled
    ? builtinIds.slice()
    : builtinIds.filter((id) => savedSet.has(id));
  // The all-builtins fast path means "every builtin on, nothing opted in".
  // A saved list that supplies the full builtin set (even when it also lists
  // discovered locals) is not an explicit local opt-in, so locals stay off.
  const enabledLocalIds = allBuiltinsEnabled
    ? []
    : localIds.filter((id) => savedSet.has(id));

  return {
    builtinIds,
    localIds,
    enabledBuiltinIds,
    enabledLocalIds,
    enabledIds: [...enabledBuiltinIds, ...enabledLocalIds],
    preservedUnknownIds,
    allBuiltinsEnabled,
  };
}

/**
 * Legacy saved-harness aliases. `cursor` was the pre-rename id for the SDK
 * transport; a persisted settings list may still contain it.
 */
const SAVED_HARNESS_ID_ALIASES = Object.freeze({ cursor: 'sdk' });

/**
 * Map a legacy saved id onto its canonical built-in id before the enabled
 * resolution runs. Non-strings are passed through so `uniqueStrings` can drop
 * them, and unknown ids are preserved (never silently swapped to `sdk`).
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalizeSavedHarnessId(value) {
  if (typeof value !== 'string') return value;
  const token = value.trim();
  if (!token) return '';
  const alias = SAVED_HARNESS_ID_ALIASES[token.toLowerCase()];
  return alias || token;
}

/**
 * Dedupe trimmed non-empty strings, preserving first-seen order.
 *
 * @param {readonly unknown[]} raw
 * @returns {string[]}
 */
function uniqueStrings(raw) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const token = item.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
