/**
 * Additional Cursor context roots (shared rules / skills / agents),
 * similar to a private multi-root workspace in the Cursor IDE.
 */

import fs from 'fs';
import path from 'path';
import { loadSettings } from '../persist/settings.js';
import { ensureCursorShare } from './cursor-share.js';

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeAdditionalCursorContextDirs(raw) {
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

/**
 * @returns {string[]}
 */
export function getConfiguredAdditionalCursorContextDirs() {
  const settings = loadSettings();
  return normalizeAdditionalCursorContextDirs(settings.additionalCursorContextDirs);
}

/**
 * Project cwd first, then bundled skills and configured shared roots (existing directories only).
 * @param {string | null | undefined} projectCwd
 * @param {string[]} [extraDirs]
 * @returns {string[]}
 */
export function resolveSdkCwdList(
  projectCwd,
  extraDirs = getConfiguredAdditionalCursorContextDirs(),
) {
  const primary = typeof projectCwd === 'string' && projectCwd.trim()
    ? path.resolve(projectCwd.trim())
    : '';
  const extras = normalizeAdditionalCursorContextDirs([ensureCursorShare(), ...extraDirs]).filter((dir) => dir !== primary);
  if (!primary) return extras;
  return [primary, ...extras];
}

/**
 * @param {string} filePath
 * @returns {{ alwaysApply: boolean, body: string } | null}
 */
function parseRuleFile(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { alwaysApply: false, body: raw.trim() };
  }
  const frontmatter = match[1];
  const body = String(match[2] || '').trim();
  const alwaysApply = /^\s*alwaysApply:\s*true\s*$/im.test(frontmatter);
  return { alwaysApply, body };
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function collectAlwaysApplyRuleChunks(root) {
  const rulesDir = path.join(root, '.cursor', 'rules');
  if (!fs.existsSync(rulesDir) || !fs.statSync(rulesDir).isDirectory()) return [];
  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    let entries = [];
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
  const chunks = [];
  for (const filePath of files.sort()) {
    const parsed = parseRuleFile(filePath);
    if (!parsed?.alwaysApply || !parsed.body) continue;
    const rel = path.relative(root, filePath).replace(/\\/g, '/');
    chunks.push(`### ${rel}\n${parsed.body}`);
  }
  return chunks;
}

/**
 * alwaysApply rule bodies from the workspace project `.cursor/rules`.
 * @param {string | null | undefined} cwd
 * @returns {string}
 */
export function buildWorkspaceAlwaysApplyRulesPrompt(cwd) {
  const root = typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd.trim()) : '';
  if (!root) return '';
  const chunks = collectAlwaysApplyRuleChunks(root);
  if (chunks.length === 0) return '';
  return [
    '[WORKSPACE CURSOR RULES]',
    'The following always-apply rules come from this workspace `.cursor/rules` directory.',
    'Treat them as project rules for this chat.',
    '',
    ...chunks,
  ].join('\n');
}

/**
 * Collects alwaysApply rule bodies from `.cursor/rules` under each shared root.
 * @param {string[]} [dirs]
 * @returns {string}
 */
export function buildSharedAlwaysApplyRulesPrompt(dirs = getConfiguredAdditionalCursorContextDirs()) {
  if (!Array.isArray(dirs) || dirs.length === 0) return '';
  const chunks = [];
  for (const root of dirs) {
    chunks.push(...collectAlwaysApplyRuleChunks(root));
  }
  if (chunks.length === 0) return '';
  return [
    '[SHARED CURSOR RULES]',
    'The following always-apply rules come from additional Cursor context directories configured on Cretli.',
    'Treat them as project rules that apply to this workspace.',
    '',
    ...chunks,
  ].join('\n');
}

/**
 * @template {{ name?: string, path?: string }} T
 * @param {T[]} primary
 * @param {T[]} extra
 * @returns {T[]}
 */
export function mergeNamedContextEntries(primary, extra) {
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
