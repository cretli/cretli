/**
 * Builtin Cretli MCP cache freshness tool.
 *
 * `cache_freshness` is a local, read-only view over the in-memory per-chat cache
 * state: estimated TTL freshness, session generation, cumulative cache
 * read/write and the separate context fill. It never calls a model or a
 * provider, so reading it cannot extend a cache.
 */

import { getCacheFreshness } from '../../usage/cache-state.js';
import { resolveCretliToolContext } from './tool-context.js';
import { mcpToolResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';

export const CACHE_MCP_TOOLS = Object.freeze([
  {
    name: 'cache_freshness',
    readOnly: true,
    description: 'Read the locally tracked prompt-cache freshness for a chat: TTL source and value, last cached turn, estimated expiry (only when the TTL is known), session generation and last reset, cumulative cache read/write, and the separate context fill. Local read only: it issues no model request and does not extend the cache. TTL expiry never resets the chat.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat id to inspect. Defaults to the calling chat.' },
      },
    },
    handler(args, { session }) {
      const explicit = String(args?.chat_id ?? '').trim();
      const chatId = explicit || String(resolveCretliToolContext(session)?.chatId || session?.chatId || '').trim();
      if (!chatId) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_id is required');
      }
      const view = getCacheFreshness(chatId);
      return mcpToolResult(JSON.stringify(view, null, 2), view);
    },
  },
]);
