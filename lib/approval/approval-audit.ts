/**
 * Append-only audit for the OpenCode approval broker and its optional Phase 2
 * external advisor.
 *
 * Every entry is written to a gitignored `data/approvals/approval-audit.jsonl`
 * file, one JSON object per line. Callers must redact before calling; this
 * module additionally caps the file so a noisy session cannot fill the disk.
 *
 * Advisor lines use `kind=advisor_assessment`; human card replies use
 * `kind=human_permission_decision`. Both correlate on `requestId`. See
 * `lib/approval/approval-advisor.ts` and `docs/APPROVAL-BROKER-PHASE-2.md`.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { resolveDataPath } from '../runtime-paths.js';

export const APPROVAL_AUDIT_FILE = resolveDataPath('approvals', 'approval-audit.jsonl');
export const APPROVAL_AUDIT_MAX_BYTES = 2_000_000;

function rotateIfNeeded(file: string, maxBytes: number): void {
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

export function appendApprovalAuditEntry(entry: Record<string, unknown>, options: { file?: string, maxBytes?: number } = {}): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const file = typeof options.file === 'string' && options.file ? options.file : APPROVAL_AUDIT_FILE;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes! > 0
    ? Math.floor(options.maxBytes!)
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
 */
export function readApprovalAuditEntries(options: { file?: string, limit?: number } = {}): Array<Record<string, unknown>> {
  const file = typeof options.file === 'string' && options.file ? options.file : APPROVAL_AUDIT_FILE;
  const limit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.floor(options.limit!) : 100;
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
      .filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

export const APPROVAL_AUDIT_SUMMARY_MAX_LINES = 5000;
export const APPROVAL_AUDIT_SUMMARY_DEFAULT_DAYS = 7;
export const APPROVAL_AUDIT_SUMMARY_MAX_DAYS = 90;
const SUMMARY_TOP_REASONS = 8;
const SUMMARY_REASON_KEY = /^[a-z0-9_]{1,48}$/;
const SUMMARY_SOURCES = ['advisor', 'local', 'user'];

type AuditSummary = {
  decisions: { advisor: number, local: number, user: number, unknown: number, total: number },
  skips: { total: number, reasons: Array<{ reason: string, count: number }> },
};

/**
 * Clamp the `days` query value to 1..90 (default 7).
 */
export function normalizeApprovalAuditSummaryDays(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return APPROVAL_AUDIT_SUMMARY_DEFAULT_DAYS;
  return Math.min(n, APPROVAL_AUDIT_SUMMARY_MAX_DAYS);
}

/**
 * Aggregate parsed audit rows into counters only. Commands, paths, request ids
 * and free-form reasons never leave this function: skip reasons are kept only
 * when they look like a machine code (`[a-z0-9_]`), otherwise bucketed as `other`.
 */
export function summarizeApprovalAuditRows(rows: Array<unknown>, options: { sinceMs?: number } = {}): AuditSummary {
  const sinceMs = Number.isFinite(options.sinceMs) ? Number(options.sinceMs) : 0;
  const decisions = { advisor: 0, local: 0, user: 0, unknown: 0, total: 0 };
  const reasonCounts = new Map<string, number>();
  let skipTotal = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    const ts = Date.parse(String(entry.ts || ''));
    if (sinceMs && !(ts >= sinceMs)) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    if (kind === 'advisor_skip') {
      skipTotal += 1;
      const raw = String(entry.reason || '').trim().toLowerCase();
      const key = SUMMARY_REASON_KEY.test(raw) ? raw : (raw ? 'other' : 'unknown');
      reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
      continue;
    }
    if (kind === 'advisor_assessment') {
      if (entry.source === 'advisor') {
        decisions.advisor += 1;
        decisions.total += 1;
      }
      continue;
    }
    const source = SUMMARY_SOURCES.includes(String(entry.source)) ? String(entry.source) : '';
    const isDecision = kind === 'human_permission_decision'
      || entry.finalDecision === 'allow_once'
      || entry.finalDecision === 'reject';
    if (source) {
      decisions[source as 'advisor' | 'local' | 'user'] += 1;
      decisions.total += 1;
    } else if (isDecision) {
      decisions.unknown += 1;
      decisions.total += 1;
    }
  }
  const reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, SUMMARY_TOP_REASONS)
    .map(([reason, count]) => ({ reason, count }));
  return { decisions, skips: { total: skipTotal, reasons } };
}

/**
 * Stream the audit file keeping only the last `maxLines` lines, skip corrupt
 * lines and summarize rows from the last `days` days. Read-only.
 */
export async function readApprovalAuditSummary(options: { file?: string, days?: number, maxLines?: number, now?: number } = {}): Promise<{ days: number, sinceTs: string, linesScanned: number } & ReturnType<typeof summarizeApprovalAuditRows>> {
  const file = typeof options.file === 'string' && options.file ? options.file : APPROVAL_AUDIT_FILE;
  const maxLines = Number.isFinite(options.maxLines) && options.maxLines! > 0
    ? Math.floor(options.maxLines!)
    : APPROVAL_AUDIT_SUMMARY_MAX_LINES;
  const days = normalizeApprovalAuditSummaryDays(options.days);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sinceMs = now - days * 86_400_000;
  const tail: string[] = [];
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      tail.push(line);
      if (tail.length > maxLines) tail.shift();
    }
  } catch {
    // Missing or unreadable file: an empty summary is the honest answer.
  }
  const rows: unknown[] = [];
  for (const line of tail) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // corrupt line
    }
  }
  return {
    days,
    sinceTs: new Date(sinceMs).toISOString(),
    linesScanned: tail.length,
    ...summarizeApprovalAuditRows(rows, { sinceMs }),
  };
}
