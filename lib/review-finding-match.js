/**
 * Shared finding-identity rule: do two review findings point at the same defect?
 *
 * Pure (no I/O, no persistence). Category and summary never decide: reviewers
 * assign categories independently and an unknown one becomes `other`, so they
 * are accepted in the input but ignored. Only file paths and line proximity
 * count. Uncertainty is reported (`ambiguous`), not resolved.
 */

import { scrubFindingFile } from './review-lessons-privacy.js';

/** Two lines (or ranges) closer than or equal to this many lines are the same spot. */
export const FINDING_LINE_PROXIMITY = 5;

/**
 * Parse a finding file entry: `path`, `path:line` or `path:start-end`.
 *
 * @param {unknown} entry
 * @returns {{ path: string, start: number | null, end: number | null }}
 */
export function parseFindingFileRef(entry) {
  const raw = String(entry ?? '').trim();
  const match = /^(.*?):(\d+)(?:-(\d+))?$/.exec(raw);
  if (!match || !match[1]) return { path: raw, start: null, end: null };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  return { path: match[1], start: Math.min(start, end), end: Math.max(start, end) };
}

/**
 * Scrub and group a finding's file entries by normalised path.
 *
 * @param {unknown} files
 * @returns {Map<string, { ranges: Array<[number, number]>, hasUnlined: boolean }>}
 */
function groupByPath(files) {
  /** @type {Map<string, { ranges: Array<[number, number]>, hasUnlined: boolean }>} */
  const byPath = new Map();
  for (const entry of Array.isArray(files) ? files : []) {
    const ref = parseFindingFileRef(entry);
    const scrubbed = scrubFindingFile(ref.path);
    if (!scrubbed) continue;
    const slot = byPath.get(scrubbed) || { ranges: [], hasUnlined: false };
    if (ref.start === null || ref.end === null) slot.hasUnlined = true;
    else slot.ranges.push([ref.start, ref.end]);
    byPath.set(scrubbed, slot);
  }
  return byPath;
}

/**
 * @param {[number, number]} a
 * @param {[number, number]} b
 * @returns {number} gap in lines between the two ranges (0 when they overlap)
 */
function rangeGap(a, b) {
  return Math.max(0, Math.max(a[0], b[0]) - Math.min(a[1], b[1]));
}

/**
 * @param {{ category?: string, files?: unknown[], summary?: string }} a
 * @param {{ category?: string, files?: unknown[], summary?: string }} b
 * @returns {'same' | 'distinct' | 'ambiguous' | 'unmatchable'}
 */
export function matchFindings(a, b) {
  const left = groupByPath(a?.files);
  const right = groupByPath(b?.files);
  if (left.size === 0 || right.size === 0) return 'unmatchable';
  let common = false;
  let ambiguous = false;
  for (const [file, l] of left) {
    const r = right.get(file);
    if (!r) continue;
    common = true;
    const near = l.ranges.some((x) => r.ranges.some((y) => rangeGap(x, y) <= FINDING_LINE_PROXIMITY));
    if (near) return 'same';
    if (l.hasUnlined || r.hasUnlined) ambiguous = true;
  }
  if (!common) return 'distinct';
  return ambiguous ? 'ambiguous' : 'distinct';
}
