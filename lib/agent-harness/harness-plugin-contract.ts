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
 *     origin: 'local',               // 'builtin' | 'builtin-optional' | 'local'
 *     entry: './index.js',           // safe relative path; required for local only
 *     entries: { light: './light.js', heavy: './heavy.js' }, // builtin-optional only
 *     defaultEnabled: true,          // optional boolean (default false); builtin-optional only
 *     capabilities: { chat: true },  // closed boolean set; missing keys default false
 *     models: [{ id: 'model-id', label: 'Model label' }], // optional static catalog
 *   }
 */

import { AGENT_TRANSPORTS, CORE_AGENT_TRANSPORTS } from '../agent-transport.js';

/** Manifest schema version this host understands. */
export const HARNESS_PLUGIN_API_VERSION = 1;

/** Supported plugin origins. */
export const HARNESS_PLUGIN_ORIGINS = Object.freeze(['builtin', 'builtin-optional', 'local']);

/**
 * Entry kinds of a `builtin-optional` plugin (docs/ts-migration-and-core-harnesses-plan.md, §3 B3):
 *  - `light`: backend (status / catalog / settings) and MCP adapter. Must stay
 *    importable without the harness runtime, so it may import neither
 *    room-kernel nor the providers module.
 *  - `heavy`: the provider runtime (WebSocket handler, routes, live room).
 *  - `front`: documentation of the browser panel module; the browser bundle
 *    resolves it through a static import map, never through this manifest.
 *  - `lifecycle`: standalone module exporting `{ processLifecycle }` for a harness
 *    that owns long-lived OS processes. It stays importable without the chat
 *    runtime, so the memory monitor CLI (which loads no plugin) can read it.
 */
export const HARNESS_PLUGIN_ENTRY_KINDS = Object.freeze(['light', 'heavy', 'front', 'lifecycle']);

/**
 * Ids a `builtin-optional` plugin may never take: the core harnesses stay in the
 * host. Other built-in ids are allowed because an optional plugin is how a
 * built-in harness leaves the core.
 */
export const HARNESS_CORE_RESERVED_IDS = Object.freeze([...CORE_AGENT_TRANSPORTS, 'cursor']);

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
  'entries',
  'defaultEnabled',
  'dependsOn',
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
const DEPENDS_ON_MAX_COUNT = 8;

export interface HarnessPluginCapabilities {
  chat: boolean;
  models: boolean;
  status: boolean;
  settings: boolean;
  mcp: boolean;
  delegation: boolean;
  serverRun: boolean;
}

export interface HarnessPluginManifest {
  apiVersion: number;
  id: string;
  version: string;
  hostMin: string;
  label: string;
  description: string;
  origin: 'builtin' | 'builtin-optional' | 'local';
  /** Local plugins only. */
  entry?: string;
  /** `builtin-optional` plugins only; see {@link HARNESS_PLUGIN_ENTRY_KINDS}. */
  entries?: Readonly<Partial<Record<'light' | 'heavy' | 'front' | 'lifecycle', string>>>;
  /** `builtin-optional` plugins only: loaded when CRETLI_OPTIONAL_HARNESSES is unset. */
  defaultEnabled?: boolean;
  /** `builtin-optional` plugins only: ids of plugins that must be loaded before this one. */
  dependsOn?: readonly string[];
  models?: ReadonlyArray<{ id: string, label?: string }>;
  capabilities: HarnessPluginCapabilities;
}

export interface ContractFailure {
  ok: false;
  code: string;
  error: string;
  field?: string;
}

/**
 * Hook a provider exposes when it owns long-lived OS processes (an HTTP server
 * per chat, a daemon). Core (server.js, the memory monitor) iterates providers
 * that declare it instead of naming a harness. All members except `id` /
 * `label` are optional so a provider implements only what it needs.
 *
 * Shutdown is two-phase: `beginStop` is synchronous and never awaited (it
 * signals processes before slower teardowns), `finishStop` is the bounded wait
 * and escalation.
 */
export interface HarnessProcessLifecycle {
  /** Provider id; names the `shutdown-<id>` diagnostics event. */
  id: string;
  /** Human label used in server log lines. */
  label: string;
  /** Background warm-up after the HTTP listener is up; resolves `{ skipped: true }` when there is nothing to warm. */
  warmUp?: () => Promise<{ skipped?: boolean, ok?: boolean, error?: string } | null | undefined>;
  /**
   * Boot step (preload the runtime, reclaim orphans of a previous server). May throw; the
   * host logs a warning and keeps booting.
   */
  start?: () => Promise<{ summary?: string } | null | undefined>;
  /** Synchronous shutdown phase 1. */
  beginStop?: () => (object | null);
  /** Bounded shutdown phase 2. */
  finishStop?: () => Promise<({ ok?: boolean, remaining?: unknown[] } & Record<string, unknown>) | null>;
  /** Live/pending counters for diagnostics. */
  getStats?: () => (object | null);
  /** Local ports Browser must not reach. */
  listInternalPorts?: (dataDir: string) => number[];
  /** Process state for the memory monitor. */
  monitor?: HarnessProcessMonitor;
}

/** The memory monitor's view of a provider's processes. */
export interface HarnessProcessMonitor {
  /** Defaults merged into the monitor config. */
  defaultConfig: Readonly<Record<string, number>>;
  /** Env overrides for those keys. */
  resolveConfig: (env: Record<string, string | undefined>) => Record<string, number>;
  /** Raw ownership registry. */
  readRegistry: (registryPath?: string) => Record<string, unknown>;
  /** Extra monitor probes. */
  createProbes: () => Record<string, Function>;
  /** Registry entries shaped like executor rows. */
  listExecutors: (registry: Record<string, unknown> | null | undefined) => object[];
  /** Pure classification. */
  evaluate: (input: object) => HarnessProcessMonitorEvaluation;
  /** Report lines. */
  formatReport: (evaluation: object, config: object) => string[];
}

export interface HarnessProcessMonitorEvaluation {
  /** Condition ids that fired. */
  triggered: string[];
  /** Episode alerts to merge in order. */
  episodeAlerts: object[];
  /** Extra keys merged into the evaluation result. */
  fields: Record<string, unknown>;
}

export type ContractError = Error & { code: string, field: string };

function fail(code: string, error: string, field = ''): ContractFailure {
  return { ok: false, code, error, ...(field ? { field } : {}) };
}

function manifestError(message: string, field: string): ContractError {
  const err = new Error(message) as ContractError;
  err.code = 'manifest_invalid';
  err.field = field;
  return err;
}

/**
 * @param field fallback when the error carries none
 */
function failFromError(err: unknown, field: string): ContractFailure {
  const coded = err as Partial<ContractError>;
  return fail(coded.code || 'manifest_invalid', coded.message as string, coded.field || field);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isHarnessPluginSemver(value: unknown): boolean {
  return typeof value === 'string' && HARNESS_PLUGIN_SEMVER_PATTERN.test(value.trim());
}

/**
 * Safe relative entry path check (no filesystem access).
 */
export function isSafeHarnessPluginEntry(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const entry = value.trim();
  if (!entry || entry.length > ENTRY_MAX_LENGTH) return false;
  return HARNESS_PLUGIN_ENTRY_PATTERN.test(entry);
}

/**
 * Normalize a capability object into the closed capability set. Missing keys
 * become `false`; unknown keys and non-boolean values throw a coded error.
 */
export function normalizeHarnessPluginCapabilities(raw: unknown): HarnessPluginCapabilities {
  if (raw === undefined) {
    return (
      Object.freeze(Object.fromEntries(HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, false])))
    ) as unknown as HarnessPluginCapabilities;
  }
  if (!isPlainObject(raw)) {
    throw manifestError('capabilities must be an object', 'capabilities');
  }
  for (const key of Object.keys(raw)) {
    if (!HARNESS_PLUGIN_CAPABILITY_KEYS.includes(key)) {
      throw manifestError(`Unknown capability "${key}"`, `capabilities.${key}`);
    }
    if (typeof raw[key] !== 'boolean') {
      throw manifestError(`Capability "${key}" must be a boolean`, `capabilities.${key}`);
    }
  }
  return (Object.freeze(
    Object.fromEntries(HARNESS_PLUGIN_CAPABILITY_KEYS.map((key) => [key, raw[key] === true])),
  )) as unknown as HarnessPluginCapabilities;
}

/**
 * Normalize and validate the static model catalog from a plugin manifest.
 * Model identifiers are scoped by their harness in the catalog API; control
 * characters are rejected so values remain safe across logs and clients.
 */
function normalizeManifestModels(raw: unknown): Array<{ id: string, label?: string }> {
  if (!Array.isArray(raw)) {
    throw manifestError('models must be an array', 'models');
  }
  if (raw.length > MODELS_MAX_COUNT) {
    throw manifestError(`models must contain at most ${MODELS_MAX_COUNT} entries`, 'models');
  }

  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) {
      throw manifestError(`models[${index}] must be an object`, `models.${index}`);
    }
    for (const key of Object.keys(item)) {
      if (key !== 'id' && key !== 'label') {
        throw manifestError(`Unknown model field "${key}"`, `models.${index}.${key}`);
      }
    }
    if (typeof item.id !== 'string') {
      throw manifestError(`models[${index}].id must be a string`, `models.${index}.id`);
    }
    const id = item.id.trim();
    if (!id || id.length > MODEL_ID_MAX_LENGTH || hasControlCharacters(id)) {
      throw manifestError(`models[${index}].id must be non-empty and at most ${MODEL_ID_MAX_LENGTH} safe characters`, `models.${index}.id`);
    }
    if (seen.has(id)) {
      throw manifestError(`Duplicate model id "${id}"`, `models.${index}.id`);
    }
    seen.add(id);

    if (item.label === undefined) return Object.freeze({ id });
    if (typeof item.label !== 'string') {
      throw manifestError(`models[${index}].label must be a string`, `models.${index}.label`);
    }
    const label = item.label.trim();
    if (!label || label.length > MODEL_LABEL_MAX_LENGTH || hasControlCharacters(label)) {
      throw manifestError(`models[${index}].label must be non-empty and at most ${MODEL_LABEL_MAX_LENGTH} safe characters`, `models.${index}.label`);
    }
    return Object.freeze({ id, label });
  });
}

function normalizeOptionalEntries(raw: unknown): { ok: true, entries: Record<string, string> } | ContractFailure {
  if (!isPlainObject(raw)) {
    return fail('manifest_invalid', 'builtin-optional plugins require an entries object', 'entries');
  }
  const entries: Record<string, string> = {};
  for (const [kind, value] of Object.entries(raw)) {
    if (!HARNESS_PLUGIN_ENTRY_KINDS.includes(kind)) {
      return fail('manifest_invalid', `Unknown entry kind "${kind}"`, 'entries');
    }
    if (!isSafeHarnessPluginEntry(value) || !String(value).endsWith('.js')) {
      return fail(
        'manifest_invalid',
        `entries.${kind} must be a safe relative .js path (no absolute path, no "..", no backslash)`,
        'entries',
      );
    }
    entries[kind] = String(value).trim();
  }
  if (!entries.light && !entries.heavy) {
    return fail('manifest_invalid', 'entries must declare at least a light or a heavy entry', 'entries');
  }
  return { ok: true, entries };
}

function normalizeDependsOn(raw: unknown, ownId: string): { ok: true, dependsOn: string[] } | ContractFailure {
  if (!Array.isArray(raw)) return fail('manifest_invalid', 'dependsOn must be an array of plugin ids', 'dependsOn');
  if (raw.length > DEPENDS_ON_MAX_COUNT) {
    return fail('manifest_invalid', `dependsOn must contain at most ${DEPENDS_ON_MAX_COUNT} ids`, 'dependsOn');
  }
  const ids: string[] = [];
  for (const item of raw) {
    const dep = typeof item === 'string' ? item.trim() : '';
    if (!dep || dep.length > ID_MAX_LENGTH || !HARNESS_PLUGIN_ID_PATTERN.test(dep)) {
      return fail('manifest_invalid', 'dependsOn entries must be valid harness plugin ids', 'dependsOn');
    }
    if (dep === ownId) return fail('manifest_invalid', 'a plugin cannot depend on itself', 'dependsOn');
    if (HARNESS_CORE_RESERVED_IDS.includes(dep)) {
      return fail('manifest_invalid', `dependsOn may not name the core harness "${dep}" (it is always present)`, 'dependsOn');
    }
    if (!ids.includes(dep)) ids.push(dep);
  }
  return { ok: true, dependsOn: ids };
}

/**
 * Validate a single harness plugin manifest.
 */
export function validateHarnessPluginManifest(
  raw: unknown,
  options: { reservedIds?: readonly string[] } = {},
): { ok: true, manifest: HarnessPluginManifest } | ContractFailure {
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
  // An optional built-in may reuse a non-core built-in id (that is how a
  // harness leaves the core); everything else keeps the full reserved set.
  const reservedIds = new Set(
    Array.isArray(options.reservedIds)
      ? options.reservedIds
      : (raw.origin === 'builtin-optional' ? HARNESS_CORE_RESERVED_IDS : HARNESS_RESERVED_IDS),
  );
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

  if (typeof raw.origin !== 'string' || !HARNESS_PLUGIN_ORIGINS.includes(raw.origin)) {
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
    return fail('manifest_invalid', `${raw.origin} plugins must not declare an entry path`, 'entry');
  }

  let entries: Record<string, string> | undefined;
  if (raw.origin === 'builtin-optional') {
    const checked = normalizeOptionalEntries(raw.entries);
    if (!checked.ok) return checked as ContractFailure;
    entries = checked.entries;
  } else if (raw.entries !== undefined) {
    return fail('manifest_invalid', `${raw.origin} plugins must not declare entries`, 'entries');
  }

  let defaultEnabled;
  if (raw.defaultEnabled !== undefined) {
    if (raw.origin !== 'builtin-optional') {
      return fail('manifest_invalid', `${raw.origin} plugins must not declare defaultEnabled`, 'defaultEnabled');
    }
    if (typeof raw.defaultEnabled !== 'boolean') {
      return fail('manifest_invalid', 'defaultEnabled must be a boolean', 'defaultEnabled');
    }
    defaultEnabled = raw.defaultEnabled;
  }

  let dependsOn;
  if (raw.dependsOn !== undefined) {
    if (raw.origin !== 'builtin-optional') {
      return fail('manifest_invalid', `${raw.origin} plugins must not declare dependsOn`, 'dependsOn');
    }
    const checked = normalizeDependsOn(raw.dependsOn, id);
    if (!checked.ok) return checked as ContractFailure;
    dependsOn = checked.dependsOn;
  }

  let capabilities;
  try {
    capabilities = normalizeHarnessPluginCapabilities(raw.capabilities);
  } catch (err) {
    return failFromError(err, 'capabilities');
  }

  let models;
  if (raw.models !== undefined) {
    if (capabilities.models !== true) {
      return fail('manifest_invalid', 'models requires capabilities.models to be true', 'models');
    }
    try {
      models = normalizeManifestModels(raw.models);
    } catch (err) {
      return failFromError(err, 'models');
    }
  }

  // Every field read below was validated above.
  const fields = raw as {
    version: string, hostMin: string, label: string, description: string,
    origin: 'builtin' | 'builtin-optional' | 'local', entry: string,
  };
  const manifest: HarnessPluginManifest = {
    apiVersion: HARNESS_PLUGIN_API_VERSION,
    id,
    version: fields.version.trim(),
    hostMin: fields.hostMin.trim(),
    label: fields.label.trim(),
    description: fields.description.trim(),
    origin: fields.origin,
    ...(fields.origin === 'local' ? { entry: fields.entry.trim() } : {}),
    ...(entries ? { entries: Object.freeze(entries) } : {}),
    ...(raw.origin === 'builtin-optional' ? { defaultEnabled: defaultEnabled === true } : {}),
    ...(dependsOn && dependsOn.length > 0 ? { dependsOn: Object.freeze(dependsOn) } : {}),
    capabilities,
    ...(models !== undefined ? { models: Object.freeze(models) } : {}),
  };
  return { ok: true, manifest: Object.freeze(manifest) };
}

/**
 * Validate a list of manifests and detect duplicate ids (`id_collision`).
 * All entries are inspected so callers can report every problem at once.
 */
export function validateHarnessPluginSet(
  rawList: unknown,
  options: { reservedIds?: readonly string[] } = {},
): {
  ok: boolean,
  manifests: HarnessPluginManifest[],
  errors: Array<{ index: number, code: string, error: string, field?: string }>,
  duplicateIds: string[],
} {
  if (!Array.isArray(rawList)) {
    return {
      ok: false,
      manifests: [],
      errors: [{ index: -1, code: 'manifest_invalid', error: 'plugins must be an array', field: 'plugins' }],
      duplicateIds: [],
    };
  }
  const manifests: HarnessPluginManifest[] = [];
  const errors: Array<{ index: number, code: string, error: string, field?: string }> = [];
  const duplicateIds: string[] = [];
  const seen = new Set<string>();
  rawList.forEach((raw, index) => {
    const result = validateHarnessPluginManifest(raw, options);
    if (result.ok === false) {
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
 * UI/catalog-safe provider metadata. Deliberately omits `entry`/`entries`: a local path
 * is host-internal and must never leak to clients.
 */
export function buildHarnessProviderMetadata(
  rawManifest: unknown,
  options: { reservedIds?: readonly string[] } = {},
): { ok: true, metadata: object } | ContractFailure {
  const result = validateHarnessPluginManifest(rawManifest, options);
  if (result.ok === false) return result;
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
 */
export function buildHarnessPluginStatus(
  rawManifest: unknown,
  runtime: {
    enabled?: boolean,
    available?: boolean,
    configured?: boolean,
    reason?: string,
  } = {},
  options: { reservedIds?: readonly string[] } = {},
): { ok: true, status: object } | ContractFailure {
  const result = validateHarnessPluginManifest(rawManifest, options);
  if (result.ok === false) return result;
  const { manifest } = result;
  // Local and optional plugins are opt-in; only a plain built-in defaults on.
  const local = manifest.origin !== 'builtin';
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
 */
export function resolveHarnessProvider(
  input: {
    id?: unknown,
    providers?: readonly HarnessPluginManifest[],
    statuses?: Record<string, { available?: boolean, enabled?: boolean } | undefined>,
  } = {},
): { ok: true, manifest: HarnessPluginManifest, status: object | null }
  | (ContractFailure & { manifest?: HarnessPluginManifest, status?: object }) {
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
 */
export function resolveHarnessEnabledState(
  input: {
    builtinIds?: readonly string[],
    localIds?: readonly string[],
    savedIds?: readonly string[] | null,
  } = {},
): {
  builtinIds: string[],
  localIds: string[],
  enabledBuiltinIds: string[],
  enabledLocalIds: string[],
  enabledIds: string[],
  preservedUnknownIds: string[],
  allBuiltinsEnabled: boolean,
} {
  const builtinIds = uniqueStrings(
    Array.isArray(input.builtinIds) ? input.builtinIds : HARNESS_BUILTIN_IDS,
  );
  const localIds = uniqueStrings(Array.isArray(input.localIds) ? input.localIds : []);
  const savedProvided = Array.isArray(input.savedIds);
  const savedIds = savedProvided
    ? uniqueStrings((input.savedIds || []).map(canonicalizeSavedHarnessId))
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
const SAVED_HARNESS_ID_ALIASES: Readonly<Record<string, string | undefined>> = Object.freeze({ cursor: 'sdk' });

/**
 * Map a legacy saved id onto its canonical built-in id before the enabled
 * resolution runs. Non-strings are passed through so `uniqueStrings` can drop
 * them, and unknown ids are preserved (never silently swapped to `sdk`).
 */
function canonicalizeSavedHarnessId(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const token = value.trim();
  if (!token) return '';
  const alias = SAVED_HARNESS_ID_ALIASES[token.toLowerCase()];
  return alias || token;
}

/**
 * Dedupe trimmed non-empty strings, preserving first-seen order.
 */
function uniqueStrings(raw: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const token = item.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
