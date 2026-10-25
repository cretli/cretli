/**
 * View model of the "Context of this chat" panel. Pure: turns the content-free
 * snapshot / preview from /api/chat-context/* into display groups.
 */

/** Display order; `selected` is a flag on an entry, the rest map to `entry.state`. */
export const CONTEXT_PANEL_CATEGORIES = Object.freeze([
  'selected', 'delivered', 'available', 'unknown_native', 'error', 'overridden', 'disabled',
]);

/**
 * @param {Record<string, any> | null | undefined} snapshot
 * @returns {{ id: string, entries: Record<string, any>[] }[]}
 */
export function groupContextEntries(snapshot) {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  return CONTEXT_PANEL_CATEGORIES.map((id) => ({
    id,
    entries: entries.filter((row) => (id === 'selected' ? row.selected === true : row.state === id)),
  }));
}

/**
 * Compare the last real send with the next-send preview.
 *
 * @param {Record<string, any> | null | undefined} latest
 * @param {Record<string, any> | null | undefined} preview
 * @returns {'no_send' | 'same' | 'changed'}
 */
export function compareSendWithPreview(latest, preview) {
  if (!latest || !preview) return 'no_send';
  return latest.revision === preview.revision ? 'same' : 'changed';
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatContextSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}
