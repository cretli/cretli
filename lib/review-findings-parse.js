/**
 * Parser for structured review findings.
 *
 * Primary source: one fenced ```findings-json block placed before TASK/VERDICT.
 * Fallback: a conservative prose scan (confidence `low`). The block is
 * machine-readable metadata only; `stripFindingsBlock` removes it so every
 * verdict / hash / prior-findings consumer sees the same text as before.
 */

import {
  REVIEW_FINDING_STATUSES,
  normalizeReviewFindingCategory,
  normalizeReviewFindingPriority,
} from './review-findings-taxonomy.js';

export const REVIEW_FINDINGS_FENCE = 'findings-json';

const BLOCK_RE = /(?:^|\n)[ \t]*```[ \t]*findings(?:-json)?[ \t]*\n([\s\S]*?)\n?[ \t]*```[ \t]*(?=\n|$)/gi;
const MAX_FINDINGS = 64;
const MAX_SUMMARY = 400;
const MAX_FILES = 12;

/**
 * Exact example object embedded in the reviewer prompt.
 *
 * @returns {string}
 */
export function buildFindingsBlockExample() {
  const example = {
    findings: [{
      id: 'F1',
      status: 'NEW',
      priority: 'P1',
      category: 'missing-test',
      files: ['lib/example.js'],
      summary: 'Short description of the problem and the behavior that is wrong.',
    }],
  };
  return `\`\`\`${REVIEW_FINDINGS_FENCE}\n${JSON.stringify(example, null, 2)}\n\`\`\``;
}

/**
 * Remove every findings block from a report; nothing else is touched.
 *
 * @param {unknown} report
 * @returns {string}
 */
export function stripFindingsBlock(report) {
  const text = String(report ?? '');
  if (!text || !/```[ \t]*findings/i.test(text)) return text;
  return text.replace(BLOCK_RE, '');
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeStatus(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (raw === 'OPEN') return 'STILL_OPEN';
  return REVIEW_FINDING_STATUSES.includes(raw) ? raw : '';
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeFiles(value) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' && value ? [value] : []);
  return [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, MAX_FILES);
}

/**
 * @typedef {{
 *   id: string, status: string, priority: string, category: string,
 *   files: string[], summary: string, source: 'json'|'prose', confidence: 'high'|'low',
 * }} ParsedReviewFinding
 */

/**
 * @param {any} raw
 * @returns {ParsedReviewFinding | null}
 */
function normalizeJsonFinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const status = normalizeStatus(raw.status) || 'NEW';
  const id = String(raw.id || '').trim().slice(0, 40);
  const summary = String(raw.summary || raw.title || '').trim().slice(0, MAX_SUMMARY);
  if (!id && !summary) return null;
  return {
    id,
    status,
    priority: normalizeReviewFindingPriority(raw.priority),
    category: normalizeReviewFindingCategory(raw.category),
    files: normalizeFiles(raw.files),
    summary,
    source: 'json',
    confidence: 'high',
  };
}

/**
 * Fallback: scan `F1 (P2) ... STILL_OPEN`, `NEW (P1) ...`, `OUT_OF_SCOPE: ...`
 * lines of prose. Intentionally narrow; every result has confidence `low`.
 *
 * @param {string} text
 * @returns {ParsedReviewFinding[]}
 */
function parseProseFindings(text) {
  /** @type {ParsedReviewFinding[]} */
  const found = [];
  const followUpMatch = text.match(/\[FOLLOW[_\s-]?UP\]/i);
  const followUpStart = followUpMatch?.index ?? -1;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.replace(/^[\s>*\-•|]+/, '').trim();
    if (!trimmed || found.length >= MAX_FINDINGS) continue;
    const idMatch = trimmed.match(/^(?:\*\*)?(F\d+)\b/i);
    const headMatch = trimmed.match(/^(?:\*\*)?(NEW|REGRESSION|OUT_OF_SCOPE|FOLLOW_UP)\b/i);
    if (!idMatch && !headMatch) continue;
    const priority = normalizeReviewFindingPriority((trimmed.match(/\bP([123])\b/i) || [])[0]);
    const statusToken = (trimmed.match(/\b(STILL_OPEN|FIXED|OUT_OF_SCOPE|REGRESSION)\b/i) || [])[1];
    let status = normalizeStatus(statusToken) || normalizeStatus(headMatch?.[1]) || 'NEW';
    if (followUpStart >= 0 && lineStart >= followUpStart && status === 'NEW') status = 'FOLLOW_UP';
    const files = [...new Set([...trimmed.matchAll(/`([^`\s]+\.[a-z0-9]+(?::\d+)?)`/gi)].map((m) => m[1].replace(/:\d+$/, '')))];
    found.push({
      id: idMatch ? idMatch[1].toUpperCase() : '',
      status,
      priority,
      category: 'other',
      files: files.slice(0, MAX_FILES),
      summary: trimmed.slice(0, MAX_SUMMARY),
      source: 'prose',
      confidence: 'low',
    });
  }
  return found;
}

/**
 * @param {unknown} report
 * @returns {{
 *   findings: ParsedReviewFinding[],
 *   source: 'json'|'prose'|'none',
 *   hasBlock: boolean,
 *   malformed: boolean,
 * }}
 */
export function parseReviewFindings(report) {
  const text = String(report ?? '');
  const blocks = [...text.matchAll(BLOCK_RE)];
  let malformed = false;
  if (blocks.length) {
    // The last block wins: a reviewer that corrected itself ends with the right one.
    const body = blocks[blocks.length - 1][1];
    try {
      const parsed = JSON.parse(body);
      const list = Array.isArray(parsed) ? parsed : parsed?.findings;
      if (Array.isArray(list)) {
        const findings = list.map(normalizeJsonFinding).filter(Boolean).slice(0, MAX_FINDINGS);
        return { findings: /** @type {any} */ (findings), source: 'json', hasBlock: true, malformed: false };
      }
      malformed = true;
    } catch {
      malformed = true;
    }
  }
  const prose = parseProseFindings(stripFindingsBlock(text));
  if (prose.length) return { findings: prose, source: 'prose', hasBlock: blocks.length > 0, malformed };
  return { findings: [], source: 'none', hasBlock: blocks.length > 0, malformed };
}

/**
 * Compact per-delegation summary stored on the delegation record.
 *
 * @param {ReturnType<typeof parseReviewFindings>} parsed
 * @returns {{ source: string, total: number, byPriority: Record<string, number>, byCategory: Record<string, number>, byStatus: Record<string, number>, confidence: string }}
 */
export function summarizeParsedReviewFindings(parsed) {
  const bump = (/** @type {any} */ map, /** @type {any} */ key) => { map[key] = (map[key] || 0) + 1; };
  const byPriority = {};
  const byCategory = {};
  const byStatus = {};
  for (const finding of parsed.findings) {
    bump(byPriority, finding.priority || 'unknown');
    bump(byCategory, finding.category);
    bump(byStatus, finding.status);
  }
  return {
    source: parsed.source,
    total: parsed.findings.length,
    byPriority,
    byCategory,
    byStatus,
    confidence: parsed.source === 'json' ? 'high' : parsed.findings.length ? 'low' : 'none',
  };
}
