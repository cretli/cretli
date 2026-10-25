/**
 * Additional Cursor context roots (shared rules / skills / agents),
 * similar to a private multi-root workspace in the Cursor IDE.
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../persist/settings.js';
import { ensureCursorShare } from './cursor-share.ts';
import { frontmatterString, parseFrontmatter } from '../skills/frontmatter.js';

/**
 * Opt-in scope keys a rule can declare in its frontmatter, either nested under
 * `cretli:` or as flat `cretliScope*` keys. A rule without them stays global —
 * the historical behaviour — so configuring nothing changes nothing.
 */
export const CURSOR_RULE_SCOPE_KEYS = Object.freeze({
  PROJECTS: 'projects',
  TASK_KINDS: 'taskKinds',
  FILE_TYPES: 'fileTypes',
});

function readScopeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Read the optional scope of a rule. Returns null when the rule declares none,
 * which means "applies everywhere".
 */
export function resolveCursorRuleScope(
  frontmatter: Record<string, unknown> | null | undefined,
): { projects: string[]; taskKinds: string[]; fileTypes: string[] } | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null;
  const nested = frontmatter.cretli && typeof frontmatter.cretli === 'object'
    ? (frontmatter.cretli as Record<string, unknown>)
    : {};
  const projects = [
    ...readScopeList(nested[CURSOR_RULE_SCOPE_KEYS.PROJECTS]),
    ...readScopeList(frontmatter.cretliScopeProjects),
  ];
  const taskKinds = [
    ...readScopeList(nested[CURSOR_RULE_SCOPE_KEYS.TASK_KINDS]),
    ...readScopeList(frontmatter.cretliScopeTaskKinds),
  ].map((item) => item.toLowerCase());
  const fileTypes = [
    ...readScopeList(nested[CURSOR_RULE_SCOPE_KEYS.FILE_TYPES]),
    ...readScopeList(frontmatter.cretliScopeFileTypes),
  ].map((item) => item.toLowerCase());
  if (projects.length === 0 && taskKinds.length === 0 && fileTypes.length === 0) return null;
  return { projects, taskKinds, fileTypes };
}

function normalizeScopePath(value: unknown): string {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function matchesProjectScope(projects: string[], cwd: string | null | undefined): boolean {
  const current = normalizeScopePath(cwd).toLowerCase();
  if (!current) return true;
  return projects.some((entry) => {
    const needle = normalizeScopePath(entry).toLowerCase();
    if (!needle) return false;
    // Match whole path segments only, so `/work/my-app` never matches `/work/my-app-other`.
    if (needle.startsWith('/')) return current === needle || current.startsWith(`${needle}/`);
    return `/${current}/`.includes(`/${needle}/`);
  });
}

function matchesTaskKindScope(taskKinds: string[], taskKind: string | null | undefined): boolean {
  const actual = String(taskKind || '').trim().toLowerCase();
  // An unknown task kind keeps the rule: never drop a restriction on a guess.
  if (!actual) return true;
  return taskKinds.includes(actual);
}

function matchesFileTypeScope(
  fileTypes: string[],
  files: string[] | string | null | undefined,
): boolean {
  const list = (Array.isArray(files) ? files : typeof files === 'string' ? [files] : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
  // No file context for this turn keeps the rule, for the same reason.
  if (list.length === 0) return true;
  return list.some((file) => fileTypes.some((pattern) => {
    const needle = pattern.startsWith('.') ? pattern : `.${pattern}`;
    const base = file.split('/').pop();
    return file.endsWith(needle) || file === pattern || base === pattern;
  }));
}

/**
 * Decide whether a scoped rule applies to the current context.
 */
export function matchCursorRuleScope(
  scope: { projects: string[]; taskKinds: string[]; fileTypes: string[] } | null,
  context: { cwd?: string | null; taskKind?: string | null; fileTypes?: string[] | string | null } = {},
): { included: boolean; reason: string } {
  if (!scope) return { included: true, reason: 'no-scope' };
  if (scope.projects.length > 0 && !matchesProjectScope(scope.projects, context.cwd)) {
    return { included: false, reason: 'project-mismatch' };
  }
  if (scope.taskKinds.length > 0 && !matchesTaskKindScope(scope.taskKinds, context.taskKind)) {
    return { included: false, reason: 'task-kind-mismatch' };
  }
  if (scope.fileTypes.length > 0 && !matchesFileTypeScope(scope.fileTypes, context.fileTypes)) {
    return { included: false, reason: 'file-type-mismatch' };
  }
  return { included: true, reason: 'scope-match' };
}

export function normalizeAdditionalCursorContextDirs(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/\r?\n|;/)
      : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const text = String(entry || '').trim();
    if (!text) continue;
    let resolved = '';
    try {
      resolved = path.resolve(text);
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function getConfiguredAdditionalCursorContextDirs(): string[] {
  const settings = loadSettings();
  return normalizeAdditionalCursorContextDirs(settings.additionalCursorContextDirs);
}

/**
 * Project cwd first, then bundled skills and configured shared roots (existing directories only).
 */
export function resolveSdkCwdList(
  projectCwd: string | null | undefined,
  extraDirs: string[] = getConfiguredAdditionalCursorContextDirs(),
): string[] {
  const primary = typeof projectCwd === 'string' && projectCwd.trim()
    ? path.resolve(projectCwd.trim())
    : '';
  const extras = normalizeAdditionalCursorContextDirs([ensureCursorShare(), ...extraDirs]).filter((dir) => dir !== primary);
  if (!primary) return extras;
  return [primary, ...extras];
}

function parseRuleFile(
  filePath: string,
): { alwaysApply: boolean; body: string; scope: ReturnType<typeof resolveCursorRuleScope> } | null {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(raw);
  if (!frontmatter) {
    return { alwaysApply: false, body: raw.trim(), scope: null };
  }
  const body = raw.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
  const alwaysApplyValue = frontmatterString(frontmatter, 'alwaysApply').trim().toLowerCase() === 'true'
    || frontmatter.alwaysApply === true;
  return {
    alwaysApply: alwaysApplyValue,
    body,
    scope: resolveCursorRuleScope(frontmatter),
  };
}

function listRuleFiles(root: string): string[] {
  const rulesDir = path.join(root, '.cursor', 'rules');
  if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.mdc') || entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  };
  walk(rulesDir);
  return files.sort();
}

/**
 * alwaysApply rules of one root with their scope decision. Rule bodies are only
 * resolved for the rules that are included, so an out-of-scope private body is
 * never read into the prompt.
 */
export function collectAlwaysApplyRules(
  root: string,
  context: { cwd?: string | null; taskKind?: string | null; fileTypes?: string[] | string | null } = {},
): { rel: string; body: string; included: boolean; reason: string }[] {
  const rules: { rel: string; body: string; included: boolean; reason: string }[] = [];
  for (const filePath of listRuleFiles(root)) {
    const parsed = parseRuleFile(filePath);
    if (!parsed?.alwaysApply || !parsed.body) continue;
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    const decision = matchCursorRuleScope(parsed.scope, context);
    rules.push({
      rel,
      body: decision.included ? parsed.body : '',
      included: decision.included,
      reason: decision.reason,
    });
  }
  return rules;
}

function collectAlwaysApplyRuleChunks(
  root: string,
  context: { cwd?: string | null; taskKind?: string | null; fileTypes?: string[] | string | null } = {},
): string[] {
  return collectAlwaysApplyRules(root, context)
    .filter((rule) => rule.included && rule.body)
    .map((rule) => `### ${rule.rel}\n${rule.body}`);
}

/**
 * Render the workspace rules block from `### rel\nbody` chunks. Shared with the
 * registry-based assembler so both paths emit byte-identical text.
 */
export function renderWorkspaceRulesBlock(chunks: string[]): string {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return [
    '[WORKSPACE CURSOR RULES]',
    'The following always-apply rules come from this workspace `.cursor/rules` directory.',
    'Treat them as project rules for this chat.',
    '',
    ...chunks,
  ].join('\n');
}

/**
 * Render the shared rules block (see `renderWorkspaceRulesBlock`).
 */
export function renderSharedRulesBlock(chunks: string[]): string {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return [
    '[SHARED CURSOR RULES]',
    'The following always-apply rules come from additional Cursor context directories configured on Cretli.',
    'Apply their conventions to work done in this workspace.',
    'They were written for other directories: projects, repositories and paths they mention are not part of this workspace,',
    'and a request about "the project" or "all changes" never extends to them.',
    '',
    ...chunks,
  ].join('\n');
}

/**
 * alwaysApply rule bodies from the workspace project `.cursor/rules`.
 */
export function buildWorkspaceAlwaysApplyRulesPrompt(cwd: string | null | undefined): string {
  const root = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : '';
  if (!root) return '';
  return renderWorkspaceRulesBlock(collectAlwaysApplyRuleChunks(root, { cwd: root }));
}

/**
 * Collects alwaysApply rule bodies from `.cursor/rules` under each shared root.
 *
 * `options` is the current context (`cwd`, `taskKind`, `fileTypes`). A rule
 * that declares a matching scope is only included when the context matches it;
 * an unknown task or file context keeps the rule, so no restriction is dropped
 * on a guess.
 */
export function buildSharedAlwaysApplyRulesPrompt(
  dirs: string[] = getConfiguredAdditionalCursorContextDirs(),
  options: { cwd?: string | null; taskKind?: string | null; fileTypes?: string[] | string | null } = {},
): string {
  if (!Array.isArray(dirs) || dirs.length === 0) return '';
  const chunks = [];
  for (const root of dirs) {
    chunks.push(...collectAlwaysApplyRuleChunks(root, options));
  }
  return renderSharedRulesBlock(chunks);
}

/**
 * Explain which shared rules were selected and why, without exposing any rule
 * body. Useful for debugging a prompt that unexpectedly contains — or misses —
 * a shared rule.
 */
export function explainSharedAlwaysApplyRules(
  dirs: string[] = getConfiguredAdditionalCursorContextDirs(),
  options: { cwd?: string | null; taskKind?: string | null; fileTypes?: string[] | string | null } = {},
): { root: string; rule: string; included: boolean; reason: string }[] {
  if (!Array.isArray(dirs) || dirs.length === 0) return [];
  const rows: { root: string; rule: string; included: boolean; reason: string }[] = [];
  for (const root of dirs) {
    for (const rule of collectAlwaysApplyRules(root, options)) {
      rows.push({ root, rule: rule.rel, included: rule.included, reason: rule.reason });
    }
  }
  return rows;
}

export function mergeNamedContextEntries<T extends { name?: string; path?: string }>(
  primary: T[],
  extra: T[],
): T[] {
  const out = Array.isArray(primary) ? [...primary] : [];
  const seen = new Set(
    out.map((item) => `${String(item?.name || '')}|${String(item?.path || '')}`),
  );
  for (const item of Array.isArray(extra) ? extra : []) {
    const key = `${String(item?.name || '')}|${String(item?.path || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
