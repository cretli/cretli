/**
 * Folder overlay order helpers (no Node builtins — safe for the frontend bundle).
 */

/**
 * @param {string} pathValue
 * @returns {string}
 */
export function normalizeFolderOverlayPath(pathValue) {
  return String(pathValue || '').replace(/\\/g, '/').replace(/\/$/, '').trim();
}

/**
 * Rebuilds a folder overlay object with one entry moved up or down.
 * Insertion order of the returned keys is the folder order.
 *
 * @param {unknown} overlayFolders
 * @param {string} resolvedPath
 * @param {'up' | 'down'} direction
 * @returns {Record<string, object>}
 */
export function moveFolderOverlayEntry(overlayFolders, resolvedPath, direction) {
  const overlay = overlayFolders && typeof overlayFolders === 'object' && !Array.isArray(overlayFolders)
    ? overlayFolders
    : {};
  const keys = Object.keys(overlay);
  const target = normalizeFolderOverlayPath(resolvedPath);
  const index = keys.findIndex((key) => normalizeFolderOverlayPath(key) === target);
  if (index < 0) return { ...overlay };
  const nextIndex = direction === 'up' ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= keys.length) return { ...overlay };
  const nextKeys = keys.slice();
  const [moved] = nextKeys.splice(index, 1);
  nextKeys.splice(nextIndex, 0, moved);
  const next = {};
  for (const key of nextKeys) next[key] = overlay[key];
  return next;
}
