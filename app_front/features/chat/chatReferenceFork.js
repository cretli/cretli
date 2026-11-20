/**
 * "New chat with reference" flow of the cheap-resume banner: a no-copy fork that
 * points at the parent chat. Mirrors the fork flow of the send-bar actions
 * (history flush, widget pin, composer draft) with injected dependencies.
 */

/**
 * @param {Record<string, any>} parentChat
 * @param {{
 *   flushPendingPush: (chatId: string, sessionId: string) => Promise<boolean>,
 *   postChatFork: (chatId: string, payload: object) => Promise<object>,
 *   postChatForkWithSummary?: (chatId: string, payload: object) => Promise<object>,
 *   onSummaryFallback?: (info: { code: string, error: string }) => void,
 *   pinCreatedChat: (chat: object) => Promise<void>,
 *   fillMissingContext: (created: object, parent: object) => void,
 *   readDraft: (chat: object) => string,
 *   clearDraft: (chat: object) => void,
 *   openForkChat: (chat: object, initialPrompt: string, displayText: string, options: { carriedDraft: boolean }) => unknown,
 *   defaultDisplayText: string,
 * }} deps
 * @param {{ withSummary?: boolean }} [options] `withSummary` opts in to the one cheap-model summary call
 * @returns {Promise<{ ok: boolean, code?: string, summaryFallback?: boolean }>}
 */
export async function createReferenceChat(parentChat, deps, options = {}) {
  if (!parentChat?.id) return { ok: false };
  // The draft is not embedded in the fork prompt: the new chat keeps it as the
  // composer text and the first send appends it (edited or not) exactly once.
  const draft = String(deps.readDraft(parentChat) || '').trim();
  let data;
  try {
    const synced = await deps.flushPendingPush(parentChat.id, parentChat.cursorSessionId || '');
    if (!synced) return { ok: false, code: 'sync_failed' };
    data = options.withSummary && deps.postChatForkWithSummary
      ? await deps.postChatForkWithSummary(parentChat.id, {})
      : await deps.postChatFork(parentChat.id, { mode: 'reference' });
  } catch {
    return { ok: false, code: 'network_error' };
  }
  if (!data?.ok || !data.chat) return { ok: false, code: data?.code || 'fork_failed' };
  deps.fillMissingContext(data.chat, parentChat);
  await deps.pinCreatedChat(data.chat);
  // The parent keeps its draft until the fork succeeded.
  deps.openForkChat(data.chat, data.initialPrompt || '', draft || deps.defaultDisplayText, { carriedDraft: draft !== '' });
  deps.clearDraft(parentChat);
  // The chat exists either way; a failed summary degrades to a plain reference chat and must be visible.
  const fallback = data.summaryFallback;
  if (fallback) deps.onSummaryFallback?.({ code: String(fallback.code || ''), error: String(fallback.error || '') });
  return fallback ? { ok: true, summaryFallback: fallback } : { ok: true };
}
