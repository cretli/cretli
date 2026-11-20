/**
 * Context settings resolver.
 *
 * Layers (later wins, inside host policy):
 *   safe defaults -> host global -> project (`.cretli/context.json`) -> chat.
 *
 * A *profile* is a named set of the same settings. It is applied through the
 * same `applyLayer` step as any other layer (profile values first, then the
 * layer's own explicit values); there is no second resolver.
 *
 * Host-only material never flows through this resolver: which external
 * sources (shared, user, bundled) exist and which project they are assigned to
 * is host configuration outside the repo. `.cretli/context.json` that names such
 * a key is rejected. `additionalCursorContextDirs` stays the stored host value
 * and is only *read* here (shown read-only), so nothing is migrated away.
 */
import { AGENTS_MD_MODES } from './agents-md.ts';
import { INSTRUCTION_DEDUPE_SETTINGS } from './instruction-epoch.ts';

export const CONTEXT_SETTINGS_VERSION = 1;

export interface ContextSettingDef {
  type: 'enum' | 'boolean';
  values?: readonly string[];
  default: string | boolean;
  effect: 'next_turn' | 'new_session';
  retraction?: 'new_session';
}

type SettingsState = { effective: Record<string, any>, provenance: Record<string, any>, blocked: any[] };
type SettingsPolicy = { locked: Set<string>, forbidden: Map<string, Set<string>> };

/**
 * Settings the send path actually reads today. `effect` says when a change is
 * seen: `next_turn` = the next prompt Cretli builds; `retraction` documents
 * that text already delivered into a native session is not withdrawn.
 */
export const CONTEXT_SETTING_DEFS: Readonly<Record<string, ContextSettingDef>> = Object.freeze({
  'agentsMd.mode': Object.freeze({
    type: 'enum',
    values: AGENTS_MD_MODES,
    default: 'auto',
    effect: 'next_turn',
    retraction: 'new_session',
  }),
  'globs.index': Object.freeze({
    type: 'boolean',
    default: true,
    effect: 'next_turn',
  }),
  // Soft budget: warns about the size of what Cretli adds, never trims or blocks.
  'budget.mode': Object.freeze({
    type: 'enum',
    values: Object.freeze(['soft', 'off']),
    default: 'soft',
    effect: 'next_turn',
  }),
  // Opt-in: skip the static block on later turns, only for adapters with retention proof.
  'instructions.dedupe': Object.freeze({
    type: 'enum',
    values: INSTRUCTION_DEDUPE_SETTINGS,
    default: 'off',
    effect: 'next_turn',
    retraction: 'new_session',
  }),
});

/** Keys a repo config may never carry: they select or assign host sources. */
export const HOST_ONLY_SETTING_KEYS = Object.freeze([
  'sharedDirs', 'additionalCursorContextDirs', 'additionalDirs', 'sources', 'assignments',
  'shared', 'user', 'home', 'bundled', 'host', 'external',
]);

export const CONTEXT_SETTINGS_LAYERS = Object.freeze(['default', 'host', 'project', 'chat']);

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * @param raw Nested (`{ agentsMd: { mode } }`) or flat (`'agentsMd.mode'`) object.
 * @returns Flat dotted keys.
 */
function flatten(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) out[`${key}.${inner}`] = innerValue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate one layer's raw settings.
 */
export function normalizeSettingsLayer(raw: unknown): { values: Record<string, string | boolean>, profile: string, errors: { key: string, code: string }[] } {
  const values: Record<string, string | boolean> = {};
  const errors: { key: string, code: string }[] = [];
  let profile = '';
  const source: Record<string, any> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  if (typeof source.profile === 'string' && source.profile.trim()) {
    const name = source.profile.trim();
    if (PROFILE_NAME_PATTERN.test(name)) profile = name;
    else errors.push({ key: 'profile', code: 'invalid_profile_name' });
  }
  delete source.profile;
  delete source.version;
  for (const [key, value] of Object.entries(flatten(source))) {
    const def = CONTEXT_SETTING_DEFS[key];
    if (!def) {
      errors.push({ key, code: 'unknown_setting' });
      continue;
    }
    if (def.type === 'boolean' && typeof value === 'boolean') values[key] = value;
    else if (def.type === 'enum' && typeof value === 'string' && def.values?.includes(value)) values[key] = value;
    else errors.push({ key, code: 'invalid_value' });
  }
  return { values, profile, errors };
}

/**
 * Validate the `settings` / `profiles` sections of `.cretli/context.json`.
 * Host-only keys are an error, not silently dropped.
 *
 * @param config Parsed repo config.
 */
export function validateRepoContextSettings(config: Record<string, any>):
  { ok: true, settings: Record<string, any>, profiles: Record<string, Record<string, any>> }
  | { ok: false, error: string, code: string } {
  const settings = config?.settings === undefined ? {} : config.settings;
  const profiles = config?.profiles === undefined ? {} : config.profiles;
  const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(settings)) return { ok: false, error: 'settings must be an object', code: 'invalid_settings' };
  if (!isObject(profiles)) return { ok: false, error: 'profiles must be an object', code: 'invalid_settings' };
  const sections = [settings, ...Object.values(profiles)];
  for (const section of sections) {
    if (!isObject(section)) return { ok: false, error: 'profile must be an object', code: 'invalid_settings' };
    for (const key of Object.keys(flatten(section))) {
      const top = key.split('.')[0];
      if (HOST_ONLY_SETTING_KEYS.includes(top)) {
        return {
          ok: false,
          error: `Project config cannot set host-only key "${top}"`,
          code: 'host_source_in_repo_config',
        };
      }
    }
    if (isObject(section) && normalizeSettingsLayer(section).errors.length > 0) {
      const first = normalizeSettingsLayer(section).errors[0];
      return { ok: false, error: `Invalid project setting "${first.key}" (${first.code})`, code: first.code };
    }
  }
  for (const name of Object.keys(profiles)) {
    if (!PROFILE_NAME_PATTERN.test(name)) return { ok: false, error: `Invalid profile name "${name}"`, code: 'invalid_profile_name' };
  }
  return { ok: true, settings, profiles };
}

/**
 * Apply one layer (profile values, then explicit values) onto the running state.
 * This is the single merge step used for every layer.
 */
function applyLayer(
  state: SettingsState,
  { layer, layerData, profiles, policy }: {
    layer: 'host' | 'project' | 'chat',
    layerData: unknown,
    profiles: Record<string, unknown>,
    policy: SettingsPolicy,
  },
): { layer: string, profile: string, applied: string[] } {
  const normalized = normalizeSettingsLayer(layerData);
  const applied: string[] = [];
  const steps: { via: string, values: Record<string, any> }[] = [];
  let profile = '';
  if (normalized.profile) {
    if (Object.prototype.hasOwnProperty.call(profiles, normalized.profile)) {
      profile = normalized.profile;
      steps.push({ via: `profile:${profile}`, values: normalizeSettingsLayer(profiles[profile]).values });
    } else {
      state.blocked.push({ layer, key: `profile:${normalized.profile}`, reason: 'unknown_profile' });
    }
  }
  steps.push({ via: layer, values: normalized.values });
  for (const error of normalized.errors) state.blocked.push({ layer, key: error.key, reason: error.code });
  for (const step of steps) {
    for (const [key, value] of Object.entries(step.values)) {
      if (layer !== 'host' && policy.locked.has(key)) {
        state.blocked.push({ layer, key, reason: 'host_policy_locked' });
        continue;
      }
      if (layer !== 'host' && policy.forbidden.get(key)?.has(String(value))) {
        state.blocked.push({ layer, key, reason: 'host_policy_value' });
        continue;
      }
      state.effective[key] = value;
      state.provenance[key] = { layer, via: step.via };
      applied.push(key);
    }
  }
  return { layer, profile, applied };
}

/**
 * @param rawPolicy `contextPolicy` from host settings.
 */
function normalizePolicy(rawPolicy: unknown): SettingsPolicy {
  const policy: Record<string, any> = rawPolicy && typeof rawPolicy === 'object' ? (rawPolicy as Record<string, any>) : {};
  const locked = new Set<string>(
    (Array.isArray(policy.locked) ? policy.locked : []).filter((key: string) => CONTEXT_SETTING_DEFS[key]),
  );
  const forbidden = new Map<string, Set<string>>();
  const raw: Record<string, unknown> = policy.forbiddenValues && typeof policy.forbiddenValues === 'object' ? policy.forbiddenValues : {};
  for (const [key, list] of Object.entries(raw)) {
    if (CONTEXT_SETTING_DEFS[key] && Array.isArray(list)) forbidden.set(key, new Set(list.map(String)));
  }
  return { locked, forbidden };
}

/**
 * Resolve the effective context settings for one turn.
 */
export function resolveContextSettings(input: {
  hostSettings?: Record<string, any>,
  projectConfig?: { active: boolean, config?: Record<string, any> | null, path?: string, error?: string } | null,
  chat?: Record<string, any> | null,
} = {}): {
  version: number,
  effective: Record<string, string | boolean>,
  provenance: Record<string, { layer: string, via: string }>,
  layers: { layer: string, profile: string, applied: string[], active: boolean }[],
  blocked: { layer: string, key: string, reason: string }[],
  repoConfig: { active: boolean, path?: string, error?: string, changes: string[] },
  effects: Record<string, { effect: string, retraction?: string }>,
  hostProfiles: string[],
  projectProfiles: string[],
  sharedDirs: { values: string[], readOnly: true, storedAs: string },
  policy: { locked: string[] },
} {
  const host = input.hostSettings || {};
  const hostBlock = host.contextSettings && typeof host.contextSettings === 'object' ? host.contextSettings : {};
  const hostProfiles = host.contextProfiles && typeof host.contextProfiles === 'object' ? host.contextProfiles : {};
  const policy = normalizePolicy(host.contextPolicy);

  const repo: { active: boolean, config?: Record<string, any> | null, path?: string, error?: string } = input.projectConfig || { active: false };
  let projectSettings: Record<string, any> = {};
  let projectProfiles: Record<string, any> = {};
  let repoError = repo.error;
  if (repo.active && repo.config) {
    const checked = validateRepoContextSettings(repo.config);
    if (checked.ok === true) {
      projectSettings = checked.settings;
      projectProfiles = checked.profiles;
    } else {
      repoError = checked.error;
    }
  }

  const state: SettingsState = { effective: {}, provenance: {}, blocked: [] };
  for (const [key, def] of Object.entries(CONTEXT_SETTING_DEFS)) {
    state.effective[key] = def.default;
    state.provenance[key] = { layer: 'default', via: 'default' };
  }
  const layers: { layer: string, profile: string, applied: string[], active: boolean }[] = [{ layer: 'default', profile: '', applied: Object.keys(CONTEXT_SETTING_DEFS), active: true }];
  // Profile lookup: the host's profiles always apply; a project layer may also use its own.
  const allProfiles = { ...projectProfiles, ...hostProfiles };
  const pushLayer = (layer: 'host' | 'project' | 'chat', data: unknown, profiles: Record<string, unknown>, active: boolean) => {
    const result = active ? applyLayer(state, { layer, layerData: data, profiles, policy }) : { layer, profile: '', applied: [] as string[] };
    layers.push({ ...result, active });
  };
  pushLayer('host', hostBlock, hostProfiles, true);
  pushLayer('project', projectSettings, allProfiles, Boolean(repo.active && !repoError));
  const chatBlock = input.chat?.contextSettings;
  pushLayer('chat', chatBlock, allProfiles, Boolean(chatBlock && typeof chatBlock === 'object'));

  const projectLayer = layers.find((row) => row.layer === 'project');
  const sharedDirs = Array.isArray(host.additionalCursorContextDirs) ? host.additionalCursorContextDirs.map(String) : [];
  return {
    version: CONTEXT_SETTINGS_VERSION,
    effective: state.effective,
    provenance: state.provenance,
    layers,
    blocked: state.blocked,
    repoConfig: {
      active: Boolean(repo.active && !repoError),
      ...(repo.path ? { path: '.cretli/context.json' } : {}),
      ...(repoError ? { error: repoError } : {}),
      changes: projectLayer?.applied || [],
    },
    effects: Object.fromEntries(Object.entries(CONTEXT_SETTING_DEFS).map(([key, def]) => [
      key,
      { effect: def.effect, ...(def.retraction ? { retraction: def.retraction } : {}) },
    ])),
    hostProfiles: Object.keys(hostProfiles),
    projectProfiles: Object.keys(projectProfiles),
    sharedDirs: { values: sharedDirs, readOnly: true, storedAs: 'additionalCursorContextDirs' },
    policy: { locked: [...policy.locked] },
  };
}

/**
 * Merge a validated patch into a stored layer block. `null` clears a key.
 * Returns the new nested block and the validation errors (nothing is applied
 * when any error is present).
 */
export function mergeSettingsPatch(stored: Record<string, any> | undefined, patch: Record<string, any>): { ok: true, block: Record<string, any> } | { ok: false, errors: { key: string, code: string }[] } {
  const clears: string[] = [];
  const cleaned = { ...patch };
  const flatPatch = flatten(patch);
  for (const [key, value] of Object.entries(flatPatch)) {
    if (value === null && CONTEXT_SETTING_DEFS[key]) {
      clears.push(key);
      delete flatPatch[key];
    }
  }
  if (cleaned.profile === null) clears.push('profile');
  const normalized = normalizeSettingsLayer(
    Object.fromEntries(Object.entries({ ...flatPatch, profile: cleaned.profile }).filter(([, v]) => v !== undefined && v !== null)),
  );
  if (normalized.errors.length > 0) return { ok: false, errors: normalized.errors };
  const prior = normalizeSettingsLayer(stored);
  const values = { ...prior.values, ...normalized.values };
  for (const key of clears) delete values[key];
  let profile = normalized.profile || prior.profile;
  if (clears.includes('profile')) profile = '';
  const block: Record<string, any> = { version: CONTEXT_SETTINGS_VERSION };
  for (const [key, value] of Object.entries(values)) {
    const [group, name] = key.split('.');
    block[group] = { ...(block[group] || {}), [name]: value };
  }
  if (profile) block.profile = profile;
  return { ok: true, block };
}
