/**
 * @param {unknown} raw
 * @returns {Record<string, { enabled?: boolean, folder?: string, workspaceFile?: string, label?: string }>}
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
    if (Object.keys(next).length === 0) continue;
    cleaned[key] = next;
  }
  return cleaned;
}

/**
 * @param {unknown} existingRaw
 * @param {unknown} incomingRaw
 * @returns {Record<string, { enabled?: boolean, folder?: string, workspaceFile?: string, label?: string }>}
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
