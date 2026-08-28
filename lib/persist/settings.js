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
 *   workspaceSidebarConfig?: Record<string, WorkspaceSidebarConfigEntry>,
 *   additionalCursorContextDirs?: string[],
 *   agentTitlePrint?: boolean,
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
 *   opencodeBin?: string,
 *   opencodePortBase?: number,
 *   opencodeChatEnabledModels?: string[],
 *   defaultNewChatHarness?: 'sdk' | 'openrouter' | 'opencode'
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
 * @param {{ lanHost?: string, workspaceFile?: string, workspaceFolder?: string, workspaceSidebarConfig?: Record<string, WorkspaceSidebarConfigEntry>, additionalCursorContextDirs?: string[], agentTitlePrint?: boolean, debugStartup?: boolean, debugApi?: boolean, debugTasks?: boolean, debugOverlay?: boolean, debugUiFreeze?: boolean, debugRemote?: boolean, debugHttpTiming?: boolean, frontHmrEnabled?: boolean, cursorApiKey?: string, sdkRunIdleTimeoutSeconds?: number, sdkRunStuckRecoveryCapSeconds?: number, sdkRunAutoRecovery?: boolean, chatEnabledModels?: string[] }} settings
 */
export function saveSettings(settings) {
  ensureDir();
  writeJsonAtomic(CONFIG_FILE, settings, 'utf8');
}
