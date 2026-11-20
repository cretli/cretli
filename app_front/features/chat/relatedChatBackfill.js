/**
 * Placement plan for metadata-driven parent/child chat link backfill.
 *
 * A child link belongs next to the delegation card that created the child. Its
 * own history record paints inline as soon as the mounted history window reaches
 * it. Backfilling every child from chat metadata appended all older links at the
 * stream tail after a PWA resume, because the mounted window only holds the last
 * few records. An unanchored child is therefore skipped, never appended.
 */

/**
 * @typedef {{ chatId?: string, title?: string, reason?: string }} RelatedChatChild
 */

/**
 * @param {{
 *   children?: RelatedChatChild[],
 *   hasRelatedCard: (chatId: string) => boolean,
 *   findAnchor: (chatId: string) => unknown,
 * }} input
 * @returns {Array<{ child: RelatedChatChild, chatId: string, anchor: unknown }>}
 */
export function planRelatedChatChildBackfill(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const children = Array.isArray(source.children) ? source.children : [];
  const hasRelatedCard = typeof source.hasRelatedCard === 'function'
    ? source.hasRelatedCard
    : () => false;
  const findAnchor = typeof source.findAnchor === 'function' ? source.findAnchor : () => null;
  const plan = [];
  for (const child of children) {
    const chatId = String(child?.chatId || '').trim();
    if (!chatId) continue;
    if (hasRelatedCard(chatId)) continue;
    const anchor = findAnchor(chatId);
    if (!anchor) continue;
    plan.push({ child, chatId, anchor });
  }
  return plan;
}
