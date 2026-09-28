/**
 * Append-only audit for the OpenCode approval broker and its optional Phase 2
 * external advisor.
 *
 * Every entry is written to a gitignored `data/approvals/approval-audit.jsonl`
 * file, one JSON object per line. Callers must redact before calling; this
 * module additionally caps the file so a noisy session cannot fill the disk.
 *
 * The external-model advisor audit entries are written through the same
 * append-only path. See the
 * follow-up note in `lib/approval/approval-broker.js`.
 */

import fs from 'fs';
import path from 'path';
import { resolveDataPath } from '../runtime-paths.js';

export const APPROVAL_AUDIT_FILE = resolveDataPath('approvals', 'approval-audit.jsonl');
export const APPROVAL_AUDIT_MAX_BYTES = 2_000_000;

/**
 * @param {string} file
 * @param {number} maxBytes
 */
function rotateIfNeeded(file, maxBytes) {
  try {
    const stat = fs.statSync(file);
    if (stat.size < maxBytes) return;
    const rotated = `${file}.1`;
    try {
      fs.rmSync(rotated, { force: true });
    } catch {
      // ignore
    }
    fs.renameSync(file, rotated);
  } catch {
    // missing file is fine
  }
}

/**
 * @param {Record<string, unknown>} entry
 * @param {{ file?: string, maxBytes?: number }} [options]
 * @returns {boolean}
 */
export function appendApprovalAuditEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return false;
  const file = typeof options.file === 'string' && options.file ? options.file : APPROVAL_AUDIT_FILE;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : APPROVAL_AUDIT_MAX_BYTES;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file, maxBytes);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back the audit tail for diagnostics and tests.
 *
 * @param {{ file?: string, limit?: number }} [options]
 * @returns {Array<Record<string, unknown>>}
 */
export function readApprovalAuditEntries(options = {}) {
  const file = typeof options.file === 'string' && options.file ? options.file : APPROVAL_AUDIT_FILE;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 100;
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}
