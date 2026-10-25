import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<Record<string, string>>}
 */
export async function cretliCsrfHeaders(request) {
  const statusRes = await request.get('/api/auth-status');
  const status = await statusRes.json().catch(() => ({}));
  const csrfToken = typeof status.csrfToken === 'string' ? status.csrfToken.trim() : '';
  if (!csrfToken) return {};
  return { 'X-Cretli-Csrf': csrfToken };
}

/**
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<{ workspaceKey: string, folderKey: string, secondFolderKey?: string }>}
 */
export async function resolveScopedRouteContext(request) {
  const response = await request.get('/api/workspaces?refresh=1&scan=1&sync=1');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok() || payload?.ok !== true) {
    throw new Error(`GET /api/workspaces failed: ${payload?.error || response.status()}`);
  }
  const rows = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  for (const row of rows) {
    const workspaceKey = typeof row?.workspaceKey === 'string' ? row.workspaceKey.trim() : '';
    if (!workspaceKey) continue;
    const folders = Array.isArray(row.folders) ? row.folders : [];
    const enabled = folders.filter((entry) => {
      const folderKey = typeof entry?.folderKey === 'string' ? entry.folderKey.trim() : '';
      return folderKey.length > 0 && entry?.enabled !== false;
    });
    const folder = enabled[0];
    if (folder) {
      const out = {
        workspaceKey,
        folderKey: String(folder.folderKey).trim(),
      };
      if (enabled[1]) {
        out.secondFolderKey = String(enabled[1].folderKey).trim();
      }
      return out;
    }
  }
  throw new Error('No workspace with workspaceKey and folderKey in /api/workspaces (scan/sync returned nothing usable)');
}

/**
 * Hermetic E2E data dir often has no scanned `.code-workspace`; register this repo as a folder workspace.
 *
 * @param {import('@playwright/test').APIRequestContext} request
 * @returns {Promise<{ workspaceKey: string, folderKey: string, secondFolderKey?: string }>}
 */
export async function ensureScopedRouteContext(request) {
  let scope = null;
  try {
    scope = await resolveScopedRouteContext(request);
  } catch {
    scope = null;
  }
  if (scope) return scope;
  const patch = await request.patch('/api/settings', {
    headers: await cretliCsrfHeaders(request),
    data: {
      firstRunSetupDismissed: true,
      workspaceAddPath: projectRoot,
      workspaceAddAs: 'folder',
    },
  });
  const patchBody = await patch.json().catch(() => ({}));
  if (!patch.ok() || patchBody?.ok !== true) {
    throw new Error(`PATCH /api/settings workspace seed failed: ${patchBody?.error || patch.status()}`);
  }
  return resolveScopedRouteContext(request);
}

/**
 * @param {string} workspaceKey
 * @param {string} folderKey
 * @param {'worktrees'|'main'} subview
 */
export function buildGitScopedPath(workspaceKey, folderKey, subview) {
  const params = new URLSearchParams({ ws: workspaceKey, folder: folderKey });
  return subview === 'worktrees' ? `/git/worktrees?${params.toString()}` : `/git?${params.toString()}`;
}

/**
 * @param {string} workspaceKey
 * @param {string} folderKey
 * @param {string} panel
 * @param {string} [settingsTab]
 */
export function buildScopedPanelPath(workspaceKey, folderKey, panel, settingsTab) {
  const params = new URLSearchParams({ ws: workspaceKey, folder: folderKey });
  const base = settingsTab ? `/settings/${settingsTab}` : `/${panel}`;
  return `${base}?${params.toString()}`;
}

/**
 * @param {import('@playwright/test').Page} page
 */
export function trackSettingsPatchRequests(page) {
  /** @type {string[]} */
  const patchUrls = [];
  page.on('request', (req) => {
    if (req.method() !== 'PATCH') return;
    const url = req.url();
    if (url.includes('/api/settings') && !url.includes('/api/settings/')) {
      patchUrls.push(url);
    }
  });
  return {
    patchUrls,
    reset() {
      patchUrls.length = 0;
    },
  };
}
