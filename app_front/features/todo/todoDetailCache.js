/** Heavy fields a lean list row carries only in compact form. */
export const DETAIL_FIELDS = ['review', 'execution', 'integrationSummary', 'worktree', 'integration', 'leafMaterial'];

/**
 * Merge a cached full detail into a lean list row. Returns the lean row itself
 * when the cache is stale (revision, review generation, or chats moved since).
 *
 * @param {Record<string, any>} item lean list row
 * @param {Record<string, any> | undefined} detail cached detail
 * @returns {Record<string, any>}
 */
export function mergeCachedDetail(item, detail) {
  if (item?.listSlim !== true) return item;
  if (!detail || detail.updatedAt !== String(item.updatedAt || '')) return item;
  // A compact review the cached copy has outgrown must reload, not be shown stale.
  if (String(item.review?.generation ?? '') !== String(detail.review?.generation ?? '')) return item;
  const { listSlim, chatCount, chatLastAt, latestChat, agentChatIds, ...rest } = item;
  // Chats change without bumping updatedAt: reuse the cached records only while
  // the lean row agrees on count, newest chat and activity, else stay lean.
  const cachedChats = (Array.isArray(detail.chats) ? detail.chats : []).filter((c) => c && !c.deleted);
  const lastAt = cachedChats.map((c) => String(c.lastAt || '')).filter(Boolean).sort().pop() || '';
  const sameChats = cachedChats.length === (item.chatCount ?? 0)
    && String(cachedChats[0]?.id || '') === String(item.latestChat?.id || '')
    && lastAt === String(item.chatLastAt || '');
  if (!sameChats) return item;
  const full = { ...rest, chats: detail.chats, body: detail.body, plan: detail.plan, changelog: detail.changelog };
  // Lean rows carry compact variants of these; restore the full fields the editor card reads.
  for (const key of DETAIL_FIELDS) if (detail[key] !== undefined) full[key] = detail[key];
  return full;
}
