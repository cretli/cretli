/**
 * Server settings (for example the LAN host used for the link/QR code).
 * data/config.json: { lanHost?: string, frontHmrEnabled?: boolean }
 */

import fs from 'fs';
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
