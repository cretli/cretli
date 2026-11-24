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
 * Short name of an entry plus its folder, so a long path reads at a glance:
 * `.agents/skills/cretli-ui/SKILL.md` → `cretli-ui` in `.agents/skills`.
 *
 * @param {Record<string, any>} row
 * @returns {{ label: string, folder: string }}
 */
export function describeContextEntry(row) {
  const path = String(row?.relPath || row?.id || '').replace(/\\/g, '/');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return { label: '—', folder: '' };
  let file = parts.pop() || '';
  // A skill is named by its directory, not by the shared SKILL.md file name.
  if (/^skill\.md$/i.test(file) && parts.length) file = parts.pop() || file;
  return { label: file.replace(/\.(mdc|md)$/i, ''), folder: parts.join('/') };
}

/**
 * @param {Record<string, any>[]} entries
 * @returns {number} summed `sizeBytes` of the entries that report one
 */
export function sumContextEntryBytes(entries) {
  return (Array.isArray(entries) ? entries : [])
    .reduce((total, row) => total + (Number.isFinite(Number(row?.sizeBytes)) ? Math.max(0, Number(row.sizeBytes)) : 0), 0);
}

/**
 * Split one category by reason, keeping first-seen order, so the reason is a
 * sub-heading instead of a label repeated on every row.
 *
 * @param {Record<string, any>[]} entries
 * @returns {{ reason: string, entries: Record<string, any>[] }[]}
 */
export function splitContextEntriesByReason(entries) {
  /** @type {Map<string, Record<string, any>[]>} */
  const byReason = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const reason = String(row?.reason || '');
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)?.push(row);
  }
  return [...byReason].map(([reason, rows]) => ({ reason, entries: rows }));
}

/**
 * Bytes a category puts into the message. A catalog entry sends only its name
 * and description, so its file size is not counted.
 *
 * @param {Record<string, any>[]} entries
 * @returns {number}
 */
export function sumInlinedContextBytes(entries) {
  return sumContextEntryBytes((Array.isArray(entries) ? entries : []).filter((row) => row?.reason !== 'catalog'));
}

/**
 * Translated reason of an entry, or the raw code when no translation exists.
 *
 * @param {(key: string) => string} translate
 * @param {unknown} reason
 * @returns {string}
 */
export function formatContextEntryReason(translate, reason) {
  const code = String(reason || '').trim();
  if (!code) return '';
  const key = `chat.ctxPanelReason_${code}`;
  const label = translate(key);
  return label === key ? code : label;
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
