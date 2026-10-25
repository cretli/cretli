import { resolvePersistedLocalChatHarnessDisplay } from '../../chat/persistedLocalChatState.js';

/**
 * Harness icon file for a sidebar chat row.
 *
 * A persisted local chat whose plugin is unavailable/disabled/incompatible must not show
 * a built-in brand icon (the default would suggest Cursor), so it resolves to `''` and the
 * row renders the neutral `--local` badge with only the localized title tooltip.
 *
 * @param {{ agentTransport?: unknown, harnessState?: { code?: unknown } | null } | null | undefined} chat
 * @returns {string} icon file name under /harness-icons, or '' for no image
 */
export function resolveSidebarHarnessIcon(chat) {
  if (resolvePersistedLocalChatHarnessDisplay(chat).blocked) return '';
  const harness = String(chat?.agentTransport || 'sdk').trim().toLowerCase();
  return ({
    sdk: 'cursor.svg',
    'cursor-sdk': 'cursor.svg',
    openrouter: 'openrouter.svg',
    opencode: 'opencode.svg',
    codebuddy: 'codebuddy.svg',
    deepseek: 'deepseek.svg',
    mistral: 'mistral.svg',
    zai: 'zai.svg',
    mimo: 'mimo.svg',
    codex: 'codex.svg',
    qwen: 'qwen.svg',
    claude: 'claude.svg',
  })[harness] || 'cursor.svg';
}
