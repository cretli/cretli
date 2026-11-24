/**
 * @typedef {{
 *   enabled?: boolean,
 *   name?: string,
 *   source?: 'cursor' | 'cretli'
 * }} WorkspaceFolderOverlay
 */

/**
 * @typedef {{
 *   enabled?: boolean,
 *   folder?: string,
 *   workspaceFile?: string,
 *   label?: string,
 *   color?: string,
 *   icon?: string,
 *   folders?: Record<string, WorkspaceFolderOverlay>
 * }} WorkspaceSidebarConfigEntry
 */

/** Palette keys a workspace accent colour may take (mapped to tokens in the UI). */
export const WORKSPACE_COLOR_KEYS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeWorkspaceColor(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return WORKSPACE_COLOR_KEYS.includes(value) ? value : '';
}

/**
 * A workspace icon is a short emoji / symbol string (max 8 UTF-16 units, no markup).
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeWorkspaceIcon(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > 8 || /[<>&"'`\\]/.test(value)) return '';
  return value;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, WorkspaceFolderOverlay> | undefined}
 */
export function sanitizeFolderOverlay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const cleaned = {};
  for (const [pathKey, value] of Object.entries(raw)) {
    const resolvedPath = String(pathKey || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
    if (!resolvedPath) continue;
    const item = value && typeof value === 'object' ? value : {};
    /** @type {WorkspaceFolderOverlay} */
    const next = {};
    if (typeof item.enabled === 'boolean') next.enabled = item.enabled;
    if (typeof item.name === 'string' && item.name.trim()) next.name = item.name.trim();
    if (item.source === 'cursor' || item.source === 'cretli') next.source = item.source;
    cleaned[resolvedPath] = next;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, WorkspaceSidebarConfigEntry>}
 */
export function sanitizeWorkspaceSidebarConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const entries = Object.entries(raw);
  if (!entries.length) return {};
  const cleaned = {};
  for (const [workspaceFile, value] of entries) {
    const key = String(workspaceFile || '').trim();
    if (!key) continue;
    const item = value && typeof value === 'object' ? value : {};
    const next = {};
    if (typeof item.enabled === 'boolean') next.enabled = item.enabled;
    if (typeof item.folder === 'string' && item.folder.trim()) next.folder = item.folder.trim();
    if (typeof item.workspaceFile === 'string' && item.workspaceFile.trim()) {
      next.workspaceFile = item.workspaceFile.trim();
    }
    if (typeof item.label === 'string') {
      const label = item.label.trim();
      if (label) next.label = label;
    }
    const color = sanitizeWorkspaceColor(item.color);
    if (color) next.color = color;
    const icon = sanitizeWorkspaceIcon(item.icon);
    if (icon) next.icon = icon;
    const folders = sanitizeFolderOverlay(item.folders);
    if (folders) next.folders = folders;
    if (Object.keys(next).length === 0) continue;
    cleaned[key] = next;
  }
  return cleaned;
}

/**
 * @param {unknown} existingRaw
 * @param {unknown} incomingRaw
 * @returns {Record<string, WorkspaceSidebarConfigEntry>}
 */
export function mergeWorkspaceSidebarConfig(existingRaw, incomingRaw) {
  const existing = sanitizeWorkspaceSidebarConfig(existingRaw);
  const incoming = sanitizeWorkspaceSidebarConfig(incomingRaw);
  if (!incomingRaw || typeof incomingRaw !== 'object') return existing;
  const incomingKeys = new Set();
  for (const [rawKey, rawEntry] of Object.entries(incomingRaw)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    incomingKeys.add(key);
    const prev = existing[key] || {};
    const next = { ...prev, ...(incoming[key] || {}) };
    if (rawEntry && typeof rawEntry === 'object' && typeof rawEntry.label === 'string') {
      const label = rawEntry.label.trim();
      if (label) next.label = label;
      else delete next.label;
    }
    for (const field of ['color', 'icon']) {
      if (rawEntry && typeof rawEntry === 'object' && Object.prototype.hasOwnProperty.call(rawEntry, field)) {
        if (!incoming[key]?.[field]) delete next[field];
      }
    }
    if (rawEntry && typeof rawEntry === 'object' && Object.prototype.hasOwnProperty.call(rawEntry, 'folders')) {
      const folders = sanitizeFolderOverlay(rawEntry.folders);
      if (folders) next.folders = folders;
      else delete next.folders;
    }
    if (Object.keys(next).length === 0) {
      delete existing[key];
      continue;
    }
    existing[key] = next;
  }
  for (const key of Object.keys(existing)) {
    if (!incomingKeys.has(key)) delete existing[key];
  }
  return existing;
}
