/**
 * Resolves a spoken task label against the workspace task list.
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeSpoken(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * @param {string[]} labels
 * @param {string} spoken
 * @returns {{ match?: string|null, ambiguous?: boolean, candidates?: string[] }}
 */
export function matchTaskBySpokenLabel(labels, spoken) {
  const needle = normalizeSpoken(spoken);
  if (!needle) return { match: null };
  const items = Array.isArray(labels)
    ? labels.map((label) => String(label || '').trim()).filter(Boolean)
    : [];
  const exact = items.filter((label) => normalizeSpoken(label) === needle);
  if (exact.length === 1) return { match: exact[0] };
  if (exact.length > 1) return { ambiguous: true, candidates: exact };
  const partial = items.filter((label) => {
    const value = normalizeSpoken(label);
    if (needle.length >= 2 && value.includes(needle)) return true;
    if (value.length >= 4 && needle.includes(value)) return true;
    return false;
  });
  if (partial.length === 1) return { match: partial[0] };
  if (partial.length > 1) return { ambiguous: true, candidates: partial.slice(0, 12) };
  return { match: null };
}
