/**
 * Source chat transcript used to build the fork prompt (name / summary).
 */

import { loadChats } from './persist/chats-persist.js';
import { formatSdkAgentMessagesToBuffer } from './sdk/sdk-chat-history.js';
import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';
import { loadCursorSdk } from './sdk/cursor-sdk.js';

const MIN_FORK_TEXT_LEN = 80;

/**
 * @param {string} chatId
 * @param {string} clientText
 * @returns {Promise<string>}
 */
export async function resolveForkSourceText(chatId, clientText) {
  const trimmed = typeof clientText === 'string' ? clientText.trim() : '';
  if (trimmed.length >= MIN_FORK_TEXT_LEN) {
    return trimmed;
  }

  const chat = loadChats().find((c) => c && c.id === chatId);
  if (!chat) {
    return trimmed;
  }

  const agentId = chat.sdkAgentId && String(chat.sdkAgentId).trim();
  if (!agentId || !getEffectiveCursorApiKey()) {
    return trimmed;
  }

  try {
    const { Agent } = await loadCursorSdk();
    const rows = await Agent.messages.list(agentId, { limit: 200, offset: 0 });
    const formatted = formatSdkAgentMessagesToBuffer(Array.isArray(rows) ? rows : []);
    const fromSdk = typeof formatted === 'string' ? formatted.trim() : '';
    if (fromSdk.length >= MIN_FORK_TEXT_LEN) {
      return fromSdk;
    }
    if (fromSdk.length > trimmed.length) {
      return fromSdk;
    }
  } catch (_) {}

  return trimmed;
}

export { MIN_FORK_TEXT_LEN };
