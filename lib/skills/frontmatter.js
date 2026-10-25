/**
 * Minimal, dependency-light frontmatter reader shared by skill metadata and
 * Cursor rule files.
 *
 * The previous implementation read `name:` and `description:` with a single
 * line regex, so a block scalar (`description: >-`) produced no description at
 * all — the catalog showed the folder name with an empty purpose, or the raw
 * YAML marker. Frontmatter is YAML, so it is parsed as YAML: `js-yaml` (safe
 * default schema, no custom types) handles quoted, single-line and block
 * scalars (`>`, `>-`, `|`, `|-`).
 *
 * A malformed block must never break catalog or rule collection, so a failed
 * parse falls back to a tolerant line scanner that still resolves simple keys
 * and block scalars. Both paths return a plain object; callers validate.
 */
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';

/** Leading `---` … `---` block. Anchored so only real frontmatter matches. */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Block scalar indicators: `>`, `>-`, `|`, `|-` (with optional indent hint). */
const BLOCK_SCALAR_INDICATOR = /^[|>][+-]?\d*$/;

/**
 * @param {unknown} content
 * @returns {string | null} The raw frontmatter text, or null when absent.
 */
export function extractFrontmatterBlock(content) {
  const match = String(content || '').match(FRONTMATTER_PATTERN);
  return match ? match[1] : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stripQuotes(value) {
  const text = String(value || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) return text.slice(1, -1);
  }
  return text;
}

/**
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseFrontmatterStrict(raw) {
  try {
    const doc = loadYaml(raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    return /** @type {Record<string, unknown>} */ (doc);
  } catch {
    return null;
  }
}

/**
 * Tolerant line scanner used when the block is not valid YAML. It resolves
 * `key: value` pairs plus indented block-scalar bodies, so a partially broken
 * frontmatter still yields the metadata instead of dropping the whole entry.
 *
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
function parseFrontmatterTolerant(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  let key = null;
  let blockLines = null;
  const store = (name, value) => {
    if (name) out[name] = value;
  };
  const flush = () => {
    if (key === null) return;
    store(key, blockLines === null ? '' : blockLines.join(' ').replace(/\s+/g, ' ').trim());
    key = null;
    blockLines = null;
  };
  for (const line of String(raw).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:[ \t]*(.*)$/);
    if (match) {
      flush();
      key = match[1];
      const value = match[2].trim();
      if (!value || BLOCK_SCALAR_INDICATOR.test(value)) {
        blockLines = [];
        continue;
      }
      store(key, stripQuotes(value));
      key = null;
      continue;
    }
    if (key !== null && /^[ \t]+\S/.test(line)) {
      blockLines.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return out;
}

/**
 * Parse the frontmatter of a skill or rule file.
 *
 * @param {unknown} content Full file content.
 * @returns {Record<string, unknown> | null} Parsed mapping, or null when the
 *   file has no frontmatter block.
 */
export function parseFrontmatter(content) {
  const raw = extractFrontmatterBlock(content);
  if (raw === null) return null;
  return parseFrontmatterStrict(raw) || parseFrontmatterTolerant(raw);
}

/**
 * Read one frontmatter value as a string. Non-scalar values (lists, maps) are
 * not usable as a name/description and read as ''.
 *
 * @param {Record<string, unknown> | null | undefined} frontmatter
 * @param {string} key
 * @returns {string}
 */
export function frontmatterString(frontmatter, key) {
  const value = frontmatter ? frontmatter[key] : undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Collapse whitespace so a block scalar becomes one catalog line. Also drops a
 * value that is only a YAML block marker, which is never a real description.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function oneLineFrontmatterValue(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || BLOCK_SCALAR_INDICATOR.test(text)) return '';
  return text;
}

/** Largest frontmatter block the registry will hand to the YAML parser. */
export const FRONTMATTER_MAX_BYTES = 8 * 1024;

/**
 * Strict frontmatter read for the context registry. Unlike `parseFrontmatter`
 * it never falls back to the tolerant scanner: a block that is not valid YAML
 * is reported as `malformed` so the entry can be shown with a diagnostic and
 * kept out of the prompt.
 *
 * - `JSON_SCHEMA` keeps scalars as written (no timestamps, binary or merge
 *   keys); `js-yaml` v4 never evaluates code with any of its schemas.
 * - The block size is checked before parsing, which also bounds alias expansion.
 * - A file with no closing `---` has no frontmatter (same as `parseFrontmatter`).
 *
 * @param {unknown} content Full file content.
 * @param {{ maxBytes?: number }} [options]
 * @returns {{
 *   status: 'absent' | 'ok' | 'malformed' | 'too_large',
 *   data: Record<string, unknown> | null,
 *   body: string,
 *   error?: string,
 * }}
 */
export function parseFrontmatterChecked(content, options = {}) {
  const text = String(content || '');
  const match = text.match(FRONTMATTER_PATTERN);
  if (!match) return { status: 'absent', data: null, body: text.trim() };
  const body = text.slice(match[0].length).trim();
  const raw = match[1];
  const limit = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : FRONTMATTER_MAX_BYTES;
  if (Buffer.byteLength(raw, 'utf8') > limit) {
    return { status: 'too_large', data: null, body, error: `Frontmatter exceeds ${limit} bytes` };
  }
  try {
    const doc = loadYaml(raw, { schema: JSON_SCHEMA });
    if (doc === undefined || doc === null) return { status: 'ok', data: {}, body };
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return { status: 'malformed', data: null, body, error: 'Frontmatter must be a YAML mapping' };
    }
    return { status: 'ok', data: /** @type {Record<string, unknown>} */ (doc), body };
  } catch (err) {
    const reason = String(/** @type {any} */ (err)?.reason || 'invalid YAML');
    return { status: 'malformed', data: null, body, error: `Invalid frontmatter YAML: ${reason}` };
  }
}
