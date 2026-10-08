/**
 * Builtin Cretli MCP Workspace Memory tools.
 *
 * Workspace Memory is the small durable fact store the Workspace Watcher
 * orchestrator leaves behind for the *next* cycle (and for a Scout scan): an
 * architectural decision, a detected codebase pattern, a review finding, a
 * known blocker, or free-form context. Every entry belongs to one workspace and
 * survives cycles, chats and restarts.
 *
 * Tools:
 *   - `wmem_add`    upsert one typed fact (optional TTL / `permanent`)
 *   - `wmem_list`   paginated live facts (expired ones are hidden)
 *   - `wmem_delete` remove one fact by id
 *
 * The tools operate on the workspace of the calling chat. An explicit
 * `workspace_folder` may override it (used by a Scout scan over a known folder);
 * when omitted the session folder wins.
 */

import path from 'node:path';
import {
  WORKSPACE_MEMORY_MAX_ENTRIES,
  WORKSPACE_MEMORY_TYPES,
  addWorkspaceMemory,
  deleteWorkspaceMemory,
  listWorkspaceMemory,
} from '../../persist/workspace-memory-persist.js';
import { getBuiltinMcpRuntimeDeps } from './runtime-deps.js';
import { resolveCretliToolContext } from './tool-context.js';
import { paginateList } from './paging.js';
import { mcpToolResult, truncateText } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { mcpBuiltinToolDescriptionCanonicalPrefix } from '../mcp-tool-names.js';

const MEMORY_TYPES_DESCRIPTION = `One of: ${WORKSPACE_MEMORY_TYPES.join(', ')}`;

/**
 * @returns {{ dataDir?: string }}
 */
function memoryStoreOptions() {
  const configured = String(getBuiltinMcpRuntimeDeps()?.dataDir || '').trim();
  return configured ? { dataDir: configured } : {};
}

/**
 * Workspace of this call: the explicit folder when given, otherwise the calling
 * chat's session folder.
 *
 * @param {object} session
 * @param {unknown} override
 * @returns {string}
 */
function resolveMemoryWorkspace(session, override) {
  const explicit = String(override ?? '').trim();
  if (explicit) return path.resolve(explicit);
  return resolveCretliToolContext(session).workspaceFolder;
}

/**
 * Validate an optional `types` filter. Unknown types are a loud validation error
 * instead of being silently dropped.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseMemoryTypes(raw) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) {
    throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'types must be an array');
  }
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const type = String(item ?? '').trim().toLowerCase();
    if (!WORKSPACE_MEMORY_TYPES.includes(type)) {
      throw new CretliMcpToolError(
        MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
        `types must only contain: ${WORKSPACE_MEMORY_TYPES.join(', ')}`,
      );
    }
    if (!out.includes(type)) out.push(type);
  }
  return out;
}

/**
 * @param {object} entry
 * @returns {{ id: string, type: string, key: string, value: string, created_at: string, updated_at: string, expires_at: string, source: object | null }}
 */
function summarizeMemoryEntry(entry) {
  return {
    id: entry.id,
    type: entry.type,
    key: entry.key,
    value: entry.value,
    created_at: entry.createdAt || '',
    updated_at: entry.updatedAt || '',
    expires_at: entry.expiresAt || '',
    source: entry.source || null,
  };
}

/**
 * @param {object} entry
 * @returns {string}
 */
function formatMemoryLine(entry) {
  const value = truncateText(entry.value, 200);
  const ttl = entry.expiresAt ? ` exp=${entry.expiresAt}` : '';
  return `[${entry.type}] ${entry.key}: ${value.text}${value.truncated ? '…' : ''}${ttl}  (id=${entry.id})`;
}

export const MEMORY_MCP_TOOLS = Object.freeze([
  {
    name: 'wmem_add',
    readOnly: false,
    description: `${mcpBuiltinToolDescriptionCanonicalPrefix('wmem_add', 'workspace_memory_add')}Store one durable fact for this workspace so a later orchestrator cycle does not have to rediscover it. type: ${MEMORY_TYPES_DESCRIPTION}. Use a short stable key and a one-paragraph value. Re-adding the same type+key updates the existing entry instead of appending a duplicate. Omit ttl_ms for a permanent fact, EXCEPT recognized transient blocker keys (\`blocker:todo:<todoId>:<cause>\` / \`blocker:harness:<harness>:<model|*>:<cause>\` with cause quota, rate_limit, slot_busy or model_unavailable), which default to a 24 h TTL. Pass permanent: true to keep such a blocker anyway, or ttl_ms for another lifetime.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: MEMORY_TYPES_DESCRIPTION },
        key: { type: 'string', description: 'Short stable key, e.g. "auth-token-storage" or "todo-123".' },
        value: { type: 'string', description: 'The fact itself: decision + rationale, pattern, finding, blocker, or note.' },
        ttl_ms: { type: 'integer', minimum: 1, description: 'Optional lifetime in milliseconds. Omit for a permanent fact, unless the key is a recognized transient blocker (24 h default).' },
        ttl: { type: 'integer', minimum: 1, description: 'Alias of ttl_ms.' },
        permanent: { type: 'boolean', description: 'Force a permanent entry. Cannot be combined with ttl_ms.' },
        workspace_folder: { type: 'string', description: 'Defaults to the calling chat workspace.' },
      },
      required: ['type', 'key', 'value'],
    },
    handler(args, { session }) {
      const workspaceFolder = resolveMemoryWorkspace(session, args?.workspace_folder);
      const entry = addWorkspaceMemory(workspaceFolder, {
        type: args?.type,
        key: args?.key,
        value: args?.value,
        ttlMs: args?.ttl_ms,
        ttl: args?.ttl,
        permanent: args?.permanent,
        source: { chatId: String(session?.chatId || '').trim() },
      }, memoryStoreOptions());
      return mcpToolResult(
        `Stored [${entry.type}] ${entry.key} (${entry.id})${entry.expiresAt ? ` exp=${entry.expiresAt}` : ''}`,
        { entry: summarizeMemoryEntry(entry) },
      );
    },
  },
  {
    name: 'wmem_list',
    readOnly: true,
    description: `${mcpBuiltinToolDescriptionCanonicalPrefix('wmem_list', 'workspace_memory_list')}List live Workspace Memory facts for this workspace (paginated, most recently updated first). Expired entries (past ttl_ms) are never returned. Optional types narrows to: ${MEMORY_TYPES_DESCRIPTION}. A Scout scan should read this first and skip areas already marked as explored.`,
    inputSchema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' }, description: `Filter to any of: ${MEMORY_TYPES_DESCRIPTION}.` },
        limit: { type: 'number', description: 'Page size (default 20, max 100).' },
        cursor: { type: 'string', description: 'Offset cursor from a previous call.' },
        workspace_folder: { type: 'string', description: 'Defaults to the calling chat workspace.' },
      },
    },
    handler(args, { session }) {
      const workspaceFolder = resolveMemoryWorkspace(session, args?.workspace_folder);
      const types = parseMemoryTypes(args?.types);
      const entries = listWorkspaceMemory(workspaceFolder, { ...memoryStoreOptions(), types });
      const page = paginateList(entries, args);
      const rows = page.items.map(summarizeMemoryEntry);
      const text = rows.length === 0
        ? `(no workspace memory${types.length ? ` for ${types.join(', ')}` : ''})`
        : rows.map(formatMemoryLine).join('\n');
      return mcpToolResult(text, {
        workspace_folder: workspaceFolder,
        items: rows,
        total: entries.length,
        max_entries: WORKSPACE_MEMORY_MAX_ENTRIES,
        next_cursor: page.next_cursor,
      });
    },
  },
  {
    name: 'wmem_delete',
    readOnly: false,
    description: `${mcpBuiltinToolDescriptionCanonicalPrefix('wmem_delete', 'workspace_memory_delete')}Delete one Workspace Memory entry by id (the id is returned by wmem_list / wmem_add).`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id.' },
        workspace_folder: { type: 'string', description: 'Defaults to the calling chat workspace.' },
      },
      required: ['id'],
    },
    handler(args, { session }) {
      const workspaceFolder = resolveMemoryWorkspace(session, args?.workspace_folder);
      const id = String(args?.id || '').trim();
      if (!id) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'id is required');
      }
      const result = deleteWorkspaceMemory(workspaceFolder, id, memoryStoreOptions());
      if (!result.deleted) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Memory entry not found: ${id}`);
      }
      return mcpToolResult(`Deleted memory entry ${id}`, { deleted: true, entry: summarizeMemoryEntry(result.entry) });
    },
  },
]);
