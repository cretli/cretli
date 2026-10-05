/**
 * Shared sidebar layout (chat order, workspace order, favorites, fold state).
 * Stored apart from config.json so a drag does not race settings that hold secrets.
 */

import fs from 'fs';
import path from 'path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const LAYOUT_FILE = resolveDataPath('sidebar-layout.json');

/** @type {Readonly<Record<string, { limit: number, kind: 'id' | 'path' }>>} */
export const SIDEBAR_LAYOUT_FIELDS = Object.freeze({
  chatOrder: { limit: 5000, kind: 'id' },
  workspaceOrder: { limit: 500, kind: 'path' },
  favoriteChatIds: { limit: 2000, kind: 'id' },
  collapsedWorkspaces: { limit: 500, kind: 'path' },
  subchatExpanded: { limit: 2000, kind: 'id' },
  archiveOpen: { limit: 500, kind: 'id' },
});

const MAX_ITEM_LENGTH = 1024;

/**
 * @param {unknown} value
 * @param {'id' | 'path'} kind
 * @returns {string}
 */
function normalizeItem(value, kind) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_ITEM_LENGTH) return '';
  if (kind === 'path') return raw.replace(/\\/g, '/').replace(/\/$/, '');
  return raw;
}

/**
 * @param {string} field
 * @param {unknown} raw
 * @returns {string[]}
 */
export function sanitizeSidebarLayoutList(field, raw) {
  const spec = SIDEBAR_LAYOUT_FIELDS[field];
  if (!spec || !Array.isArray(raw)) return [];
  const seen = new Set();
  const next = [];
  raw.forEach((item) => {
    if (next.length >= spec.limit) return;
    const value = normalizeItem(item, spec.kind);
    if (!value || seen.has(value)) return;
    seen.add(value);
    next.push(value);
  });
  return next;
}

/**
 * @returns {Record<string, string[]>}
 */
export function emptySidebarLayout() {
  /** @type {Record<string, string[]>} */
  const layout = {};
  Object.keys(SIDEBAR_LAYOUT_FIELDS).forEach((field) => {
    layout[field] = [];
  });
  return layout;
}

/**
 * @param {unknown} raw
 * @returns {{ updatedAt: string } & Record<string, string[]>}
 */
export function sanitizeSidebarLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const layout = emptySidebarLayout();
  Object.keys(SIDEBAR_LAYOUT_FIELDS).forEach((field) => {
    layout[field] = sanitizeSidebarLayoutList(field, source[field]);
  });
  const updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt.trim() : '';
  return { ...layout, updatedAt };
}

/**
 * @param {string} [filePath]
 * @returns {string}
 */
function resolveFile(filePath) {
  return typeof filePath === 'string' && filePath.trim() ? filePath.trim() : LAYOUT_FILE;
}

/**
 * @param {string} [filePath]
 * @returns {{ updatedAt: string } & Record<string, string[]>}
 */
export function loadSidebarLayout(filePath) {
  const target = resolveFile(filePath);
  if (!fs.existsSync(target)) return sanitizeSidebarLayout(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return sanitizeSidebarLayout(parsed);
  } catch {
    return sanitizeSidebarLayout(null);
  }
}

/**
 * @param {object} layout
 * @param {string} [filePath]
 * @returns {void}
 */
function saveSidebarLayout(layout, filePath) {
  const target = resolveFile(filePath);
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(target, sanitizeSidebarLayout(layout));
}

/**
 * Replace only the fields present in `patch`. Each present field must be an array.
 *
 * @param {unknown} patch
 * @param {string} [filePath]
 * @returns {{ ok: true, changed: boolean, layout: { updatedAt: string } & Record<string, string[]> } | { ok: false, error: string }}
 */
export function patchSidebarLayout(patch, filePath) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid' };
  }
  const current = loadSidebarLayout(filePath);
  /** @type {Record<string, string[]>} */
  const next = { ...current };
  let changed = false;
  for (const field of Object.keys(SIDEBAR_LAYOUT_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (!Array.isArray(patch[field])) return { ok: false, error: 'invalid' };
    next[field] = sanitizeSidebarLayoutList(field, patch[field]);
    changed = true;
  }
  if (!changed) return { ok: true, changed: false, layout: current };
  const layout = sanitizeSidebarLayout({ ...next, updatedAt: new Date().toISOString() });
  saveSidebarLayout(layout, filePath);
  return { ok: true, changed: true, layout };
}
