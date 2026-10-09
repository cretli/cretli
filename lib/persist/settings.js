/**
 * Server settings (for example the LAN host used for the link/QR code).
 * data/config.json: { lanHost?: string, frontHmrEnabled?: boolean }
 */

import fs from 'fs';
import {
  SDK_SYSTEM_PROMPT_MAX_CHARS,
  normalizeSdkSystemPromptText,
} from '../sdk/sdk-system-prompt.js';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

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
 *   label?: string
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
 *   chatAutoArchive?: { enabled?: boolean, idleValue?: number, idleUnit?: 'minutes' | 'hours' | 'days' },
 *   harnessUpdateCheck?: { enabled?: boolean },
 *   debugStartup?: boolean,
 *   debugApi?: boolean,
 *   debugTasks?: boolean,
 *   debugOverlay?: boolean,
 *   debugUiFreeze?: boolean,
 *   debugRemote?: boolean,
 *   debugHttpTiming?: boolean,
 *   frontHmrEnabled?: boolean,
 *   cursorApiKey?: string,
 *   openrouterApiKey?: string,
 *   openrouterSiteUrl?: string,
 *   openrouterAppTitle?: string,
 *   sdkRunIdleTimeoutSeconds?: number,
 *   sdkRunStuckRecoveryCapSeconds?: number,
 *   sdkRunAutoRecovery?: boolean,
 *   sdkCustomSystemPrompt?: { enabled?: boolean, text?: string },
 *   chatEnabledModels?: string[],
 *   openrouterChatEnabledModels?: string[],
   *   opencodeApiKey?: string,
 *   opencodeZaiApiKey?: string,
 *   opencodeMimoApiKey?: string,
 *   opencodeMimoBaseUrl?: string,
   *   opencodeZaiProvider?: 'zai-coding-plan' | 'zai',
 *   opencodeBin?: string,
 *   opencodePortBase?: number,
 *   opencodeChatEnabledModels?: string[],
 *   codebuddyApiKey?: string,
 *   codebuddyBin?: string,
 *   codebuddyChatEnabledModels?: string[],
 *   deepseekApiKey?: string,
 *   deepseekBin?: string,
 *   deepseekChatEnabledModels?: string[],
 *   codexApiKey?: string,
 *   codexAuthMode?: 'chatgpt' | 'api-key',
 *   codexBin?: string,
 *   codexChatEnabledModels?: string[],
 *   qwenApiKey?: string,
 *   qwenBin?: string,
 *   qwenBaseUrl?: string,
 *   qwenEndpoint?: 'payg' | 'token-plan' | 'coding-plan' | 'custom',
 *   qwenChatEnabledModels?: string[],
 *   claudeApiKey?: string,
 *   claudeChatEnabledModels?: string[],
 *   defaultNewChatHarness?: 'sdk' | 'openrouter' | 'opencode' | 'codebuddy' | 'deepseek' | 'codex' | 'qwen' | 'claude',
 *   enabledHarnesses?: string[],
 *   enabledLocalHarnesses?: string[],
 *   harnessOrder?: string[],
 *   firstRunSetupDismissed?: boolean,
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
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return typeof data === 'object' && data !== null ? data : {};
  } catch {
    return {};
  }
}

/**
 * @param {{ lanHost?: string, workspaceFile?: string, workspaceFolder?: string, workspaces?: Array<{ id: string, kind: 'file' | 'folders', workspaceFile?: string, label?: string }>, workspaceSidebarConfig?: Record<string, WorkspaceSidebarConfigEntry>, additionalCursorContextDirs?: string[], agentTitlePrint?: boolean, debugStartup?: boolean, debugApi?: boolean, debugTasks?: boolean, debugOverlay?: boolean, debugUiFreeze?: boolean, debugRemote?: boolean, debugHttpTiming?: boolean, frontHmrEnabled?: boolean, cursorApiKey?: string, sdkRunIdleTimeoutSeconds?: number, sdkRunStuckRecoveryCapSeconds?: number, sdkRunAutoRecovery?: boolean, chatEnabledModels?: string[] }} settings
 */
export function saveSettings(settings) {
  ensureDir();
  writeJsonAtomic(CONFIG_FILE, settings, 'utf8');
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
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
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
 * @param {object | null} [settings] - loadSettings() result; loaded when omitted
 * @returns {{ enabled: boolean, idleValue: number, idleUnit: 'minutes' | 'hours' | 'days', idleMs: number }}
 */
/**
 * Account-level gate and default text for the Cursor SDK custom system prompt
 * (local agents only; chat-level override wins when set).
 *
 * @param {object | null | undefined} raw
 * @returns {{ enabled: boolean, text: string }}
 */
export function getSdkCustomSystemPromptSettings(raw = null) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const enabled = cfg.enabled === true;
  const text = enabled ? normalizeSdkSystemPromptText(cfg.text) : '';
  return { enabled, text };
}

/**
 * @param {unknown} value
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
 * @param {object | null} [settings]
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
  return { enabled, idleValue, idleUnit, idleMs: idleValue * CHAT_AUTO_ARCHIVE_UNIT_MS[idleUnit] };
}
