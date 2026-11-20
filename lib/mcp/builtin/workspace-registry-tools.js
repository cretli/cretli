/**
 * Builtin Cretli MCP workspace registry tools.
 *
 * Let an agent register or remove a project in the Cretli workspace registry
 * (the SQL workspaces store) without calling the authenticated REST API.
 *
 * Tools:
 *   - `wsreg_list`   registry rows with route keys and the active flag (read)
 *   - `wsreg_add`    idempotent add of a folder or `.code-workspace` file
 *   - `wsreg_remove` confirm-gated removal of a registry row (never deletes files)
 *
 * Neither write switches the active workspace of the UI, except `wsreg_remove`
 * with `force_active: true`, which falls back to the next registry row.
 */

import path from 'node:path';
import { loadSettings, saveSettings } from '../../persist/settings.js';
import { toPosixPath } from '../../persist/workspace-registry.js';
import { applyWorkspaceAddPath, applyWorkspaceRemoveId } from '../../workspace-list.js';
import {
  buildWorkspacesListWithRouteKeys,
  findRegisteredWorkspaceForPath,
  invalidateWorkspacesCache,
} from '../../workspace-registry-service.js';
import { inspectWorkspacePath } from '../../workspace.js';
import { findWorkspaceByRef } from '../../workspace-ref.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

/**
 * @param {Record<string, any>} settings
 * @returns {string}
 */
function activeWorkspaceId(settings) {
  return toPosixPath(String(settings?.workspaceFile || ''));
}

/**
 * @param {Record<string, any>} row - client list row from buildWorkspacesListWithRouteKeys
 * @param {string} activeId
 * @returns {{ id: string, kind: string, label: string, route_key: string, active: boolean, workspace_file: string, imported_from: string, folders: string[] }}
 */
function summarizeWorkspaceRow(row, activeId) {
  const folders = (Array.isArray(row.folders) ? row.folders : [])
    .filter((folder) => folder?.enabled !== false)
    .map((folder) => toPosixPath(folder?.resolvedPath || folder?.path || ''))
    .filter(Boolean);
  return {
    id: row.id,
    kind: row.kind,
    label: row.name || '',
    route_key: row.workspaceKey || '',
    active: row.id === activeId,
    workspace_file: row.kind === 'file' ? row.workspaceFile || '' : '',
    imported_from: row.importedFrom || '',
    folders,
  };
}

/**
 * @param {ReturnType<typeof summarizeWorkspaceRow>} row
 * @returns {string}
 */
function formatWorkspaceLine(row) {
  const active = row.active ? ' [active]' : '';
  const where = row.kind === 'file' ? row.workspace_file : row.folders.join(', ') || '(no folders)';
  return `${row.label} (${row.kind})${active}: ${where}  (id=${row.id})`;
}

/**
 * Registry list on a copy of the settings: a read never persists, so route
 * keys minted for a row nobody has listed yet stay in memory only.
 *
 * @param {Record<string, any>} settings
 * @returns {Array<ReturnType<typeof summarizeWorkspaceRow>>}
 */
function listRegistryRows(settings) {
  const scratch = structuredClone(settings);
  const activeId = activeWorkspaceId(settings);
  return buildWorkspacesListWithRouteKeys(scratch).list.map((row) => summarizeWorkspaceRow(row, activeId));
}

/**
 * @param {string} error - helper error code
 * @param {string} rawPath
 * @returns {CretliMcpToolError}
 */
function toAddPathError(error, rawPath) {
  if (error === 'not_found') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Path does not exist: ${rawPath}`);
  }
  if (error === 'missing') {
    return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'path is required');
  }
  return new CretliMcpToolError(
    MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
    `path must be a directory or a .code-workspace file: ${rawPath}`,
  );
}

/**
 * The helper would expand `~` and resolve relative paths against the server
 * cwd; an agent has to say exactly which directory it means.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function requireAbsolutePath(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'path is required');
  }
  if (value.startsWith('~') || !path.isAbsolute(value)) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `path must be absolute (no ~ or relative paths): ${value}`,
    );
  }
  return value;
}

/**
 * @param {Record<string, any>} settings
 * @param {string} id
 * @returns {ReturnType<typeof summarizeWorkspaceRow> | null}
 */
function persistAndSummarize(settings, id) {
  // Mint the route keys of the new row as part of the write, so a later
  // read-only `wsreg_list` reports stable ids.
  const built = buildWorkspacesListWithRouteKeys(settings);
  saveSettings(settings);
  invalidateWorkspacesCache();
  const activeId = activeWorkspaceId(settings);
  const row = built.list.find((item) => /** @type {any} */ (item).id === id);
  return row ? summarizeWorkspaceRow(row, activeId) : null;
}

export const WORKSPACE_REGISTRY_MCP_TOOLS = Object.freeze([
  {
    name: 'wsreg_list',
    readOnly: true,
    description: 'List the Cretli workspace registry (the projects shown in the workspace picker): id, kind (folders = Cretli folder workspace, file = .code-workspace), label, route key, enabled folders and which row is active. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    handler() {
      const settings = loadSettings();
      const rows = listRegistryRows(settings);
      const text = rows.length === 0 ? '(no registered workspaces)' : rows.map(formatWorkspaceLine).join('\n');
      return mcpToolResult(text, { items: rows, total: rows.length, active_id: activeWorkspaceId(settings) });
    },
  },
  {
    name: 'wsreg_add',
    readOnly: false,
    description: 'Register a project in the Cretli workspace registry. path is an absolute directory or .code-workspace file. A directory becomes a Cretli folder workspace (prefer_folder defaults to true, even when it contains a .code-workspace file). A .code-workspace file (or prefer_folder=false on a directory holding one) is IMPORTED once: its folders are copied into a new Cretli workspace and the file is never read again (imported_from keeps its path as metadata). Idempotent: a path that is already registered (or a file already imported) returns the existing row with created=false unless allow_duplicate=true imports it again as a separate workspace. Does not switch the active workspace and never writes files besides the registry.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory or .code-workspace file path.' },
        label: { type: 'string', description: 'Optional display label (defaults to the folder or file name).' },
        prefer_folder: { type: 'boolean', description: 'Register a directory as a folder workspace even if it contains a .code-workspace file (default true).' },
        allow_duplicate: { type: 'boolean', description: 'Import an already imported .code-workspace file again as a separate workspace (default false).' },
      },
      required: ['path'],
    },
    handler(args) {
      const rawPath = requireAbsolutePath(args?.path);
      const preferFolders = args?.prefer_folder !== false;
      const label = typeof args?.label === 'string' ? args.label.trim() : '';
      const inspected = inspectWorkspacePath(rawPath, { preferFolders });
      if (!inspected.ok) throw toAddPathError(inspected.error || 'invalid', rawPath);
      const settings = loadSettings();
      const existing = findRegisteredWorkspaceForPath(settings, /** @type {any} */ (inspected));
      if (existing && args?.allow_duplicate !== true) {
        const row = listRegistryRows(settings).find((item) => item.id === existing.id) || null;
        return mcpToolResult(
          `Already registered: ${row ? formatWorkspaceLine(row) : existing.id}`,
          { created: false, workspace: row },
        );
      }
      const result = applyWorkspaceAddPath(settings, rawPath, {
        preferFolders,
        label,
        activate: false,
        confirmDuplicate: args?.allow_duplicate === true,
      });
      if (!result.ok || !result.id) throw toAddPathError(result.error || 'invalid', rawPath);
      const row = persistAndSummarize(settings, result.id);
      return mcpToolResult(
        `Registered: ${row ? formatWorkspaceLine(row) : result.id}`,
        { created: true, workspace: row },
      );
    },
  },
  {
    name: 'wsreg_remove',
    readOnly: false,
    description: 'Remove one row from the Cretli workspace registry by id (from wsreg_list). Requires confirm: true. Only the registry row, its sidebar overlay and route keys are removed; no file or folder is deleted. Removing the active workspace is refused unless force_active: true, which makes the next registry row active.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Registry id from wsreg_list.' },
        confirm: { type: 'boolean', description: 'Must be true.' },
        force_active: { type: 'boolean', description: 'Allow removing the active workspace.' },
      },
      required: ['id', 'confirm'],
    },
    handler(args) {
      const id = String(args?.id || '').trim();
      if (!id) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'id is required');
      if (args?.confirm !== true) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'confirm: true is required to remove a workspace');
      }
      const settings = loadSettings();
      const entry = findWorkspaceByRef(settings.workspaces, id);
      if (!entry) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Workspace not found: ${id}`);
      const wasActive = activeWorkspaceId(settings) === entry.id;
      if (wasActive && args?.force_active !== true) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          `Workspace ${entry.id} is active; pass force_active: true to remove it anyway`,
        );
      }
      const result = applyWorkspaceRemoveId(settings, entry.id);
      if (!result.ok) throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, `Cannot remove ${entry.id}`);
      saveSettings(settings);
      invalidateWorkspacesCache();
      const activeId = activeWorkspaceId(settings);
      return mcpToolResult(
        `Removed ${entry.id}${wasActive ? `; active workspace is now ${activeId || '(none)'}` : ''}`,
        { removed: true, id: entry.id, was_active: wasActive, active_id: activeId },
      );
    },
  },
]);
