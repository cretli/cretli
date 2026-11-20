import { findWorkspace, toPosixPath } from './persist/workspace-registry.js';
import { listRegisteredWorkspacesForFolder } from './workspace-registry-service.js';
import { workspaceRouteFolderPaths } from './workspace-route-context.js';

function workspaceFileFor(entry) {
  return entry?.kind === 'file' ? String(entry.importedFrom || entry.workspaceFile || entry.id || '') : '';
}

/** Resolve an explicitly supplied workspace identity without consulting global settings selection. */
/**
 * @param {{ workspaceId?: string | null, workspaceFile?: string | null, workspaceFolder?: string | null }} [scope]
 * @param {Record<string, any>} [settings]
 */
export function resolveWorkspaceScope({ workspaceId, workspaceFile, workspaceFolder } = {}, settings = {}) {
  const id = String(workspaceId || '').trim();
  const file = String(workspaceFile || '').trim();
  const folder = toPosixPath(String(workspaceFolder || '').trim());
  const idEntry = id ? findWorkspace(settings.workspaces, id) : null;
  const fileEntry = file ? findWorkspace(settings.workspaces, file)
    || (Array.isArray(settings.workspaces) ? settings.workspaces.find((row) => row?.importedFrom === file) : null) : null;
  if (id && !idEntry) return { ok: false, code: 'workspace-unknown' };
  if (file && !fileEntry) return { ok: false, code: 'workspace-unknown' };
  if (idEntry && fileEntry && idEntry.id !== fileEntry.id) return { ok: false, code: 'workspace-scope-conflict' };
  const entry = idEntry || fileEntry;
  if (entry && folder && !workspaceRouteFolderPaths(settings, entry.id).map(toPosixPath).includes(folder)) {
    return { ok: false, code: 'workspace-scope-conflict' };
  }
  if (entry) return {
    ok: true,
    workspaceId: entry.id,
    workspaceFile: workspaceFileFor(entry) || null,
    folder: folder || null,
    source: idEntry ? 'workspaceId' : 'workspaceFile',
    ambiguous: false,
  };
  if (folder) {
    const matches = listRegisteredWorkspacesForFolder(settings, folder);
    return {
      ok: true,
      workspaceId: matches.length === 1 ? matches[0].id : '',
      workspaceFile: matches.length === 1 ? workspaceFileFor(matches[0]) || null : null,
      folder,
      source: 'workspaceFolder',
      ambiguous: matches.length > 1,
    };
  }
  return { ok: false, code: 'workspace-scope-required' };
}

/** Resolve a stored chat's scope; its folder may be a worktree outside registry membership. */
/**
 * @param {Record<string, any> | null | undefined} chat
 * @param {Record<string, any>} [settings]
 */
export function resolveChatWorkspaceScope(chat, settings = {}) {
  const id = String(chat?.workspaceId || '').trim();
  const file = String(chat?.workspaceFile || '').trim();
  const folder = toPosixPath(String(chat?.workspaceFolder || '').trim());
  const entry = (id && findWorkspace(settings.workspaces, id))
    || (file && (findWorkspace(settings.workspaces, file)
      || (Array.isArray(settings.workspaces) ? settings.workspaces.find((row) => row?.importedFrom === file) : null)));
  return {
    ok: Boolean(id || file || folder),
    workspaceId: id || entry?.id || '',
    workspaceFile: file || workspaceFileFor(entry) || null,
    folder: folder || null,
    source: 'chat',
    ambiguous: false,
  };
}
