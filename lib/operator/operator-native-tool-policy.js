/**
 * Pre-exec decision for NATIVE tools of an internal operator run (claude
 * `canUseTool` / `PreToolUse`, the sdk executor and the OpenCode permission
 * classifier all call this one function).
 *
 * Allowed: `Read` and `Glob` / list (and their sdk spellings) strictly inside the
 * run workspace, `Grep` only on a single regular file that passes the file
 * checks (a recursive content scan could reach nested secrets), and builtin
 * Cretli MCP tools that are on the operator allowlist (the catalog gate
 * re-checks and audits them). Everything else is denied:
 * shell, edits and writes, web, Skill, Task/Agent, apply_patch, external MCP.
 * Repository content read this way is data, never instructions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isExternalMcpToolName, readEffectiveMcpToolName } from '../mcp/mcp-policy.js';
import { hasMcpServerIdentity, isCretliBuiltinServerIdentity, resolveCretliBuiltinToolName } from '../mcp/mcp-tool-names.js';
import { OPERATOR_DENIED_MESSAGE, resolveOperatorBuiltinToolDecision } from './operator-tool-policy.js';

const READ_TOOLS = new Set(['read', 'read_file']);
const SEARCH_TOOLS = new Set(['glob', 'grep', 'list_directory', 'list_files', 'ls']);

/** Directory segments that are never readable, wherever they appear. */
const DENIED_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const CREDENTIALS_DIR = /^credentials?$/i;
const DENIED_BASENAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /^credentials?(\.|$)/i, /^\.netrc$/i, /^\.npmrc$/i];

/** @typedef {{ deny: boolean, reason: string, catalog?: boolean }} OperatorNativeDecision */
const deny = (reason) => ({ deny: true, reason: `${OPERATOR_DENIED_MESSAGE} (${reason})` });
const ALLOW = Object.freeze({ deny: false, reason: '' });
/** Allowed builtin MCP call: the catalog gate (not this policy) decides again and audits it. */
const ALLOW_VIA_CATALOG = Object.freeze({ deny: false, reason: '', catalog: true });

/** @param {string} target @returns {string} realpath of the target or of its nearest existing ancestor, plus the rest */
function realpathLoose(target) {
  const rest = [];
  let current = target;
  for (let i = 0; i < 64; i += 1) {
    try {
      return path.join(fs.realpathSync(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
  return target;
}

/**
 * @param {string} rel path relative to the workspace root (already inside it)
 * @returns {string} denial label or ''
 */
function deniedCategory(rel) {
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts[0] === 'data') return 'data directory';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (DENIED_SEGMENTS.has(part)) return 'credentials directory';
    if (CREDENTIALS_DIR.test(part)) return 'credentials';
    if (part === '.git' && parts[i + 1] === 'config') return '.git/config';
    if (DENIED_BASENAMES.some((re) => re.test(part))) return 'secret file';
  }
  return '';
}

/**
 * @param {unknown} candidate path (absolute or relative to the workspace)
 * @param {string} root workspace realpath
 * @param {{ file?: boolean }} [mode] `file`: the target must be an existing regular file
 * @returns {{ deny: boolean, reason: string }}
 */
function checkPath(candidate, root, mode = {}) {
  const raw = String(candidate ?? '').trim();
  if (raw.includes('\0')) return deny('invalid path');
  const lexical = path.resolve(root, raw || '.');
  const lexicalRel = path.relative(root, lexical);
  if (lexicalRel.startsWith('..') || path.isAbsolute(lexicalRel)) return deny('outside the run workspace');
  const real = realpathLoose(lexical);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return deny('outside the run workspace');
  const category = deniedCategory(lexicalRel) || deniedCategory(rel);
  if (category) return deny(category);
  if (mode.file) {
    let isFile = false;
    try { isFile = fs.statSync(real).isFile(); } catch { return deny('path not readable'); }
    if (!isFile) return deny('not a regular file');
  }
  return ALLOW;
}

/** Argument names tools use for their target path; the sdk executor reads `path`, claude `Read` reads `file_path`. */
const PATH_ALIAS_KEYS = ['file_path', 'path', 'filePath', 'target_file', 'directory', 'dir', 'cwd', 'file'];
const PROTECTED_PATTERN = /(^|[\\/])(data|\.git|\.ssh|\.aws|credentials?)([\\/]|$)|\.env|\.pem\b|\.key\b|(^|[\\/*?])id_/;

/**
 * @param {Record<string, any>} args
 * @returns {{ values: string[], conflict: boolean }}
 */
function collectPathAliases(args) {
  const values = [];
  for (const key of PATH_ALIAS_KEYS) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return { values: [], conflict: true };
    values.push(value);
  }
  const normalized = new Set(values.map((value) => path.normalize(value.trim())));
  return { values, conflict: normalized.size > 1 };
}

/** Static prefix of a glob pattern (up to the first wildcard), `..` segments rejected. */
function globPrefix(pattern) {
  const text = String(pattern ?? '');
  if (text.split(/[\\/]/).includes('..')) return null;
  const idx = text.search(/[*?[\]{}!]/);
  return idx === -1 ? text : text.slice(0, idx);
}

/**
 * @param {{ toolName?: unknown, args?: unknown, workspaceRoot?: unknown, server?: unknown }} input
 * @returns {OperatorNativeDecision}
 */
export function resolveOperatorNativeToolDecision(input = {}) {
  const rawName = String(input.toolName ?? '').trim();
  if (!rawName) return deny('missing tool name');
  const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? /** @type {Record<string, any>} */ (input.args)
    : {};

  if (isExternalMcpToolName(rawName)) {
    const effective = readEffectiveMcpToolName(rawName, args);
    const identity = /** @type {any} */ (input.server);
    if (hasMcpServerIdentity(identity) && !isCretliBuiltinServerIdentity(identity)) return deny('external MCP server');
    const canonical = resolveCretliBuiltinToolName(effective, hasMcpServerIdentity(identity) ? identity : undefined);
    if (!canonical) return deny('external MCP server');
    const innerArgs = rawName.toLowerCase() === 'mcp' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args;
    const decision = resolveOperatorBuiltinToolDecision(canonical, innerArgs);
    return decision.allow ? ALLOW_VIA_CATALOG : deny(decision.reason);
  }

  const name = rawName.toLowerCase();
  if (!READ_TOOLS.has(name) && !SEARCH_TOOLS.has(name)) return deny('tool not allowed');

  const workspace = String(input.workspaceRoot ?? '').trim();
  if (!workspace) return deny('missing workspace');
  let root;
  try { root = fs.realpathSync(workspace); } catch { return deny('workspace not readable'); }

  // Every path alias is validated and the aliases must agree: a tool implementation reads exactly one of
  // them, and which one differs per tool, so a disagreeing pair could validate one path and read another.
  const aliases = collectPathAliases(args);
  if (aliases.conflict) return deny('conflicting path arguments');

  if (READ_TOOLS.has(name)) {
    if (aliases.values.length === 0) return deny('missing path');
    for (const value of aliases.values) {
      const decision = checkPath(value, root);
      if (decision.deny) return decision;
    }
    return ALLOW;
  }

  if (name === 'grep') {
    // Content search is limited to one regular file: a directory scan could read nested secrets.
    if (aliases.values.length === 0) return deny('grep needs an explicit file path');
    // The executors search `args.path` and fall back to the whole workspace when it is empty, so an
    // alias-only target (e.g. `file_path`) must not pass: the validated file would never be the one searched.
    if (typeof args.path !== 'string' || !args.path.trim()) return deny('grep needs an explicit file path');
    const pattern = String(args.pattern ?? '');
    if (!pattern || pattern.startsWith('-')) return deny('invalid search pattern');
    for (const key of ['glob', 'include', 'type', 'pre', 'pre-glob']) {
      if (args[key] !== undefined && args[key] !== null && args[key] !== '') return deny(`grep option ${key} is not allowed`);
    }
    for (const value of aliases.values) {
      const decision = checkPath(value, root, { file: true });
      if (decision.deny) return decision;
    }
    return ALLOW;
  }

  // Glob / list: names only, never contents. The search root must pass the path checks and the pattern must
  // not target protected names.
  const rootDecision = checkPath(aliases.values[0] ?? '.', root);
  if (rootDecision.deny) return rootDecision;
  for (const extra of aliases.values.slice(1)) {
    const decision = checkPath(extra, root);
    if (decision.deny) return decision;
  }
  const globs = name === 'glob' ? [args.pattern ?? args.glob_pattern] : [args.glob, args.include, args.pattern];
  for (const pattern of globs) {
    if (pattern === undefined || pattern === null || pattern === '') continue;
    const prefix = globPrefix(pattern);
    if (prefix === null) return deny('pattern escapes the workspace');
    if (prefix) {
      const base = path.resolve(root, String(aliases.values[0] || '.'), prefix);
      const decision = checkPath(base, root);
      if (decision.deny) return decision;
    }
    const lowered = String(pattern).toLowerCase();
    if (PROTECTED_PATTERN.test(lowered)) return deny('pattern targets protected files');
  }
  return ALLOW;
}
