/**
 * Payload for clickable parent/child chat history links.
 */

/**
 * @param {unknown} payload
 * @returns {{ role: 'parent' | 'child', chatId: string, title: string, reason: string } | null}
 */
export function parseRelatedChatPayload(payload) {
  const data = decodeRelatedChatPayload(payload);
  if (!data) return null;
  const chatId = String(data.chatId || '').trim();
  if (!chatId) return null;
  const role = data.role === 'parent' ? 'parent' : data.role === 'child' ? 'child' : '';
  if (!role) return null;
  return {
    role,
    chatId,
    title: String(data.title || '').trim(),
    reason: String(data.reason || '').trim(),
  };
}

/**
 * @param {unknown} payload
 * @returns {Record<string, unknown> | null}
 */
function decodeRelatedChatPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return /** @type {Record<string, unknown>} */ (payload);
  }
  if (typeof payload !== 'string' || !payload.trim()) return null;
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
