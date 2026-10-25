/**
 * Builtin Cretli MCP context tool: read-only access to the context manifest of
 * a delegation (child) or of the calling chat.
 *
 * Reading never activates a skill, marks a report delivered, or changes a
 * permission; the result is a content-free manifest (ids, hashes, sizes,
 * reasons). Scope: the caller must be a chat of the delegation (parent,
 * controller, root or the child itself) and the delegation must belong to the
 * caller's workspace. Anything else is NOT_FOUND, so another workspace's
 * delegation IDs cannot be probed.
 */
import path from 'node:path';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { resolveCretliToolContext } from './tool-context.js';
import { getDelegationById } from '../../persist/delegations-persist.js';
import { delegationController } from '../../delegation-control.js';
import { buildDelegationParentReportContext } from '../../delegation-prompt.js';
import { listUndeliveredDelegationReports } from '../../delegation-report-context.js';
import {
  buildChatContextManifest,
  buildDelegationContextManifest,
  compareContextManifests,
} from '../../context/delegation-context-manifest.ts';

/**
 * @param {Record<string, any>} row
 * @param {string} workspaceFolder
 * @returns {boolean}
 */
function isRowInWorkspace(row, workspaceFolder) {
  const folder = String(row.workspaceFolder || '').trim();
  return Boolean(folder) && path.resolve(folder) === path.resolve(workspaceFolder);
}

/**
 * @param {Record<string, any>} row
 * @param {string} chatId
 * @returns {boolean}
 */
function isChatOfDelegation(row, chatId) {
  if (!chatId) return false;
  // Read-only visibility: the current controller (via the accessor), the
  // historical starter, the tree root and the executor child.
  return [delegationController(row), row.parentChatId, row.rootChatId, row.childChatId]
    .some((value) => String(value || '').trim() === chatId);
}

function notFound(id) {
  return new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.NOT_FOUND, `Delegation not found: ${id}`);
}

export const CONTEXT_MCP_TOOLS = Object.freeze([
  {
    name: 'context_manifest',
    readOnly: true,
    description:
      'Read the context manifest of a delegation child by delegation_id (separate fields: instructions/rules/skills, task, handoff, reports, explicitly omitted sources, known limits), optionally compared with the parent chat manifest. Without delegation_id it returns the manifest of the calling chat. Content-free (ids, hashes, sizes, reasons). Reading never activates a skill, marks a report delivered, or changes permissions. Scoped to the calling chat and workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        delegation_id: { type: 'string', description: 'Full delegation UUID. Omit for the calling chat.' },
        compare: { type: 'boolean', description: 'With delegation_id: also compare with the parent chat manifest (default true).' },
      },
    },
    async handler(args, { client, session }) {
      const ctx = resolveCretliToolContext(session);
      const delegationId = String(args?.delegation_id || '').trim();
      if (!delegationId) {
        if (!ctx.chatId) {
          throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'delegation_id is required outside a chat.');
        }
        const manifest = buildChatContextManifest(chatManifestInput(ctx, await safeChat(client, ctx)));
        return mcpToolResult(`context manifest of chat ${ctx.chatId}`, { ok: true, manifest });
      }
      const row = /** @type {Record<string, any> | null} */ (getDelegationById(delegationId));
      if (!row || !isRowInWorkspace(row, ctx.workspaceFolder) || !isChatOfDelegation(row, ctx.chatId)) {
        throw notFound(delegationId);
      }
      const manifest = buildDelegationContextManifest(row);
      let parent = null;
      let comparison = null;
      if (args?.compare !== false) {
        const parentId = String(row.parentChatId || '').trim();
        parent = buildChatContextManifest(chatManifestInput({ ...ctx, chatId: parentId }, await safeChat(client, { ...ctx, chatId: parentId })));
        comparison = compareContextManifests(parent, manifest);
      }
      return mcpToolResult(
        `context manifest of delegation ${delegationId} (profile ${manifest.instructions.profile || 'none'})`,
        { ok: true, manifest, ...(parent ? { parent, comparison } : {}) },
      );
    },
  },
]);

/**
 * @param {Record<string, any>} client
 * @param {{ chatId: string, workspaceFolder: string, workspaceFile?: string }} ctx
 * @returns {Promise<Record<string, any> | null>}
 */
async function safeChat(client, ctx) {
  if (typeof /** @type {any} */ (client).getChat !== 'function' || !ctx.chatId) return null;
  try {
    return await /** @type {any} */ (client).getChat({
      chatId: ctx.chatId,
      workspaceFolder: ctx.workspaceFolder,
      workspaceFile: ctx.workspaceFile,
    });
  } catch {
    return null;
  }
}

/**
 * @param {{ chatId: string, workspaceFolder: string }} ctx
 * @param {Record<string, any> | null} chat
 */
function chatManifestInput(ctx, chat) {
  const reports = listUndeliveredDelegationReports(ctx.chatId)
    .map((row) => ({ id: String(row.id), text: buildDelegationParentReportContext(row) }));
  return {
    chatId: ctx.chatId,
    workspaceFolder: ctx.workspaceFolder,
    transport: String(chat?.agentTransport || 'sdk'),
    mode: String(chat?.sdkMode || ''),
    reports,
  };
}
