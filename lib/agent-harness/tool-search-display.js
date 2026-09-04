/**
 * Human-readable labels for Qwen (and similar) `tool_search` results.
 * CLI returnDisplay is opaque ("1 missing", "Loaded 5 tool(s)").
 */

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export function isToolSearchName(name) {
  const raw = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  return raw === 'toolsearch';
}

/**
 * @param {unknown} query
 * @returns {string}
 */
export function parseToolSearchQuery(query) {
  const raw = String(query || '').trim();
  if (!raw) return '';
  const select = raw.match(/^select:\s*(.+)$/i);
  if (!select) return raw;
  const first = select[1].split(',')[0].trim();
  return first || raw;
}

/**
 * @param {unknown} args
 * @returns {string}
 */
export function readToolSearchQuery(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const rec = /** @type {Record<string, unknown>} */ (args);
  return typeof rec.query === 'string' ? rec.query.trim() : '';
}

/**
 * @param {unknown} resultText
 * @returns {boolean}
 */
export function isFailedToolSearchResult(resultText) {
  const raw = String(resultText || '').trim();
  if (!raw) return false;
  if (/^not found:/i.test(raw)) return true;
  if (/^\d+\s+missing$/i.test(raw)) return true;
  if (/\bmissing\b/i.test(raw) && !/\bloaded\b/i.test(raw)) return true;
  return false;
}

/**
 * @param {unknown} args
 * @param {unknown} resultText
 * @returns {string}
 */
export function formatToolSearchResult(args, resultText) {
  const query = readToolSearchQuery(args);
  const target = parseToolSearchQuery(query);
  const raw = String(resultText || '').trim();
  if (!raw) return target ? `Not found: ${target}` : '';
  if (isFailedToolSearchResult(raw)) {
    if (target) return `Not found: ${target}`;
    if (query) return `Not found: ${query}`;
    return raw;
  }
  const loaded = raw.match(/^Loaded\s+(\d+)\s+tool/i);
  if (loaded && target) return `Loaded ${loaded[1]} tool(s) for ${target}`;
  if (target && raw && !raw.includes(target)) return `${target}: ${raw}`;
  return raw;
}
