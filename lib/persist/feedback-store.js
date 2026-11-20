/**
 * Create-only store for MCP feedback reports (bug / missing tool / idea / docs).
 *
 * A thin layer over `todos-persist.js`. The only operations are:
 *   - create an independent `idea` todo in the MCP reports category, or
 *   - bump the counter of an already open duplicate.
 * It never assigns an executor, never sets another status and never reads or
 * touches todos outside that category.
 *
 * Reports always live in the Cretli repository workspace (the project the
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
import { isFeedbackReport } from '../feedback-marker.js';
export { FEEDBACK_ROOT_MARKER, isUnderFeedbackRoot, isFeedbackDerivedTodo } from '../feedback-marker.js';

/** Historical container title, retained for compatibility with older integrations. */
export const FEEDBACK_ROOT_TITLE = 'Zgłoszenia z MCP';
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
 * Newest origin of a report, for grouping in the list. Null for a todo without
 * report metadata, such as one extracted during triage.
 *
 * @param {string} body
 * @returns {{ workspace: string, client: string, mode: string } | null}
 */
export function latestFeedbackSource(body) {
  const sources = parseFeedbackMeta(body)?.sources;
  if (!Array.isArray(sources) || !sources.length) return null;
  const latest = sources.reduce((best, row) => (String(row?.at || '') >= String(best?.at || '') ? row : best));
  return {
    workspace: String(latest?.workspace || ''),
    client: String(latest?.client || ''),
    mode: String(latest?.mode || ''),
  };
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
 * File a report. Creates an independent `idea`, or bumps an open duplicate.
 *
 * @param {string} dataDir
 * @param {unknown} rawInput
 * @param {Record<string, any>} [source] server-collected: harness, client, mode, workspace, chatId, at
 * @param {{ cretliCwd?: string, maxOpen?: number, secrets?: string[] }} [options]
 * @returns {Promise<{ action: 'created'|'duplicate', id: string, count: number, previousId?: string }>}
 */
export async function submitFeedback(dataDir, rawInput, source = {}, options = {}) {
  const report = parseFeedbackInput(rawInput, options.secrets || []);
  const cretliCwd = options.cretliCwd || resolveProjectPath();
  const maxOpen = Number.isInteger(options.maxOpen) && /** @type {number} */ (options.maxOpen) > 0
    ? /** @type {number} */ (options.maxOpen)
    : FEEDBACK_MAX_OPEN;
  const src = normalizeSource(source);
  const hash = feedbackDedupHash(report);

  // Read before writing so a refused report changes nothing.
  const existingDoc = await listTodos(dataDir, cretliCwd);
  /** @type {Array<{ row: any, meta: Record<string, any> }>} */
  const reports = [];
  for (const row of existingDoc.items) {
    if (!isFeedbackReport(row)) continue;
    const meta = parseFeedbackMeta(row.body);
    if (meta) reports.push({ row, meta });
  }

  const open = reports.filter((entry) => entry.row.status !== 'done');
  const duplicate = open.find((entry) => entry.meta.hash === hash);
  if (duplicate) {
    const count = (Number.isInteger(duplicate.meta.count) ? duplicate.meta.count : 1) + 1;
    const sources = [...(Array.isArray(duplicate.meta.sources) ? duplicate.meta.sources : []), src]
      .slice(-FEEDBACK_MAX_SOURCES);
    const meta = { ...duplicate.meta, count, sources };
    const rest = String(duplicate.row.body).slice(String(duplicate.row.body).indexOf('\n') + 1);
    await updateTodo(dataDir, cretliCwd, duplicate.row.id, { body: joinBody(serializeMeta(meta), rest) });
    return { action: 'duplicate', id: duplicate.row.id, count };
  }

  if (open.length >= maxOpen) {
    throw feedbackError('LIMIT', `Too many open reports (${maxOpen}); try again after triage`);
  }

  const closedMatch = reports
    .filter((entry) => entry.row.status === 'done' && entry.meta.hash === hash)
    .sort((a, b) => String(b.row.updatedAt).localeCompare(String(a.row.updatedAt)))[0];
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
    feedbackOrigin: { kind: 'report' },
    // Append to avoid changing the manual order of unrelated root todos.
    siblingIndex: Math.max(-1, ...existingDoc.items.filter((row) => !row.parentId)
      .map((row) => Number.isInteger(row.siblingIndex) ? row.siblingIndex : 0)) + 1,
  });
  /** @type {{ action: 'created', id: string, count: number, previousId?: string }} */
  const result = { action: 'created', id: created.item.id, count: 1 };
  if (closedMatch) result.previousId = closedMatch.row.id;
  return result;
}
