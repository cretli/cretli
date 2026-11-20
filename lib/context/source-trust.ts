/**
 * Host-side trust boundaries for static context entries (rules, skills, commands, agents).
 * All filesystem reads go through realpath checks against an authorized project root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { isPathInsideBase } from '../git-context.js';

export type ContextEntryKind = 'rule' | 'skill' | 'command' | 'agent' | 'config';

export const CONTEXT_ENTRY_KINDS = Object.freeze(['rule', 'skill', 'command', 'agent', 'config']);

export const CONTEXT_SIZE_LIMITS = Object.freeze({
  skill: 64 * 1024,
  rule: 256 * 1024,
  command: 128 * 1024,
  agent: 256 * 1024,
  config: 32 * 1024,
});

export const SOURCE_TRUST_ERROR_CODES = Object.freeze({
  OUTSIDE_ROOT: 'outside_root',
  TRAVERSAL: 'traversal',
  SYMLINK_ESCAPE: 'symlink_escape',
  MISSING: 'missing',
  TOO_LARGE: 'too_large',
  HOST_SOURCE_IN_REPO_CONFIG: 'host_source_in_repo_config',
});

export function normalizeContextPath(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    return path.resolve(raw);
  } catch {
    return raw;
  }
}

/**
 * Resolve `baseDir` to its real path (returns empty string when missing).
 */
export function resolveTrustedRoot(baseDir: string): string {
  const normalized = normalizeContextPath(baseDir);
  if (!normalized) return '';
  try {
    return realpathSync(normalized);
  } catch {
    return '';
  }
}

export function isInsideTrustedRoot(baseReal: string, targetReal: string): boolean {
  return isPathInsideBase(baseReal, targetReal);
}

/**
 * Validate that `candidatePath` resolves under `projectRootReal` (symlinks followed).
 */
export function assertPathWithinProjectRoot(
  projectRootReal: string,
  candidatePath: string,
): { ok: true, resolvedReal: string } | { ok: false, code: string, error: string } {
  const rel = String(candidatePath ?? '').trim();
  if (!projectRootReal) {
    return { ok: false, code: SOURCE_TRUST_ERROR_CODES.OUTSIDE_ROOT, error: 'Missing authorized project root' };
  }
  if (!rel) {
    return { ok: false, code: SOURCE_TRUST_ERROR_CODES.TRAVERSAL, error: 'Missing path' };
  }
  if (rel.includes('..') && path.normalize(rel).split(path.sep).includes('..')) {
    return { ok: false, code: SOURCE_TRUST_ERROR_CODES.TRAVERSAL, error: 'Path traversal rejected' };
  }
  try {
    const requested = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(projectRootReal, rel);
    let resolvedReal: string;
    try {
      resolvedReal = realpathSync(requested);
    } catch {
      const parentReal = realpathSync(path.dirname(requested));
      if (!isInsideTrustedRoot(projectRootReal, parentReal)) {
        return { ok: false, code: SOURCE_TRUST_ERROR_CODES.SYMLINK_ESCAPE, error: 'Path outside authorized root' };
      }
      resolvedReal = requested;
    }
    if (!isInsideTrustedRoot(projectRootReal, resolvedReal)) {
      return { ok: false, code: SOURCE_TRUST_ERROR_CODES.SYMLINK_ESCAPE, error: 'Path outside authorized root' };
    }
    return { ok: true, resolvedReal };
  } catch {
    return { ok: false, code: SOURCE_TRUST_ERROR_CODES.OUTSIDE_ROOT, error: 'Path outside authorized root' };
  }
}

export function assertFileSizeWithinLimit(
  filePath: string,
  kind: ContextEntryKind,
): { ok: true, size: number } | { ok: false, code: string, error: string } {
  const limit = CONTEXT_SIZE_LIMITS[kind] || CONTEXT_SIZE_LIMITS.rule;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, code: SOURCE_TRUST_ERROR_CODES.MISSING, error: 'Not a file' };
    }
    if (stat.size > limit) {
      return { ok: false, code: SOURCE_TRUST_ERROR_CODES.TOO_LARGE, error: `File exceeds ${kind} size limit` };
    }
    return { ok: true, size: stat.size };
  } catch {
    return { ok: false, code: SOURCE_TRUST_ERROR_CODES.MISSING, error: 'File not readable' };
  }
}

/** Host-only source labels that a repo `.cretli/context.json` must never assign. */
export const HOST_CONTEXT_SOURCE_LABELS = Object.freeze([
  'shared',
  'user',
  'home',
  'bundled',
  'host',
]);

export function isHostOnlyContextSourceLabel(sourceLabel: unknown): boolean {
  const normalized = String(sourceLabel ?? '').trim().toLowerCase();
  if (!normalized) return false;
  if (HOST_CONTEXT_SOURCE_LABELS.includes(normalized)) return true;
  return normalized.startsWith('shared:');
}
