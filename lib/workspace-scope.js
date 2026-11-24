import { findWorkspace, toPosixPath } from './persist/workspace-registry.js';
import { listRegisteredWorkspacesForFolder } from './workspace-registry-service.js';
import { resolveWorkspaceRouteContext, workspaceRouteFolderPaths } from './workspace-route-context.js';

function workspaceFileFor(entry) {
  return entry?.kind === 'file' ? String(entry.importedFrom || entry.workspaceFile || entry.id || '') : '';
}

/** Resolve an explicitly supplied workspace identity without consulting global settings selection. */
/**
 * @param {{ workspaceId?: string | null, workspaceFile?: string | null, workspaceFolder?: string | null }} [scope]
 * @param {Record<string, any>} [settings]
 * @returns {{ ok: boolean, code?: string, workspaceId?: string, workspaceFile?: string | null, folder?: string | null, source?: string, ambiguous?: boolean }}
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

/** @param {import('express').Request} req @param {string} key */
function pickField(req, key) {
  const value = req?.query?.[key] ?? req?.body?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

const SCOPE_ERROR_MESSAGES = {
  'workspace-scope-required': 'A workspace scope is required: send workspaceId, workspaceFile, workspaceFolder, ws/folder or chatId.',
  'workspace-scope-conflict': 'The workspace scope fields name different workspaces.',
  'workspace-unknown': 'The requested workspace is not registered.',
  OUT_OF_SCOPE: 'This chat is outside the requested workspace.',
  NOT_FOUND: 'Chat not found.',
};

/**
 * @param {number} status
 * @param {string} code
 * @returns {any}
 */
function scopeFailure(status, code) {
  return { ok: false, status, code, error: SCOPE_ERROR_MESSAGES[code] || code };
}

/**
 * Resolve the workspace a per-workspace REST request is addressed to. There is
 * deliberately no fallback to the globally selected workspace.
 *
 * Source order: `req.widgetAccess` (the installation's own scope) wins; else
 * explicit `workspaceId`/`workspaceFile`/`workspaceFolder` and the opaque
 * `ws`/`folder` route keys (which must agree); else the workspace stored on the
 * `chatId` chat. A `chatId` combined with explicit fields must belong to that
 * workspace, otherwise 403 `OUT_OF_SCOPE`.
 *
 * @param {import('express').Request} req
 * @param {Record<string, any>} [settings]
 * @param {{
 *   getChat?: (chatId: string) => Promise<Record<string, any> | null> | Record<string, any> | null,
 *   isChatInWorkspace?: (chat: Record<string, any>, folder: string, file: string) => boolean,
 * }} [deps]
 * @returns {Promise<{ ok: boolean, scope?: { workspaceId?: string, workspaceFile?: string | null, folder?: string | null, source?: string, ambiguous?: boolean, chatId: string }, status?: number, code?: string, error?: string }>}
 */
export async function requireRequestScope(req, settings = {}, deps = {}) {
  const widget = /** @type {any} */ (req)?.widgetAccess;
  if (widget) {
    const workspaceId = String(widget.workspaceId || '').trim();
    const file = String(widget.workspaceFile || '').trim();
    const folder = String(widget.workspaceFolder || '').trim();
    if (!workspaceId && !file && !folder) return scopeFailure(400, 'workspace-scope-required');
    const resolved = resolveWorkspaceScope({ workspaceId, workspaceFile: file, workspaceFolder: folder }, settings);
    if (!resolved.ok) return scopeFailure(400, resolved.code);
    return { ok: true, scope: { ...resolved, source: 'widget', chatId: '' } };
  }

  const explicit = { workspaceId: pickField(req, 'workspaceId'), workspaceFile: pickField(req, 'workspaceFile'), workspaceFolder: pickField(req, 'workspaceFolder') };
  const routeKeys = { workspaceKey: pickField(req, 'ws'), folderKey: pickField(req, 'folder') };
  const chatId = pickField(req, 'chatId');
  const hasExplicit = Boolean(explicit.workspaceId || explicit.workspaceFile || explicit.workspaceFolder);
  const hasRoute = Boolean(routeKeys.workspaceKey || routeKeys.folderKey);

  /** @type {Record<string, any> | null} */
  let scope = null;
  if (hasRoute) {
    const route = resolveWorkspaceRouteContext(settings, routeKeys);
    if (!route.ok) return scopeFailure(400, route.error || 'workspace-unknown');
    if (route.workspace && explicit.workspaceId && explicit.workspaceId !== route.workspace.id) {
      return scopeFailure(400, 'workspace-scope-conflict');
    }
    const routeFolder = route.folder ? toPosixPath(route.folder.resolvedPath) : '';
    if (routeFolder && explicit.workspaceFolder && toPosixPath(explicit.workspaceFolder) !== routeFolder) {
      return scopeFailure(400, 'workspace-scope-conflict');
    }
    const merged = resolveWorkspaceScope({
      workspaceId: route.workspace?.id || explicit.workspaceId,
      workspaceFile: explicit.workspaceFile,
      workspaceFolder: routeFolder || explicit.workspaceFolder,
    }, settings);
    if (!merged.ok) return scopeFailure(400, merged.code);
    scope = merged;
  } else if (hasExplicit) {
    const resolved = resolveWorkspaceScope(explicit, settings);
    if (!resolved.ok) return scopeFailure(400, resolved.code);
    scope = resolved;
  }

  if (!chatId) {
    if (!scope) return scopeFailure(400, 'workspace-scope-required');
    return { ok: true, scope: { ...scope, chatId: '' } };
  }

  const getChat = deps.getChat || (async (id) => (await import('./persist/chats-persist.js')).getChatByIdAsync(id));
  const chat = await getChat(chatId);
  if (!chat) return scopeFailure(404, 'NOT_FOUND');
  if (scope) {
    const inWorkspace = deps.isChatInWorkspace
      || (await import('./mcp/builtin/tool-context.js')).isChatInWorkspace;
    const sameId = scope.workspaceId && String(chat.workspaceId || '').trim() === scope.workspaceId;
    if (!sameId && !inWorkspace(chat, scope.folder || '', scope.workspaceFile || '')) return scopeFailure(403, 'OUT_OF_SCOPE');
    return { ok: true, scope: { ...scope, chatId } };
  }
  const chatScope = resolveChatWorkspaceScope(chat, settings);
  if (!chatScope.ok) return scopeFailure(400, 'workspace-scope-required');
  return { ok: true, scope: { ...chatScope, chatId } };
}

/**
 * Folder a resolved scope operates on: its own folder, else the workspace's
 * todo home folder. Empty when neither can be determined.
 *
 * @param {{ workspaceId?: string, workspaceFile?: string | null, folder?: string | null }} scope
 * @param {(input: Record<string, string>) => { ok: boolean, homeFolder?: string }} resolveHome
 */
export function scopeFolderOf(scope, resolveHome) {
  if (scope?.folder) return scope.folder;
  try {
    const home = resolveHome({ workspaceId: scope?.workspaceId || '', workspaceFile: scope?.workspaceFile || '' });
    return home?.ok ? String(home.homeFolder || '') : '';
  } catch {
    return '';
  }
}

/**
 * Express middleware factory: rejects a request without a valid scope and
 * stores the result on `req.requestScope`.
 *
 * @param {{ loadSettings: () => Record<string, any>, skip?: (req: import('express').Request) => boolean, deps?: Parameters<typeof requireRequestScope>[2] }} options
 */
export function workspaceScopeMiddleware({ loadSettings, skip, deps }) {
  return async (req, res, next) => {
    if (typeof skip === 'function' && skip(req)) return next();
    try {
      const result = await requireRequestScope(req, loadSettings(), deps);
      if (!result.ok) return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      req.requestScope = result.scope;
      return next();
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'scope resolution failed' });
    }
  };
}

/**
 * Folder of a request that went through `workspaceScopeMiddleware`; handlers
 * mounted without it (unit tests with a bare router) still honour an explicit
 * `workspaceFolder`. Never reads the global selection.
 *
 * @param {import('express').Request} req
 * @param {Parameters<typeof scopeFolderOf>[1]} resolveHome
 * @returns {string}
 */
export function requestFolderOf(req, resolveHome) {
  const scoped = /** @type {any} */ (req)?.requestScope;
  return scoped ? scopeFolderOf(scoped, resolveHome) : pickField(req, 'workspaceFolder');
}
