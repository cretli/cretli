/**
 * Combined Codex credentials: ChatGPT plan session or Platform API key.
 */

import { getCodexAuthMode } from './codex-auth-mode.ts';
import { getEffectiveCodexApiKey } from './codex-api-key.ts';
import { hasCodexChatGptAuth } from './codex-chatgpt-auth.ts';

export function hasCodexCredentials(): boolean {
  if (getCodexAuthMode() === 'chatgpt') return hasCodexChatGptAuth();
  return !!getEffectiveCodexApiKey();
}
