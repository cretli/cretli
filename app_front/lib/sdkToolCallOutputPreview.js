/**
 * Bounded DOM preview for large tool_call args/result (UI freeze stage 5.2 fix).
 *
 * Full payloads stay in the in-memory report store; the chat history record is
 * never truncated. Only the mounted preview is capped (same budgets as delegation
 * reports in stage 3).
 */

import {
  buildHistoryCardReportViewModel,
  measureUtf8ByteLength,
  truncateUtf8Text,
} from './delegationHistoryCardReport.js';
import {
  UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES,
  UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES,
} from './uiFreezeRenderBudgets.js';

export {
  UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES,
  UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES,
};

/** Keys surfaced above stdout preview (never stdout/stderr/output). */
const TOOL_RESULT_META_KEYS = Object.freeze([
  'exitCode',
  'code',
  'signal',
  'durationMs',
  'duration',
  'success',
  'ok',
  'error',
  'status',
]);

const TOOL_RESULT_META_MAX_STRING_CHARS = 200;
const TOOL_RESULT_META_LINE_UTF8_BYTES = 512;

/** @typedef {{ text: string, truncated: boolean, utf8Bytes: number }} ToolFieldPreview */

/**
 * @param {unknown} result
 * @returns {string | null}
 */
export function extractPrimaryToolOutputText(result) {
  if (result == null) return null;
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return null;
  const root = /** @type {Record<string, unknown>} */ (result);
  if (typeof root.stdout === 'string' && root.stdout.length > 0) return root.stdout;
  if (typeof root.stderr === 'string' && root.stderr.length > 0) return root.stderr;
  if (typeof root.output === 'string' && root.output.length > 0) return root.output;
  const value = root.value;
  if (value && typeof value === 'object') {
    const nested = /** @type {Record<string, unknown>} */ (value);
    if (typeof nested.stdout === 'string' && nested.stdout.length > 0) return nested.stdout;
    if (typeof nested.stderr === 'string' && nested.stderr.length > 0) return nested.stderr;
    if (typeof nested.output === 'string' && nested.output.length > 0) return nested.output;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} source
 * @param {Record<string, string | number | boolean>} into
 * @param {Set<string>} seenKeys
 */
function collectToolResultMetaFromObject(source, into, seenKeys) {
  for (const key of TOOL_RESULT_META_KEYS) {
    if (seenKeys.has(key) || !Object.prototype.hasOwnProperty.call(source, key)) continue;
    const raw = source[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'boolean' || typeof raw === 'number') {
      into[key] = raw;
      seenKeys.add(key);
      continue;
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > TOOL_RESULT_META_MAX_STRING_CHARS) continue;
      into[key] = trimmed;
      seenKeys.add(key);
    }
  }
}

/**
 * Structural fields kept in the report store but omitted from the stdout preview path.
 *
 * @param {unknown} result
 * @returns {Record<string, string | number | boolean> | null}
 */
export function extractToolResultMeta(result) {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return null;
  const root = /** @type {Record<string, unknown>} */ (result);
  const meta = Object.create(null);
  const seenKeys = new Set();
  collectToolResultMetaFromObject(root, meta, seenKeys);
  const nested = root.value;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    collectToolResultMetaFromObject(/** @type {Record<string, unknown>} */ (nested), meta, seenKeys);
  }
  return Object.keys(meta).length > 0 ? meta : null;
}

/**
 * @param {Record<string, string | number | boolean>} meta
 * @param {number} [maxUtf8Bytes]
 * @returns {string}
 */
export function formatToolResultMetaLine(meta, maxUtf8Bytes = TOOL_RESULT_META_LINE_UTF8_BYTES) {
  const parts = [];
  for (const key of TOOL_RESULT_META_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(meta, key)) continue;
    const value = meta[key];
    parts.push(`${key}=${typeof value === 'string' ? value : String(value)}`);
  }
  const line = parts.join(' · ');
  if (!line) return '';
  const slice = truncateUtf8Text(line, maxUtf8Bytes);
  return slice.truncated ? `${slice.text}…` : slice.text;
}

/**
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {unknown}
 */
export function shallowTruncateStringsForJson(value, maxChars) {
  const limit = Math.max(0, Number(maxChars) || 0);
  if (value == null) return value;
  if (typeof value === 'string') {
    if (limit <= 0) return '';
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => shallowTruncateStringsForJson(entry, maxChars));
  }
  const source = /** @type {Record<string, unknown>} */ (value);
  const out = Object.create(null);
  for (const key of Object.keys(source)) {
    out[key] = shallowTruncateStringsForJson(source[key], maxChars);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} [maxUtf8Bytes]
 * @returns {ToolFieldPreview}
 */
export function buildBoundedToolJsonPreview(value, maxUtf8Bytes = UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES) {
  if (value == null) {
    return { text: '', truncated: false, utf8Bytes: 0 };
  }
  const primary = extractPrimaryToolOutputText(value);
  if (typeof primary === 'string' && primary.length > 0) {
    const slice = truncateUtf8Text(primary, maxUtf8Bytes);
    return {
      text: slice.text,
      truncated: slice.truncated,
      utf8Bytes: slice.utf8Bytes,
    };
  }
  const limit = Math.max(256, Number(maxUtf8Bytes) || UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES);
  const maxChars = Math.min(8192, Math.max(512, Math.floor(limit / 2)));
  let serialized = '';
  try {
    serialized = JSON.stringify(shallowTruncateStringsForJson(value, maxChars), null, 2);
  } catch {
    serialized = String(value);
  }
  const slice = truncateUtf8Text(serialized, limit);
  return {
    text: slice.text,
    truncated: slice.truncated,
    utf8Bytes: slice.utf8Bytes,
  };
}

/**
 * @param {string} fullText
 * @param {number} [previewUtf8Bytes]
 * @returns {{ useReportHost: boolean, previewText: string, contentKey: string, fullUtf8Bytes: number, isTruncated: boolean }}
 */
export function resolveToolOutputPreviewModel(fullText, previewUtf8Bytes = UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES) {
  const text = String(fullText || '');
  const fullUtf8Bytes = measureUtf8ByteLength(text);
  const previewLimit = Number(previewUtf8Bytes) || UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES;
  if (fullUtf8Bytes <= previewLimit) {
    return {
      useReportHost: false,
      previewText: text,
      contentKey: '',
      fullUtf8Bytes,
      isTruncated: false,
    };
  }
  const model = buildHistoryCardReportViewModel({ fullText: text, previewUtf8Bytes: previewLimit });
  return {
    useReportHost: true,
    previewText: model.previewText,
    contentKey: model.contentKey,
    fullUtf8Bytes: model.fullUtf8Bytes,
    isTruncated: model.isTruncated,
  };
}

/**
 * @param {string} fullText
 * @param {{
 *   escapeHtml: (value: string) => string,
 *   t: (key: string, params?: Record<string, string>) => string,
 *   buildReportHostHtml: (text: string) => string,
 * }} deps
 * @returns {string}
 */
export function buildToolOutputResultSectionHtml(fullText, deps) {
  const model = resolveToolOutputPreviewModel(fullText);
  if (!model.useReportHost) {
    const safe = deps.escapeHtml(model.previewText);
    return [
      `<details class="sdk-rich-nested" open>`,
      `<summary>${deps.escapeHtml(deps.t('sdkView.result'))}</summary>`,
      `<pre class="sdk-rich-json">${safe}</pre>`,
      '</details>',
    ].join('');
  }
  const host = deps.buildReportHostHtml(fullText);
  return [
    `<details class="sdk-rich-nested sdk-rich-tool-result-details" open>`,
    `<summary>${deps.escapeHtml(deps.t('sdkView.result'))}</summary>`,
    host,
    '</details>',
  ].join('');
}
