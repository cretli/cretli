/**
 * Approval broker — workspace file-edit policy for the advisor opt-in scope
 * `approvalBroker.advisor.riskScope = 'workspace_edits'`.
 *
 * Pure, synchronous helpers (filesystem reads are limited to `realpath`). They
 * decide whether ONE edit/write permission targets a path the external advisor
 * may be consulted about. Everything unknown fails closed with a machine reason
 * so the human card stays.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * OpenCode asks for file changes under the `edit` permission (covers edit,
 * write, patch and multiedit tools); the other names cover SDK-style aliases.
 */
export const WORKSPACE_EDIT_ACTION_NAMES = Object.freeze([
  'edit',
  'write',
  'patch',
  'multiedit',
  'apply_patch',
]);

/** Largest known edit payload (bytes) the advisor may be asked about. */
export const WORKSPACE_EDIT_MAX_BYTES = 200 * 1024;

/** Assignments for which workspace edits may be advised (implementation work). */
const EDIT_ASSIGNMENTS = Object.freeze(['implement']);

/** Any path segment equal to one of these (case-insensitive) is excluded. */
const EXCLUDED_SEGMENTS = new Set([
  '.git',
  '.github',
  'data',
  'node_modules',
  '.ssh',
  '.circleci',
  '.husky',
  '.githooks',
  '.vscode',
  '.opencode',
  '.claude',
  '.cursor',
  '.gitlab',
  '.buildkite',
  '.codex',
  '.agents',
]);

/** Exact (lower-case) basenames that are excluded. */
const EXCLUDED_BASENAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.gitlab-ci.yml',
  '.gitattributes',
  '.gitmodules',
  'jenkinsfile',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'opencode.json',
  'opencode.jsonc',
  '.travis.yml',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.drone.yml',
  '.netrc',
  '.git-credentials',
  '.pgpass',
  'package.json',
  'makefile',
  'claude.md',
  'agents.md',
]);

/** Longest raw path (characters) the policy will evaluate. */
export const WORKSPACE_EDIT_MAX_PATH_CHARS = 1024;

/** Basename patterns: dotenv files, keys/certificates, ssh identities, lockfiles. */
const EXCLUDED_BASENAME_PATTERNS = Object.freeze([
  /^\.env/i,
  /^dockerfile/i,
  /^docker-compose/i,
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  /^id_[a-z0-9_]+(\.pub)?$/i,
  /\.lock$/i,
]);

export function isWorkspaceEditActionName(action: unknown): boolean {
  const name = String(action || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return WORKSPACE_EDIT_ACTION_NAMES.includes(name);
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
    : [];
}

function readKnownBytes(metadata: Record<string, unknown>): number | null {
  let total = 0;
  let known = false;
  for (const key of ['diff', 'content', 'newString', 'oldString', 'patch', 'patchText']) {
    const value = metadata[key];
    if (typeof value === 'string') {
      known = true;
      total += Buffer.byteLength(value, 'utf8');
    }
  }
  return known ? total : null;
}

/**
 * Extract the edit target of a permission event into a small, serializable
 * descriptor carried on the local approval action. Returns `null` for anything
 * that is not a file-edit permission.
 *
 * @param permissionEvent
 * @param context
 */
export function extractWorkspaceEditTarget(
  permissionEvent: unknown,
  context: { workspaceFolder?: string; assignment?: unknown; worktree?: string } = {},
): { kind: 'edit'; paths: string[]; bytes: number | null; workspaceFolder: string; assignment: string } | null {
  if (!permissionEvent || typeof permissionEvent !== 'object') return null;
  const record = permissionEvent as Record<string, unknown>;
  if (!isWorkspaceEditActionName(record.action)) return null;
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
    ? (record.metadata as Record<string, unknown>)
    : {};
  const worktree = [context.worktree, record.worktree, metadata.worktree]
    .find((value): value is string => typeof value === 'string' && path.isAbsolute(value.trim()));
  const base = worktree ? worktree.trim() : '';
  const resolveRaw = (raw: string) => (base && !path.isAbsolute(raw) && !/[*?[\]{}\0]/.test(raw) ? path.resolve(base, raw) : raw);
  // `metadata.filepath` (absolute) is the source of truth; `patterns`/resources
  // are relative to the worktree and merely repeat the same file.
  let absolute = '';
  for (const key of ['filepath', 'filePath', 'path', 'file']) {
    if (typeof metadata[key] === 'string' && (metadata[key] as string).trim()) {
      absolute = (metadata[key] as string).trim();
      break;
    }
  }
  const raws = absolute ? [absolute, ...readStringList(record.resources)] : readStringList(record.resources);
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of raws) {
    const value = resolveRaw(raw);
    const key = /[*?[\]{}\0]/.test(value) ? value : path.resolve(value);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(value);
  }
  return {
    kind: 'edit',
    paths: paths.slice(0, 8),
    bytes: readKnownBytes(metadata),
    workspaceFolder: String(context.workspaceFolder || '').trim(),
    assignment: String(context.assignment || '').trim().toLowerCase(),
  };
}

/**
 * Fail closed on symlinks: every existing component below the workspace root
 * (including the leaf, dangling or not) must not be a symlink.
 *
 * @param root absolute workspace root
 * @param target absolute path inside root
 * @returns true when a symlink component was found
 */
function hasSymlinkBelowRoot(root: string, target: string): boolean {
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error && (error as { code?: string }).code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * @param relativePath workspace-relative, forward or native separators
 */
export function isWorkspaceEditPathExcluded(relativePath: string): boolean {
  const segments = String(relativePath || '').split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return true;
  const lower = segments.map((segment) => segment.toLowerCase());
  if (lower.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return true;
  const base = lower[lower.length - 1];
  if (EXCLUDED_BASENAMES.has(base)) return true;
  return EXCLUDED_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Evaluate the static (non-quota) edit gates.
 *
 * @param target
 */
export function evaluateWorkspaceEdit(
  target: { kind?: string; paths?: string[]; bytes?: number | null; workspaceFolder?: string; assignment?: string } | null | undefined,
): { ok: true; relativePath: string; basename: string } | { ok: false; reason: string } {
  if (!target || target.kind !== 'edit') return { ok: false, reason: 'edit_not_file_edit' };
  // Assignment is known on the OpenCode path; an interactive chat has none and
  // stays with the human, who is already present.
  if (!EDIT_ASSIGNMENTS.includes(String(target.assignment || ''))) {
    return { ok: false, reason: 'edit_not_implement_assignment' };
  }
  const paths = Array.isArray(target.paths) ? target.paths : [];
  if (paths.length === 0) return { ok: false, reason: 'edit_path_unknown' };
  if (paths.length > 1) return { ok: false, reason: 'edit_multiple_paths' };
  const workspace = String(target.workspaceFolder || '').trim();
  if (!workspace || !path.isAbsolute(workspace)) return { ok: false, reason: 'edit_workspace_unknown' };
  if (!Number.isFinite(target.bytes) || Number(target.bytes) < 0) return { ok: false, reason: 'edit_size_unknown' };
  if (Number(target.bytes) > WORKSPACE_EDIT_MAX_BYTES) {
    return { ok: false, reason: 'edit_too_large' };
  }
  const raw = paths[0];
  if (raw.length > WORKSPACE_EDIT_MAX_PATH_CHARS) return { ok: false, reason: 'edit_path_too_long' };
  // Globs or non-file schemes cannot name exactly one file.
  if (/[*?[\]{}]/.test(raw) || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('\0')) {
    return { ok: false, reason: 'edit_path_unknown' };
  }
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, raw);
  if (!isInside(root, resolved)) return { ok: false, reason: 'edit_outside_workspace' };
  const relativePath = path.relative(root, resolved);
  if (isWorkspaceEditPathExcluded(relativePath)) return { ok: false, reason: 'edit_path_excluded' };
  if (hasSymlinkBelowRoot(root, resolved)) return { ok: false, reason: 'edit_symlink_path' };
  return { ok: true, relativePath, basename: path.basename(relativePath) };
}

// --- daily edit limit (in-memory, per UTC day) -----------------------------

let editQuotaState = { count: 0, day: '' };

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * @param limit
 * @param now
 * @returns true when at least one edit consultation is still allowed
 */
export function hasWorkspaceEditQuota(limit: number, now: number = Date.now()): boolean {
  const max = Number.isFinite(limit) ? Math.floor(limit) : 0;
  if (max <= 0) return false;
  if (editQuotaState.day !== utcDay(now)) return true;
  return editQuotaState.count < max;
}

/**
 * @param limit
 * @param now
 * @returns true when one unit was consumed
 */
export function tryConsumeWorkspaceEditQuota(limit: number, now: number = Date.now()): boolean {
  if (!hasWorkspaceEditQuota(limit, now)) return false;
  const day = utcDay(now);
  if (editQuotaState.day !== day) editQuotaState = { count: 0, day };
  editQuotaState.count += 1;
  return true;
}

export function readWorkspaceEditQuotaUsage(): { day: string; count: number } {
  return { ...editQuotaState };
}

/** Test helper; no production caller. */
export function resetWorkspaceEditQuota() {
  editQuotaState = { count: 0, day: '' };
}
