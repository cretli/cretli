/**
 * Builtin Cretli MCP chat and MCP-status tools.
 */

import { paginateList } from './paging.js';
import { mcpToolResult, mcpTextResult } from './result.js';
import { CretliMcpToolError, MCP_BUILTIN_ERROR_CODES } from './errors.js';
import { listChatsForMcpScope, resolveScopedChatOrError } from './chat-scope.js';
import {
  CHAT_EVENT_FIELDS,
  MCP_HISTORY_PAGE_CHARS,
  assembleHistoryPageText,
  clampHistoryLimit,
  formatHistoryPage,
  parseEventSliceLength,
  readEventField,
  resolveHistoryCursors,
  sliceEventField,
  unwrapHistoryEntry,
} from './chat-history-format.js';

function formatChatLine(chat) {
  const updated = String(chat.updatedAt || chat.createdAt || '').slice(0, 10);
  const badge = chat.archivedAt ? ' [ARCHIVED]' : '';
  const parent = String(chat.forkParentChatId || '').trim();
  const parentBit = parent ? `  fork:${parent.slice(0, 8)}` : '';
  return `${updated}  ${String(chat.agentTransport || 'sdk').padEnd(10)}  ${chat.title || '(untitled)'}  ${String(chat.id).slice(0, 8)}${parentBit}${badge}`;
}

function sortChats(chats) {
  return [...chats].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function summarizeChat(chat) {
  return {
    id: chat.id,
    title: chat.title || '',
    harness: chat.agentTransport || 'sdk',
    archived: Boolean(chat.archivedAt),
    fork_parent_chat_id: String(chat.forkParentChatId || '').trim() || null,
    workspace: chat.workspaceFolder || chat.workspaceFile || '',
  };
}

function formatChatHeader(chat) {
  const parent = String(chat.forkParentChatId || '').trim();
  return [
    `# ${chat.title || '(untitled)'} (${chat.id})`,
    `workspace: ${chat.workspaceFolder || chat.workspaceFile || '(none)'}`,
    `harness: ${chat.agentTransport || 'sdk'}  model: ${chat.model || '-'}  archived: ${chat.archivedAt ? 'yes' : 'no'}`,
    `created: ${String(chat.createdAt || '').slice(0, 10)}  updated: ${String(chat.updatedAt || '').slice(0, 10)}`,
    `fork_parent: ${parent || '(none)'}`,
  ].join('\n');
}

function isPositiveSeq(raw) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function requirePositiveSeq(raw, name) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `${name} must be a positive integer.`,
    );
  }
  return value;
}

function requireNonNegativeInt(raw, name, fallback) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CretliMcpToolError(
      MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
      `${name} must be a non-negative integer.`,
    );
  }
  return value;
}

function pageOptions(chat, history, extra = {}) {
  return {
    chatId: chat.id,
    titleHeader: formatChatHeader(chat),
    headSeq: Number(history?.headSeq) || 0,
    maxPageChars: MCP_HISTORY_PAGE_CHARS,
    ...extra,
  };
}

async function loadChatHistoryPage(client, chatId, args) {
  const limit = clampHistoryLimit(args?.limit ?? args?.tail);
  const fromSeq = isPositiveSeq(args?.from_seq);
  const beforeSeq = isPositiveSeq(args?.before_seq ?? args?.before);
  if (fromSeq > 0) {
    return client.getChatHistory(chatId, {
      since: Math.max(0, fromSeq - 1),
      limit,
    });
  }
  return client.getChatHistory(chatId, {
    tail: limit,
    before: beforeSeq || undefined,
  });
}

function historyPageCursors(page, args) {
  return resolveHistoryCursors(page, args);
}

export const CHAT_MCP_TOOLS = Object.freeze([
  {
    name: 'chat_list',
    readOnly: true,
    description:
      'List Cretli chats in the current workspace (active by default). Pass scope=all for every workspace. Most recent first.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Filter by workspace folder/file substring.' },
        scope: {
          type: 'string',
          description: 'workspace (default, calling chat only) or all (every workspace).',
        },
        include_archived: { type: 'boolean', description: 'Include archived chats (default false).' },
        limit: { type: 'number', description: 'Max chats to return (most recent first).' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous list.' },
      },
    },
    async handler(args, { client, session }) {
      const chats = await client.listChats({ includeArchived: args?.include_archived === true });
      const filtered = sortChats(listChatsForMcpScope(chats, session, args));
      const page = paginateList(filtered, args);
      if (page.items.length === 0) {
        return mcpToolResult('No chats match the given filters.', { items: [], next_cursor: '' });
      }
      return mcpToolResult(
        page.items.map(formatChatLine).join('\n'),
        { items: page.items.map(summarizeChat), next_cursor: page.next_cursor },
      );
    },
  },
  {
    name: 'chat_show',
    readOnly: true,
    description:
      'Show chat metadata (including fork parent) and a compact conversation tail. Use chat_history to page events and tool calls. Same-workspace by default; scope=all for another workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        tail: { type: 'number', description: 'History events to scan (default 40, max 80).' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat'],
    },
    async handler(args, { client, session }) {
      const { chat } = await resolveScopedChatOrError(client, session, args);
      const history = await loadChatHistoryPage(client, chat.id, { tail: args?.tail });
      const page = formatHistoryPage(history, pageOptions(chat, history, {
        compactTools: true,
        forward: false,
        section: 'history tail',
      }));
      const cursors = historyPageCursors(page, {});
      return mcpToolResult(
        assembleHistoryPageText({
          titleHeader: formatChatHeader(chat),
          section: 'history tail',
          headSeq: Number(history?.headSeq) || 0,
          body: page.compact_text,
          events: page.events,
          cursors,
          chatId: chat.id,
        }),
        {
          ...summarizeChat(chat),
          head_seq: Number(history?.headSeq) || 0,
          oldest_seq: page.oldest_seq,
          newest_seq: page.newest_seq,
          next_before_seq: cursors.next_before_seq,
          truncated: cursors.truncated,
        },
      );
    },
  },
  {
    name: 'chat_history',
    readOnly: true,
    description:
      'Page chat history by event seq. Default is the newest page. Pass from_seq to read forward or before_seq for older events. Truncated fields continue with chat_event. Same-workspace by default; scope=all for another workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        from_seq: { type: 'number', description: 'First event seq to include (forward page).' },
        before_seq: { type: 'number', description: 'Return events older than this seq.' },
        limit: { type: 'number', description: 'Max events (default 40, max 80).' },
        include_tool_payloads: {
          type: 'boolean',
          description: 'Include truncated tool args and results (default false).',
        },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat'],
    },
    async handler(args, { client, session }) {
      const { chat } = await resolveScopedChatOrError(client, session, args);
      const history = await loadChatHistoryPage(client, chat.id, args);
      const page = formatHistoryPage(history, pageOptions(chat, history, {
        includeToolPayloads: args?.include_tool_payloads === true,
        forward: isPositiveSeq(args?.from_seq) > 0,
        section: 'history',
      }));
      const cursors = historyPageCursors(page, args);
      return mcpToolResult(assembleHistoryPageText({
        titleHeader: formatChatHeader(chat),
        section: 'history',
        headSeq: Number(history?.headSeq) || 0,
        body: page.text,
        events: page.events,
        cursors,
        chatId: chat.id,
      }), {
        ...summarizeChat(chat),
        head_seq: Number(history?.headSeq) || 0,
        oldest_seq: page.oldest_seq,
        newest_seq: page.newest_seq,
        events: page.events,
        next_from_seq: cursors.next_from_seq,
        next_before_seq: cursors.next_before_seq,
        truncated: cursors.truncated,
      });
    },
  },
  {
    name: 'chat_event',
    readOnly: true,
    description:
      'Read a UTF-16 code-unit slice of one chat event field (text, args, or result). Offsets are JavaScript string indexes; concatenating slices restores the source. Same-workspace by default; scope=all for another workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id (prefix ok) or title substring.' },
        seq: { type: 'number', description: 'Exact event seq. A gap does not return a neighbor.' },
        field: { type: 'string', description: 'text, args, or result.' },
        offset: { type: 'number', description: 'UTF-16 start offset (default 0).' },
        length: { type: 'number', description: 'Positive integer slice length (default 1500, max 4000).' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat', 'seq', 'field'],
    },
    async handler(args, { client, session }) {
      const { chat } = await resolveScopedChatOrError(client, session, args);
      const seq = requirePositiveSeq(args?.seq, 'seq');
      const field = String(args?.field || '').trim();
      if (!CHAT_EVENT_FIELDS.includes(field)) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'field must be text, args, or result.',
        );
      }
      const offset = requireNonNegativeInt(args?.offset, 'offset', 0);
      const parsedLength = parseEventSliceLength(args?.length);
      if (!parsedLength.ok) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR,
          'length must be a positive integer.',
        );
      }
      const history = await client.getChatHistory(chat.id, { seq });
      const raw = history?.event
        || (Array.isArray(history?.events) ? history.events.find((row) => Number(row?.seq) === seq) : null);
      if (!raw) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.NOT_FOUND,
          `No event seq=${seq} in chat ${chat.id}.`,
        );
      }
      const entry = unwrapHistoryEntry(raw);
      if (entry.seq !== seq) {
        throw new CretliMcpToolError(
          MCP_BUILTIN_ERROR_CODES.NOT_FOUND,
          `No event seq=${seq} in chat ${chat.id}.`,
        );
      }
      const source = readEventField(entry.rec, field);
      const slice = sliceEventField(source, offset, parsedLength.value);
      if (slice.truncated && !(Number(slice.next_offset) > offset)) {
        slice.next_offset = null;
        slice.truncated = false;
      }
      const lines = [
        `seq: ${seq}`,
        `field: ${field}`,
        `offset: ${slice.offset}`,
        `total_length: ${slice.total_length}`,
        slice.next_offset == null ? 'next_offset: none' : `next_offset: ${slice.next_offset}`,
      ];
      if (slice.truncated) lines.push('truncated: true');
      lines.push('', '--- fragment ---', slice.fragment);
      return mcpToolResult(lines.join('\n'), {
        seq,
        field,
        offset: slice.offset,
        next_offset: slice.next_offset,
        total_length: slice.total_length,
        truncated: slice.truncated,
      });
    },
  },
  {
    name: 'chat_archive',
    readOnly: false,
    description: 'Archive (close) or restore a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        archived: { type: 'boolean', description: 'true to archive (default), false to restore.' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat'],
    },
    async handler(args, { client, session }) {
      const { chat } = await resolveScopedChatOrError(client, session, args);
      const archived = args?.archived !== false;
      const updated = await client.archiveChat(chat.id, archived);
      return mcpTextResult(`${archived ? 'Archived' : 'Restored'}: ${updated?.title || chat.title} (${chat.id.slice(0, 8)})`);
    },
  },
  {
    name: 'chat_rename',
    readOnly: false,
    description: 'Rename a chat.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        title: { type: 'string' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat', 'title'],
    },
    async handler(args, { client, session }) {
      const title = String(args?.title || '').trim();
      if (!title) {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'chat_rename requires a non-empty title.');
      }
      const { chat } = await resolveScopedChatOrError(client, session, args);
      const updated = await client.renameChat(chat.id, title);
      return mcpTextResult(`Renamed to "${updated?.title}" (${chat.id.slice(0, 8)})`);
    },
  },
  {
    name: 'chat_delete',
    readOnly: false,
    description: 'Permanently delete a chat. Requires confirm=true.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string' },
        confirm: { type: 'boolean' },
        scope: { type: 'string', description: 'workspace (default) or all.' },
      },
      required: ['chat'],
    },
    async handler(args, { client, session }) {
      const { chat } = await resolveScopedChatOrError(client, session, args);
      if (args?.confirm !== true) {
        return mcpTextResult(
          `Delete "${chat.title || chat.id}" permanently? Call chat_delete again with confirm=true. Prefer chat_archive.`,
        );
      }
      await client.deleteChat(chat.id);
      return mcpTextResult(`Deleted: ${chat.title || chat.id}`);
    },
  },
  {
    name: 'mcp_list',
    readOnly: true,
    description: 'List MCP integrations available for this workspace and harness (no connection probes).',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { client }) {
      if (typeof client.listMcpIntegrations !== 'function') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'MCP registry is unavailable in this client.');
      }
      const rows = await client.listMcpIntegrations();
      if (!Array.isArray(rows) || rows.length === 0) {
        return mcpToolResult('(no MCP integrations in this context)', { items: [] });
      }
      const lines = rows.map((row) => {
        const scope = row.scope === 'all' ? 'all workspaces' : `workspaces ${JSON.stringify(row.scope)}`;
        return `${row.enabled === false ? '[off]' : '[on]'} ${row.name} (${String(row.id || '').slice(0, 8)}) harnesses=${(row.harnesses || []).join(',') || '-'} ${scope}`;
      });
      return mcpToolResult(lines.join('\n'), { items: rows });
    },
  },
  {
    name: 'mcp_status',
    readOnly: true,
    description: 'Show MCP config and connection status for this context (cached; does not re-test servers).',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, { client }) {
      if (typeof client.getMcpStatus !== 'function') {
        throw new CretliMcpToolError(MCP_BUILTIN_ERROR_CODES.VALIDATION_ERROR, 'MCP status is unavailable in this client.');
      }
      const rows = await client.getMcpStatus();
      if (!Array.isArray(rows) || rows.length === 0) {
        return mcpToolResult('(no MCP status yet)', { items: [] });
      }
      const lines = rows.map((row) => {
        const err = row.error ? ` error=${row.error}` : '';
        return `${row.serverId} harness=${row.harness || '-'} config=${row.configState} conn=${row.connectionState} rev=${row.appliedRevision}/${row.desiredRevision}${err}`;
      });
      return mcpToolResult(lines.join('\n'), { items: rows });
    },
  },
]);
