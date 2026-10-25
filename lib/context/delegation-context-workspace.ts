/**
 * Stable, path-free workspace identifier used by context manifests and the
 * context MCP tool to keep one workspace's manifests away from another's.
 */
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * @returns 12 hex chars, or '' for an empty folder.
 */
export function normalizeWorkspaceKey(folder: unknown): string {
  const value = String(folder || '').trim();
  if (!value) return '';
  return crypto.createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 12);
}
