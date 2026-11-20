/**
 * Shared building blocks for the per-harness Settings modules
 * (lib/<id>/<id>-settings.js). Each module owns its harness's fields of
 * GET/PATCH /api/settings, so the fields move with the harness
 * (docs/ts-migration-and-core-harnesses-plan.md, B2/B3).
 */

import { normalizeChatEnabledModels } from '../model-catalog.js';

export type SettingsDoc = Record<string, any>;
export type SettingsPatchBody = Record<string, any> | null | undefined;
export type SettingsPatchResult = { changed: boolean; error?: { status: number; message: string } };

export interface HarnessSettingsModule {
  /** This harness's fields of the GET /api/settings payload (no secrets). */
  readClientSettings: (settings: SettingsDoc) => Record<string, unknown>;
  /** Applies this harness's PATCH fields to `settings` in place. */
  applySettingsPatch: (body: SettingsPatchBody, settings: SettingsDoc) => SettingsPatchResult;
  /** The saved patch must restart the harness runtime (the provider's `resetRuntime`). */
  requiresRuntimeReset?: (body: SettingsPatchBody) => boolean;
  /** Declares the fields above so the Settings screen can render them generically. */
  settingsSchema?: HarnessSettingsSchema;
}

/** One field of GET/PATCH /api/settings owned by a harness. */
export interface HarnessSettingsField {
  /** Key in the PATCH body (and in the GET payload unless `get` is false). */
  name: string;
  /**
   * `secret` is write-only: the GET payload carries `…FromEnv` / `…StoredInSettings` /
   * `…Effective` flags instead of the value.
   */
  kind: 'secret' | 'string' | 'enum' | 'int' | 'models';
  /** False when the field is PATCH-only (default true). */
  get?: boolean;
  /** PATCH flag (`true`) that deletes the stored value. */
  clearFlag?: string;
  /** Allowed values of an `enum`. */
  values?: readonly string[];
}

/**
 * A pending/stored state hint: the first rule whose flags are all truthy in the
 * GET payload wins, else `fallbackKey`. Keys are i18n keys.
 */
export interface HarnessSettingsHint {
  /** DOM id of the hint element. */
  id: string;
  rules: readonly { when: readonly string[]; key: string }[];
  fallbackKey: string;
}

/** Credential row: `<prefix>-input`, `-save-btn`, `-clear-btn`, `-save-status`. */
export interface HarnessSettingsSecretUi {
  prefix: string;
  /** PATCH field that stores the key. */
  field: string;
  clearFlag: string;
  /** Hint group re-applied after a save. */
  group: string;
}

export interface HarnessSettingsTextUi {
  inputId: string;
  saveBtnId: string;
  statusId: string;
  /** PATCH field; its GET value fills the input. */
  field: string;
  group: string;
  /** Extra hint line next to the input. */
  hint?: HarnessSettingsHint;
}

export interface HarnessSettingsSelectUi {
  /** DOM id of the `cr-bar-select` (or native select). */
  id: string;
  field: string;
  options: readonly { value: string; labelKey: string }[];
  /** Value used when the GET/PATCH value is not an option. */
  fallback: string;
  statusId: string | null;
  group: string;
  event: 'cr-change' | 'change';
  /** Do not touch the control while the GET value is empty. */
  applyOnlyWhenSet?: boolean;
  /** Rebuild option labels when the UI language changes. */
  relabelOnLangChange?: boolean;
}

export interface HarnessSettingsUi {
  /** Window event fired after a credential change. */
  keyChangedEvent: string | null;
  groups: readonly (HarnessSettingsHint & { group: string })[];
  secrets: readonly HarnessSettingsSecretUi[];
  texts: readonly HarnessSettingsTextUi[];
  selects: readonly HarnessSettingsSelectUi[];
}

export interface HarnessSettingsSchema {
  /** Transport id. */
  harness: string;
  fields: readonly HarnessSettingsField[];
  /** GET-only fields (credential state flags, resolved values). */
  readOnly: readonly string[];
  /**
   * Static Settings screen description, rendered by
   * app_front/features/settings/harnessSettingsRenderer.js.
   */
  ui: HarnessSettingsUi;
}

/** `key: string` sets the trimmed value, or deletes the setting when blank. Returns whether the field was present. */
export function patchTrimmedString(
  body: SettingsPatchBody,
  settings: SettingsDoc,
  key: string,
): boolean {
  if (!body || typeof body[key] !== 'string') return false;
  const raw = body[key].trim();
  if (raw) settings[key] = raw;
  else delete settings[key];
  return true;
}

/** `flag: true` deletes `key`. Returns whether the flag was set. */
export function patchClear(
  body: SettingsPatchBody,
  settings: SettingsDoc,
  flag: string,
  key: string,
): boolean {
  if (!body || body[flag] !== true) return false;
  delete settings[key];
  return true;
}

/** Favorite model ids; an empty list deletes the setting. Returns whether the field was present. */
export function patchEnabledModels(
  body: SettingsPatchBody,
  settings: SettingsDoc,
  key: string,
  normalize: (raw: unknown) => string[] = normalizeChatEnabledModels,
): boolean {
  if (!body || typeof body[key] === 'undefined') return false;
  const normalized = normalize(body[key]);
  if (normalized.length > 0) settings[key] = normalized;
  else delete settings[key];
  return true;
}

export function invalidSettings(message: string): SettingsPatchResult {
  return { changed: false, error: { status: 400, message } };
}
