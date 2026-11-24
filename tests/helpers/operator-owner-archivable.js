import { createChatArchivable } from '../../lib/chat-archive-policy.js';

/** Archive-policy gate with a run that is confirmed idle (no real adapter probe). */
export function isChatArchivable(chat) {
  return createChatArchivable({ now: Date.parse('2026-11-11T10:00:00.000Z'), isChatRunConfirmedIdle: () => true })(chat);
}
