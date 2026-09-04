/**
 * Combined Codex credentials: ChatGPT plan session or Platform API key.
 */

import { getCodexAuthMode } from './codex-auth-mode.js';
import { getEffectiveCodexApiKey } from './codex-api-key.js';
import { hasCodexChatGptAuth } from './codex-chatgpt-auth.js';

/**
 * @returns {boolean}
 */
export function hasCodexCredentials() {
  if (getCodexAuthMode() === 'chatgpt') return hasCodexChatGptAuth();
  return !!getEffectiveCodexApiKey();
}
