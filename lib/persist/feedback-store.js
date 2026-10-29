/**
 * Create-only store for MCP feedback reports (bug / missing tool / idea / docs).
 *
 * A thin layer over `todos-persist.js`. The only operations are:
 *   - create an `idea` todo under the fixed "MCP reports" root, or
 *   - bump the counter of an already open duplicate.
 * It never assigns an executor, never sets another status and never reads or
 * touches todos outside that root.
 *
 * The root always lives in the Cretli repository workspace (the project the
 * server runs from), whatever workspace the reporting client works in. The
 * client's workspace is recorded only in the report's source metadata.
 *
 * Todos have no free-form metadata field, so the machine-readable record is a
 * one-line HTML comment at the top of the todo body.
 */

import { createHash } from 'node:crypto';
import { resolveProjectPath } from '../runtime-paths.js';
import { cleanClientText, frameUntrusted } from './feedback-sanitize.js';
import { MAX_BODY_LEN } from './todos-persist.js';
import { listTodos, addTodo, updateTodo } from './todos-store.js';
import { FEEDBACK_ROOT_MARKER } from '../feedback-marker.js';
export { FEEDBACK_ROOT_MARKER, isUnderFeedbackRoot, isFeedbackDerivedTodo } from '../feedback-marker.js';

export const FEEDBACK_ROOT_TITLE = 'Zgłoszenia z MCP';
/** Fixed marker that identifies the root todo (the title may be renamed by a human). */
export const FEEDBACK_KINDS = Object.freeze(['bug', 'missing_tool', 'idea', 'docs']);
export const FEEDBACK_SEVERITIES = Object.freeze(['low', 'medium', 'high']);
export const FEEDBACK_LIMITS = Object.freeze({ tool: 100, summary: 200, details: 4000, repro: 2000 });
export const FEEDBACK_MAX_OPEN = 200;
export const FEEDBACK_MAX_SOURCES = 8;

const META_PREFIX = '<!-- cretli-feedback ';
const META_SUFFIX = ' -->';
const SOURCE_FIELD_MAX = 200;
const ALLOWED_FIELDS = new Set(['kind', 'tool', 'summary', 'details', 'repro', 'severity']);

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
function feedbackError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @param {boolean} required
 * @returns {string}
 */
function readText(value, name, max, required) {
  if (value == null || value === '') {
    if (required) throw feedbackError('VALIDATION', `${name} is required`);
    return '';
  }
  if (typeof value !== 'string') throw feedbackError('VALIDATION', `${name} must be a string`);
  const text = value.trim();
  if (!text && required) throw feedbackError('VALIDATION', `${name} is required`);
  if (text.length > max) throw feedbackError('VALIDATION', `${name} exceeds ${max} characters`);
  return text;
}

/**
 * Strict input validation: unknown fields and over-limit values are rejected.
 *
 * @param {unknown} raw
 * @param {string[]} [secrets] stored secret values to scrub
 * @returns {{ kind: string, tool: string, summary: string, details: string, repro: string, severity: string }}
 */
export function parseFeedbackInput(raw, secrets = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw feedbackError('VALIDATION', 'Feedback input must be an object');
  }
  const input = /** @type {Record<string, unknown>} */ (raw);
  const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw feedbackError('VALIDATION', `Unknown field(s): ${unknown.join(', ')}`);
  const kind = readText(input.kind, 'kind', 32, true);
  if (!FEEDBACK_KINDS.includes(kind)) {
    throw feedbackError('VALIDATION', `kind must be one of: ${FEEDBACK_KINDS.join(', ')}`);
  }
  const severity = readText(input.severity, 'severity', 16, false);
  if (severity && !FEEDBACK_SEVERITIES.includes(severity)) {
    throw feedbackError('VALIDATION', `severity must be one of: ${FEEDBACK_SEVERITIES.join(', ')}`);
  }
  const summary = cleanClientText(readText(input.summary, 'summary', FEEDBACK_LIMITS.summary, true), { secrets });
  if (!summary) throw feedbackError('VALIDATION', 'summary is required');
  return {
    kind,
    tool: cleanClientText(readText(input.tool, 'tool', FEEDBACK_LIMITS.tool, false), { secrets }),
    summary,
    details: cleanClientText(readText(input.details, 'details', FEEDBACK_LIMITS.details, false), { multiline: true, secrets }),
    repro: cleanClientText(readText(input.repro, 'repro', FEEDBACK_LIMITS.repro, false), { multiline: true, secrets }),
    severity,
  };
}

/**
 * Stable dedup key of (kind + tool + normalized summary).
 *
 * @param {{ kind: string, tool?: string, summary: string }} report
 * @returns {string}
 */
export function feedbackDedupHash(report) {
  const normalized = String(report.summary || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?,;:]+$/g, '')
    .trim();
  const tool = String(report.tool || '').trim().toLowerCase();
  return createHash('sha256').update(`${report.kind}\u0000${tool}\u0000${normalized}`).digest('hex').slice(0, 24);
}

/**
 * @param {string} body
 * @returns {Record<string, any> | null}
 */
export function parseFeedbackMeta(body) {
  const text = String(body || '');
  if (!text.startsWith(META_PREFIX)) return null;
  const end = text.indexOf(META_SUFFIX);
  if (end < 0) return null;
  try {
    const meta = JSON.parse(text.slice(META_PREFIX.length, end));
    return meta && typeof meta === 'object' && typeof meta.hash === 'string' ? meta : null;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, any>} meta
 * @returns {string}
 */
function serializeMeta(meta) {
  // Escape `>` so no value can ever close the HTML comment early.
  return `${META_PREFIX}${JSON.stringify(meta).replace(/>/g, '\\u003e')}${META_SUFFIX}`;
}

/**
 * @param {string} metaLine
 * @param {string} text
 * @returns {string}
 */
function joinBody(metaLine, text) {
  const room = Math.max(0, MAX_BODY_LEN - metaLine.length - 1);
  return `${metaLine}\n${text.slice(0, room)}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
  return cleanClientText(String(value ?? '')).slice(0, SOURCE_FIELD_MAX);
}

/**
 * @param {Record<string, any>} source
 * @returns {{ at: string, harness: string, client: string, mode: string, workspace: string, chatId: string }}
 */
function normalizeSource(source) {
  return {
    at: clip(source?.at) || new Date().toISOString(),
    harness: clip(source?.harness),
    client: clip(source?.client),
    mode: clip(source?.mode),
    workspace: clip(source?.workspace),
    chatId: clip(source?.chatId),
  };
}

/**
 * @param {ReturnType<typeof parseFeedbackInput>} report
 * @returns {string}
 */
function formatReportText(report) {
  const lines = [`Kind: ${report.kind}`];
  if (report.tool) lines.push(`Tool: ${report.tool}`);
  if (report.severity) lines.push(`Severity: ${report.severity}`);
  lines.push('', report.summary);
  if (report.details) lines.push('', '## Details', report.details);
  if (report.repro) lines.push('', '## Repro', report.repro);
  return frameUntrusted(lines.join('\n'));
}

/**
 * @param {string} dataDir
 * @param {string} cretliCwd
 * @returns {Promise<{ id: string }>}
 */
async function ensureRoot(dataDir, cretliCwd) {
  const doc = await listTodos(dataDir, cretliCwd);
  const found = doc.items.find((row) => !row.parentId && String(row.body || '').startsWith(FEEDBACK_ROOT_MARKER));
  if (found) return /** @type {{ id: string }} */ (found);
  const created = await addTodo(dataDir, cretliCwd, {
    title: FEEDBACK_ROOT_TITLE,
    body: `${FEEDBACK_ROOT_MARKER}\nReports filed by MCP clients through cretli_feedback. Each child is an idea; triage by hand.`,
    status: 'idea',
    strictStatus: true,
  });
  return /** @type {{ id: string }} */ (created.item);
}

/**
 * File a report. Creates an `idea` under the root, or bumps an open duplicate.
 *
 * @param {string} dataDir
 * @param {unknown} rawInput
 * @param {Record<string, any>} [source] server-collected: harness, client, mode, workspace, chatId, at
 * @param {{ cretliCwd?: string, maxOpen?: number, secrets?: string[] }} [options]
 * @returns {Promise<{ action: 'created'|'duplicate', id: string, count: number, previousId?: string, rootId: string }>}
 */
export async function submitFeedback(dataDir, rawInput, source = {}, options = {}) {
  const report = parseFeedbackInput(rawInput, options.secrets || []);
  const cretliCwd = options.cretliCwd || resolveProjectPath();
  const maxOpen = Number.isInteger(options.maxOpen) && /** @type {number} */ (options.maxOpen) > 0
    ? /** @type {number} */ (options.maxOpen)
    : FEEDBACK_MAX_OPEN;
  const src = normalizeSource(source);
  const hash = feedbackDedupHash(report);

  // Read the existing state first: a refused report must not even create the root.
  const existingDoc = await listTodos(dataDir, cretliCwd);
  const existingRoot = existingDoc.items.find(
    (row) => !row.parentId && String(row.body || '').startsWith(FEEDBACK_ROOT_MARKER),
  );
  /** @type {Array<{ row: any, meta: Record<string, any> }>} */
  const reports = [];
  if (existingRoot) {
    for (const row of existingDoc.items) {
      if (row.parentId !== existingRoot.id) continue;
      const meta = parseFeedbackMeta(row.body);
      if (meta) reports.push({ row, meta });
    }
  }

  const open = reports.filter((entry) => entry.row.status !== 'done');
  const duplicate = open.find((entry) => entry.meta.hash === hash);
  if (duplicate && existingRoot) {
    const count = (Number.isInteger(duplicate.meta.count) ? duplicate.meta.count : 1) + 1;
    const sources = [...(Array.isArray(duplicate.meta.sources) ? duplicate.meta.sources : []), src]
      .slice(-FEEDBACK_MAX_SOURCES);
    const meta = { ...duplicate.meta, count, sources };
    const rest = String(duplicate.row.body).slice(String(duplicate.row.body).indexOf('\n') + 1);
    await updateTodo(dataDir, cretliCwd, duplicate.row.id, { body: joinBody(serializeMeta(meta), rest) });
    return { action: 'duplicate', id: duplicate.row.id, count, rootId: existingRoot.id };
  }

  if (open.length >= maxOpen) {
    throw feedbackError('LIMIT', `Too many open reports (${maxOpen}); try again after triage`);
  }

  const closedMatch = reports
    .filter((entry) => entry.row.status === 'done' && entry.meta.hash === hash)
    .sort((a, b) => String(b.row.updatedAt).localeCompare(String(a.row.updatedAt)))[0];
  const root = existingRoot || await ensureRoot(dataDir, cretliCwd);
  /** @type {Record<string, any>} */
  const meta = {
    v: 1,
    hash,
    kind: report.kind,
    tool: report.tool,
    severity: report.severity,
    count: 1,
    sources: [src],
  };
  if (closedMatch) meta.previousId = closedMatch.row.id;
  let text = formatReportText(report);
  if (closedMatch) text += `\n\nPrevious report (closed): ${closedMatch.row.id}`;
  const title = `[${report.kind}]${report.tool ? ` ${report.tool}:` : ''} ${report.summary}`;
  const created = await addTodo(dataDir, cretliCwd, {
    title,
    body: joinBody(serializeMeta(meta), text),
    status: 'idea',
    strictStatus: true,
    parentId: root.id,
  });
  /** @type {{ action: 'created', id: string, count: number, rootId: string, previousId?: string }} */
  const result = { action: 'created', id: created.item.id, count: 1, rootId: root.id };
  if (closedMatch) result.previousId = closedMatch.row.id;
  return result;
}
