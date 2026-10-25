/**
 * Server settings (for example the LAN host used for the link/QR code).
 * data/config.json: { lanHost?: string }
 */

import fs from 'fs';
import {
  SDK_SYSTEM_PROMPT_MAX_CHARS,
  normalizeSdkSystemPromptText,
} from '../sdk/sdk-system-prompt.ts';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath, resolveProjectPath } from '../runtime-paths.js';
import {
  WORKSPACE_SETTINGS_KEYS,
  exportWorkspaceSettingsToConfigShape,
  hasWorkspaceSections,
  isWorkspacesStoreMigrated,
  migrateWorkspaceSettingsFromConfig,
  readWorkspaceSettingsView,
  replaceWorkspaceSettings,
  resolveWorkspaceRef,
} from './workspaces-store.js';
import { loadWorkspace } from '../workspace.js';

const CONFIG_FILE = resolveDataPath('config.json');

function ensureDir() {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * @typedef {{
 *   enabled?: boolean,
 *   folder?: string,
 *   workspaceFile?: string,
 *   label?: string,
 *   folders?: any
 * }} WorkspaceSidebarConfigEntry
 */

/**
 * @returns {{
 *   lanHost?: string,
 *   workspaceFile?: string,
 *   workspaceFolder?: string,
 *   workspaces?: Array<{ id: string, kind: 'file' | 'folders', workspaceFile?: string, label?: string }>,
 *   workspaceSidebarConfig?: Record<string, WorkspaceSidebarConfigEntry>,
 *   additionalCursorContextDirs?: string[],
 *   agentTitlePrint?: boolean,
 *   autoTitle?: { mode?: 'off' | 'first' | 'continuous', provider?: string, source?: string, model?: string },
 *   chatAutoArchive?: { enabled?: boolean, idleValue?: number, idleUnit?: 'minutes' | 'hours' | 'days', skipFavorites?: boolean },
 *   harnessUpdateCheck?: { enabled?: boolean },
 *   debugStartup?: boolean,
 *   debugApi?: boolean,
 *   debugTasks?: boolean,
 *   debugOverlay?: boolean,
 *   debugUiFreeze?: boolean,
 *   debugRemote?: boolean,
 *   debugHttpTiming?: boolean,
 *   cursorApiKey?: string,
 *   openrouterApiKey?: string,
 *   artificialAnalysisApiKey?: string,
 *   openrouterSiteUrl?: string,
 *   openrouterAppTitle?: string,
 *   sdkRunIdleTimeoutSeconds?: number,
 *   sdkRunStuckRecoveryCapSeconds?: number,
 *   sdkRunAutoRecovery?: boolean,
 *   sdkCustomSystemPrompt?: { enabled?: boolean, text?: string },
 *   chatEnabledModels?: string[],
 *   delegationRoleFavorites?: Record<string, Partial<Record<'plan' | 'implement' | 'review' | 'fix', string[]>>>,
 *   openrouterChatEnabledModels?: string[],
   *   opencodeApiKey?: string,
 *   opencodeZaiApiKey?: string,
 *   zaiApiKey?: string,
 *   zaiProvider?: 'zai-coding-plan' | 'zai',
 *   mimoApiKey?: string,
 *   mimoBaseUrl?: string,
 *   opencodeMimoApiKey?: string,
 *   opencodeMimoBaseUrl?: string,
   *   opencodeZaiProvider?: 'zai-coding-plan' | 'zai',
 *   opencodeBin?: string,
 *   opencodePortBase?: number,
 *   opencodeMaxInstances?: number,
 *   opencodeDelegationIdleMs?: number,
 *   opencodeCompaction?: { auto?: boolean, prune?: boolean, reserved?: number },
 *   opencodeChatEnabledModels?: string[],
 *   codebuddyApiKey?: string,
 *   codebuddyBin?: string,
 *   codebuddyCompactInstructions?: string,
 *   codebuddyChatEnabledModels?: string[],
 *   deepseekApiKey?: string,
 *   deepseekBin?: string,
 *   deepseekCompaction?: { thresholdRatio?: number, retainRatio?: number },
 *   deepseekChatEnabledModels?: string[],
 *   mistralApiKey?: string,
 *   mistralVibeApiKey?: string,
 *   mistralBillingMode?: 'auto' | 'vibe_code' | 'api',
 *   mistralBaseUrl?: string,
 *   mistralChatEnabledModels?: string[],
 *   codexApiKey?: string,
 *   codexAuthMode?: 'chatgpt' | 'api-key',
 *   codexBin?: string,
 *   codexCompaction?: { autoCompactTokenLimit?: number, postTurnCompactThresholdPercent?: number },
 *   codexChatEnabledModels?: string[],
 *   qwenApiKey?: string,
 *   qwenBin?: string,
 *   qwenBaseUrl?: string,
 *   qwenEndpoint?: 'payg' | 'token-plan' | 'coding-plan' | 'custom',
 *   qwenContextSettings?: {
 *     autoCompactThreshold?: number,
 *     clearContextOnIdle?: {
 *       toolResultsThresholdMinutes?: number,
 *       toolResultsNumToKeep?: number,
 *       toolResultsTotalCharsThreshold?: number,
 *     },
 *     enableCacheControl?: boolean,
 *   },
 *   qwenChatEnabledModels?: string[],
 *   claudeApiKey?: string,
 *   claudeAuthMode?: 'subscription' | 'api-key',
 *   claudeChatEnabledModels?: string[],
 *   claudePromptCaching1h?: boolean,
 *   claudeAutocompactPctOverride?: number,
 *   claudeDisableAutoCompact?: boolean,
 *   defaultNewChatHarness?: 'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'mistral' | 'zai' | 'mimo' | 'codex' | 'qwen' | 'claude',
 *   enabledHarnesses?: string[],
 *   enabledLocalHarnesses?: string[],
 *   harnessOrder?: string[],
 *   firstRunSetupDismissed?: boolean,
 *   externalMcpEnabled?: boolean,
 *   externalMcpAllowLan?: boolean,
 *   harnessPermissionControls?: Record<string, { enabled?: boolean, files?: boolean, mcp?: boolean, shell?: boolean, web?: boolean, other?: boolean }>,
 *   approvalBroker?: {
 *     mode?: 'off' | 'shadow' | 'local_reads',
 *     advisor?: {
 *       enabled?: boolean,
 *       protocol?: 'openai_chat' | 'systemone',
 *       baseUrl?: string,
 *       model?: string,
 *       minProbability?: number,
 *       timeoutMs?: number,
 *       dailyQuota?: number,
 *     }
 *   },
 *   approvalAdvisorApiKey?: string
 * }}
 */
export function loadSettings() {
  ensureDir();
  let data = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      data = typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      data = {};
    }
  }
  return withWorkspaceSections(data);
}

/**
 * Resolve any id of a stored workspace (its UUID, current id, or a former id such as
 * a `.code-workspace` path) to the registry id the rest of the app uses.
 *
 * @param {string} ref
 * @returns {string} registry id, or '' when unknown
 */
export function resolveWorkspaceAlias(ref) {
  return resolveWorkspaceRef(workspacesDataDir(), ref)?.id || '';
}

/**
 * Registry export in the shape config.json had before `store.workspaces` (rollback,
 * backup contract B1): the current config.json merged with the SQL sections.
 *
 * @returns {Record<string, any>}
 */
export function exportConfigWithWorkspaces() {
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
  } catch {
    config = {};
  }
  return exportWorkspaceSettingsToConfigShape(workspacesDataDir(), config);
}

/**
 * A parsed config.json completed with the workspace sections that live in SQL, for
 * readers of the raw file (settings backup preview/export). Unmigrated installs
 * return the config unchanged.
 *
 * @param {Record<string, any>} config parsed config.json
 * @returns {Record<string, any>}
 */
export function completeConfigWithWorkspaces(config) {
  const dataDir = workspacesDataDir();
  if (!isWorkspacesStoreMigrated(dataDir)) return config;
  // A section still present in the file (hand edit, restored copy) is what the file says;
  // SQL only fills the sections the file no longer carries.
  const filled = exportWorkspaceSettingsToConfigShape(dataDir, {}, { keepImportedFrom: true });
  const out = { ...config };
  for (const key of WORKSPACE_SETTINGS_KEYS) {
    if (out[key] === undefined && filled[key] !== undefined) out[key] = filled[key];
  }
  return out;
}

/**
 * Inverse of {@link completeConfigWithWorkspaces} for writers of the raw file: stores
 * the workspace sections of `config` in SQL and returns what belongs in config.json.
 *
 * @param {Record<string, any>} config
 * @returns {Record<string, any>}
 */
export function splitConfigWorkspaceSections(config) {
  const dataDir = workspacesDataDir();
  if (!config || typeof config !== 'object') return config;
  if (!hasWorkspaceSections(config) && !isWorkspacesStoreMigrated(dataDir)) return config;
  replaceWorkspaceSettings(dataDir, config);
  const rest = { ...config };
  for (const key of WORKSPACE_SETTINGS_KEYS) delete rest[key];
  return rest;
}

/** Directory holding config.json and the workspaces store. */
function workspacesDataDir() {
  return path.dirname(CONFIG_FILE);
}

/**
 * The workspace registry, sidebar overlay, route keys and extra context dirs are
 * served from the SQL workspaces store (`store.workspaces`), never from config.json.
 * The first load that still finds them in config.json migrates them once.
 *
 * @param {Record<string, any>} data parsed config.json
 * @returns {Record<string, any>}
 */
function withWorkspaceSections(data) {
  const dataDir = workspacesDataDir();
  migrateWorkspaceSettingsFromConfig(dataDir, data, { loadWorkspaceFn: loadWorkspace });
  if (!isWorkspacesStoreMigrated(dataDir)) return data;
  const next = { ...data };
  for (const key of WORKSPACE_SETTINGS_KEYS) delete next[key];
  return { ...next, ...readWorkspaceSettingsView(dataDir) };
}

/**
 * @param {{ lanHost?: string, workspaceFile?: string, workspaceFolder?: string, workspaces?: Array<{ id: string, kind: 'file' | 'folders', workspaceFile?: string, label?: string }>, workspaceSidebarConfig?: Record<string, WorkspaceSidebarConfigEntry>, additionalCursorContextDirs?: string[], agentTitlePrint?: boolean, debugStartup?: boolean, debugApi?: boolean, debugTasks?: boolean, debugOverlay?: boolean, debugUiFreeze?: boolean, debugRemote?: boolean, debugHttpTiming?: boolean, cursorApiKey?: string, sdkRunIdleTimeoutSeconds?: number, sdkRunStuckRecoveryCapSeconds?: number, sdkRunAutoRecovery?: boolean, chatEnabledModels?: string[] }} settings
 */
export function saveSettings(settings, options = {}) {
  assertNotRealDataDirUnderTest();
  ensureDir();
  const existing = readExistingConfigForGuard();
  const isEmptyWrite =
    settings === null || typeof settings !== 'object' || Object.keys(settings).length === 0;
  if (isEmptyWrite && !options?.allowEmpty && existing && Object.keys(existing).length > EMPTY_WRITE_GUARD_MAX_KEYS) {
    const err = new Error(
      `Refusing to overwrite ${Object.keys(existing).length} settings keys in config.json with an empty object; pass { allowEmpty: true } to confirm.`,
    );
    /** @type {any} */ (err).code = 'SETTINGS_EMPTY_WRITE_REFUSED';
    console.error(`[settings] ${err.message}`);
    throw err;
  }
  if (existing && Object.keys(existing).length > 0) rotateConfigBackups();
  // SQL first: a failed config write afterwards leaves a consistent registry.
  writeJsonAtomic(CONFIG_FILE, splitConfigWorkspaceSections(settings), 'utf8');
}

/** An empty write over a config with more keys than this needs `allowEmpty`. */
const EMPTY_WRITE_GUARD_MAX_KEYS = 3;
/** Number of rotated copies kept: config.json.bak, .bak.1, .bak.2. */
const CONFIG_BACKUP_COUNT = 3;

/**
 * Under `node --test` the config path must be isolated (CRETLI_DATA_DIR);
 * writing to the repository's real data/ would clobber operator settings.
 */
function assertNotRealDataDirUnderTest() {
  if (!process.env.NODE_TEST_CONTEXT) return;
  const realDataDir = path.resolve(resolveProjectPath('data'));
  if (path.resolve(path.dirname(CONFIG_FILE)) !== realDataDir) return;
  const err = new Error(
    `saveSettings refused under tests: ${CONFIG_FILE} is the real data/ directory. Import tests/helpers/isolated-data-dir.js first.`,
  );
  /** @type {any} */ (err).code = 'SETTINGS_REAL_DATA_DIR_IN_TEST';
  throw err;
}

/** @returns {Record<string, unknown> | null} parsed existing config, or null when absent/invalid */
function readExistingConfigForGuard() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Shift .bak -> .bak.1 -> .bak.2 and copy the current file to .bak (temp file + rename). */
function rotateConfigBackups() {
  try {
    const slot = (i) => (i === 0 ? `${CONFIG_FILE}.bak` : `${CONFIG_FILE}.bak.${i}`);
    for (let i = CONFIG_BACKUP_COUNT - 1; i >= 1; i -= 1) {
      if (fs.existsSync(slot(i - 1))) fs.renameSync(slot(i - 1), slot(i));
    }
    const tmp = `${slot(0)}.${process.pid}.${Date.now()}.tmp`;
    fs.copyFileSync(CONFIG_FILE, tmp);
    fs.renameSync(tmp, slot(0));
  } catch (err) {
    console.error(`[settings] config backup failed: ${err?.message || err}`);
  }
}

/** Who sets titles: the server generator, the agent via MCP chat_set_title, or both (server is the fallback). */
export const AUTO_TITLE_SOURCES = Object.freeze(['server', 'agent', 'both']);
export const AUTO_TITLE_MODES = Object.freeze(['off', 'first', 'continuous']);
/** Providers able to run a one-shot HTTP chat completion; 'auto' picks the first available one. */
export const AUTO_TITLE_PROVIDER_IDS = Object.freeze(['openrouter', 'deepseek', 'qwen', 'codex', 'claude']);
export const AUTO_TITLE_PROVIDERS = Object.freeze(['auto', ...AUTO_TITLE_PROVIDER_IDS]);
/** Cheap OpenRouter model used for background title generation unless autoTitle.model is set. */
export const DEFAULT_AUTO_TITLE_MODEL = 'openai/gpt-4o-mini';

/**
 * Server-side auto-title configuration (replaces the per-browser localStorage flags).
 *
 * @param {Record<string, any> | null} [settings] - loadSettings() result; loaded when omitted
 * @returns {{ mode: 'off' | 'first' | 'continuous', source: 'server' | 'agent' | 'both', provider: string, model: string }}
 */
export function getAutoTitleSettings(settings = null) {
  const raw = (settings || loadSettings()).autoTitle;
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const mode = typeof cfg.mode === 'string' && AUTO_TITLE_MODES.includes(cfg.mode) ? cfg.mode : 'first';
  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : DEFAULT_AUTO_TITLE_MODEL;
  const provider = typeof cfg.provider === 'string' && AUTO_TITLE_PROVIDERS.includes(cfg.provider) ? cfg.provider : 'auto';
  const source = typeof cfg.source === 'string' && AUTO_TITLE_SOURCES.includes(cfg.source) ? cfg.source : 'server';
  return { mode, source, provider, model };
}

/** Automatic chat archiving stays off until the operator opts in. */
export const CHAT_AUTO_ARCHIVE_DEFAULT_ENABLED = false;
/** Idle window used when the stored value/unit is missing or invalid. */
export const CHAT_AUTO_ARCHIVE_DEFAULT_VALUE = 30;
export const CHAT_AUTO_ARCHIVE_DEFAULT_UNIT = 'days';
/** Starred (favorite) chats stay out of the sweep unless the operator opts in. */
export const CHAT_AUTO_ARCHIVE_DEFAULT_SKIP_FAVORITES = true;
/** Allowed idle units; the UI offers the same three. */
export const CHAT_AUTO_ARCHIVE_UNITS = Object.freeze(['minutes', 'hours', 'days']);
export const CHAT_AUTO_ARCHIVE_UNIT_MS = Object.freeze({
  minutes: 60_000,
  hours: 60 * 60_000,
  days: 24 * 60 * 60_000,
});
/** Hard bounds accepted by the PATCH route: one minute to 365 days. */
export const CHAT_AUTO_ARCHIVE_MIN_MS = 60_000;
export const CHAT_AUTO_ARCHIVE_MAX_MS = 365 * 24 * 60 * 60_000;

/**
 * Largest whole value allowed for one unit without crossing the 365-day cap.
 *
 * @param {string} unit
 * @returns {number}
 */
export function chatAutoArchiveMaxValueForUnit(unit) {
  const unitMs = CHAT_AUTO_ARCHIVE_UNIT_MS[unit];
  return unitMs ? Math.floor(CHAT_AUTO_ARCHIVE_MAX_MS / unitMs) : 0;
}

/**
 * Idle-chat auto-archive configuration. Disabled by default; a missing or
 * out-of-range value/unit falls back to the default pair, so an old or corrupt
 * config.json can never archive chats on an unexpected schedule. The canonical
 * value for the sweep is `idleMs`.
 *
 * @param {Record<string, any> | null} [settings] - loadSettings() result; loaded when omitted
 * @returns {{ enabled: boolean, idleValue: number, idleUnit: 'minutes' | 'hours' | 'days', idleMs: number, skipFavorites: boolean }}
 */
/**
 * Account-level gate and default text for the Cursor SDK custom system prompt
 * (local agents only; chat-level override wins when set).
 *
 * @param {Record<string, any> | null | undefined} raw
 * @returns {{ enabled: boolean, text: string }}
 */
export function getSdkCustomSystemPromptSettings(raw = null) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const enabled = cfg.enabled === true;
  const text = enabled ? normalizeSdkSystemPromptText(cfg.text) : '';
  return { enabled, text };
}

/**
 * @param {any} value
 * @returns {{ enabled: boolean, text: string } | undefined}
 */
export function normalizeSdkCustomSystemPromptPatch(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') {
    return { enabled: false, text: '' };
  }
  const enabled = value.enabled === true;
  if (!enabled) {
    return { enabled: false, text: '' };
  }
  const text = normalizeSdkSystemPromptText(value.text);
  if (!text) {
    return { enabled: true, text: '' };
  }
  return {
    enabled: true,
    text: text.slice(0, SDK_SYSTEM_PROMPT_MAX_CHARS),
  };
}

/** Background npm update checks default off until Settings enables them (leaf 6). */
const HARNESS_UPDATE_CHECK_DEFAULT_ENABLED = false;

/**
 * @param {Record<string, any> | null} [settings]
 * @returns {{ enabled: boolean }}
 */
export function getHarnessUpdateCheckSettings(settings = null) {
  const raw = (settings || loadSettings()).harnessUpdateCheck;
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const enabled = typeof cfg.enabled === 'boolean'
    ? cfg.enabled
    : HARNESS_UPDATE_CHECK_DEFAULT_ENABLED;
  return { enabled };
}

export function getChatAutoArchiveSettings(settings = null) {
  const raw = (settings || loadSettings()).chatAutoArchive;
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const enabled = typeof cfg.enabled === 'boolean' ? cfg.enabled : CHAT_AUTO_ARCHIVE_DEFAULT_ENABLED;
  const unit = CHAT_AUTO_ARCHIVE_UNITS.includes(cfg.idleUnit) ? cfg.idleUnit : '';
  const value = Math.round(Number(cfg.idleValue));
  const valid = Boolean(unit)
    && Number.isFinite(value)
    && value >= 1
    && value <= chatAutoArchiveMaxValueForUnit(unit);
  const idleUnit = valid ? unit : CHAT_AUTO_ARCHIVE_DEFAULT_UNIT;
  const idleValue = valid ? value : CHAT_AUTO_ARCHIVE_DEFAULT_VALUE;
  const skipFavorites = typeof cfg.skipFavorites === 'boolean'
    ? cfg.skipFavorites
    : CHAT_AUTO_ARCHIVE_DEFAULT_SKIP_FAVORITES;
  return { enabled, idleValue, idleUnit, idleMs: idleValue * CHAT_AUTO_ARCHIVE_UNIT_MS[idleUnit], skipFavorites };
}
