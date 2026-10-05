/**
 * Human-readable labels for `tool_search` / `ToolSearch` results.
 * Qwen's CLI returnDisplay is opaque ("1 missing", "Loaded 5 tool(s)").
 * Claude's deferred-tool load returns `{"type":"tool_reference","tool_name":...}`.
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
 * @param {unknown} resultText
 * @returns {string}
 */
function toolSearchResultText(resultText) {
  if (typeof resultText === 'string') return resultText.trim();
  if (resultText && typeof resultText === 'object') {
    try {
      return JSON.stringify(resultText);
    } catch {
      return '';
    }
  }
  return resultText == null ? '' : String(resultText).trim();
}

/**
 * Claude ToolSearch success payload: one or more tool_reference blocks.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function readToolReferenceNames(raw) {
  if (!raw.startsWith('{') && !raw.startsWith('[')) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  if (blocks.length === 0) return [];
  const names = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const rec = /** @type {Record<string, unknown>} */ (block);
    if (rec.type !== 'tool_reference') return [];
    const name = typeof rec.tool_name === 'string' ? rec.tool_name.trim() : '';
    if (!name) return [];
    names.push(name);
  }
  return names;
}

/**
 * @param {unknown} args
 * @param {unknown} resultText
 * @returns {string}
 */
export function formatToolSearchResult(args, resultText) {
  const query = readToolSearchQuery(args);
  const target = parseToolSearchQuery(query);
  const raw = toolSearchResultText(resultText);
  if (!raw) return target ? `Not found: ${target}` : '';
  const referenced = readToolReferenceNames(raw);
  if (referenced.length > 0) {
    return `Loaded ${referenced.length} tool(s) for ${referenced.join(', ')}`;
  }
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

/**
 * One ToolSearch tile update.
 * An in-flight call with no payload is not a miss. Claude emits tool_use
 * before the tool_reference result, and a premature "Not found" sticks:
 * tool status can move from completed to error, but not back.
 *
 * @param {{ status?: unknown, args?: unknown, result?: unknown, open?: boolean }} input
 * @returns {{ status: string, result: unknown }}
 */
export function presentToolSearchUpdate(input) {
  const status = String(input?.status || '');
  const open = input?.open === true;
  const raw = toolSearchResultText(input?.result);
  if (open && !raw) {
    return { status, result: input?.result ?? '' };
  }
  const formatted = formatToolSearchResult(input?.args, input?.result);
  if (isFailedToolSearchResult(formatted)) {
    return { status: 'error', result: formatted };
  }
  return { status, result: formatted };
}
