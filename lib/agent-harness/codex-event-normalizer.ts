/**
 * Maps Codex SDK ThreadEvent payloads to SDK-shaped chat events.
 */

import { readPlanModeShellCommand } from '../sdk/sdk-plan-guard.ts';
import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.ts';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return (value as Record<string, unknown>);
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readEventType(event: unknown): string {
  const rec = asRecord(event);
  if (!rec) return '';
  return readString(rec.type) || readString(rec.kind);
}

export function readCodexThreadId(event: unknown): string {
  const rec = asRecord(event);
  if (!rec) return '';
  const direct = readString(rec.thread_id) || readString(rec.threadId);
  if (direct) return direct;
  const item = asRecord(rec.item);
  if (item) {
    const fromItem = readString(item.thread_id) || readString(item.threadId);
    if (fromItem) return fromItem;
  }
  return '';
}

function readItemId(item: unknown): string {
  const rec = asRecord(item);
  if (!rec) return '';
  return readString(rec.id) || readString(rec.item_id) || readString(rec.itemId);
}

function normalizeItemTypeToken(value: unknown): string {
  return readString(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
}

function readItemType(item: unknown): string {
  const rec = asRecord(item);
  if (!rec) return '';
  const raw = normalizeItemTypeToken(rec.type || rec.item_type || rec.itemType);
  if (raw === 'extension') {
    const kind = normalizeItemTypeToken(rec.kind);
    if (kind === 'web_search' || kind === 'websearch') return 'web_search';
    return kind || raw;
  }
  if (raw === 'websearch' || raw === 'web_search') return 'web_search';
  return raw;
}

function readParsedCmd(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const parts: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      parts.push(entry.trim());
      continue;
    }
    const nested = asRecord(entry);
    if (!nested) continue;
    const cmd = readString(nested.cmd) || readString(nested.command);
    if (cmd) parts.push(cmd);
  }
  return parts.join(' && ');
}

function readCommandFromItem(item: Record<string, unknown>): string {
  const fromArgv = readPlanModeShellCommand(item.command ?? item.aggregated_command);
  if (fromArgv) return fromArgv;
  return readParsedCmd(item.parsed_cmd ?? item.parsedCmd);
}

function readItemText(item: unknown): string {
  const rec = asRecord(item);
  if (!rec) return '';
  const direct = readString(rec.text);
  if (direct) return direct;
  const content = rec.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string' && block.trim()) {
        parts.push(block.trim());
        continue;
      }
      const nested = asRecord(block);
      if (!nested) continue;
      const text = readString(nested.text);
      if (text) parts.push(text);
    }
    return parts.join('');
  }
  return '';
}

function readReasoningSummary(item: unknown): string {
  const rec = asRecord(item);
  if (!rec || !Array.isArray(rec.summary)) return '';
  return rec.summary.map((entry) => {
    if (typeof entry === 'string') return entry.trim();
    const block = asRecord(entry);
    return readString(block?.text).trim();
  }).filter(Boolean).join('\n');
}

/** The app-server spells MCP results camelCase; the SDK path uses `structured_content`. */
function normalizeMcpResult(result: unknown): unknown {
  const rec = asRecord(result);
  if (!rec || !('structuredContent' in rec)) return result;
  const { structuredContent, ...rest } = rec;
  return { ...rest, structured_content: structuredContent };
}

function readToolPayload(itemType: string, item: Record<string, unknown>): { name: string, args: Record<string, unknown>, result?: unknown } {
  if (itemType === 'command_execution') {
    const command = readCommandFromItem(item);
    const output = item.aggregated_output ?? item.output ?? item.aggregatedOutput;
    return {
      name: 'shell',
      args: command ? { command } : {},
      result: output,
    };
  }
  if (itemType === 'file_change') {
    const changes = item.changes ?? item.files ?? item.paths ?? [];
    const paths = Array.isArray(changes)
      ? changes
        .map((change) => {
          if (typeof change === 'string') return change;
          const row = asRecord(change);
          return readString(row?.path) || readString(row?.file) || '';
        })
        .filter(Boolean)
      : [];
    return {
      name: 'edit',
      args: {
        changes,
        ...(paths.length > 0 ? { paths } : {}),
      },
    };
  }
  if (itemType === 'mcp_tool_call') {
    const name = readString(item.tool) || readString(item.name) || 'mcp';
    const args = asRecord(item.arguments) || asRecord(item.args) || asRecord(item.input) || {};
    return {
      name,
      args,
      result: normalizeMcpResult(item.result ?? item.output),
    };
  }
  if (itemType === 'web_search') {
    const query = readString(item.query);
    return {
      name: 'web_search',
      args: query ? { query } : {},
      result: item.results ?? item.output,
    };
  }
  if (itemType === 'todo_list') {
    return {
      name: 'todo',
      args: { items: item.items ?? item.todos ?? [] },
    };
  }
  return {
    name: readString(item.name) || itemType || 'tool',
    args: asRecord(item.arguments) || asRecord(item.args) || asRecord(item.input) || {},
    result: item.result ?? item.output,
  };
}

function normalizeItem(item: unknown, status: 'running' | 'completed'): Array<Record<string, unknown>> {
  const rec = asRecord(item);
  if (!rec) return [];
  const itemType = readItemType(rec);
  if (itemType === 'reasoning') {
    const text = readItemText(rec) || readReasoningSummary(rec);
    // Codex may expose only encrypted_content and an empty summary. Keep a
    // safe UI signal in that case, but never forward the encrypted payload.
    return text
      ? [{ type: 'thinking', text }]
      : [{ type: 'thinking', text: '', unavailable: true }];
  }
  if (itemType === 'agent_message' || itemType === 'message') {
    if (status !== 'completed') return [];
    const text = readItemText(rec);
    return text ? [buildAssistantDeltaEvent(text)] : [];
  }
  if (itemType === 'error') {
    const message = readItemText(rec) || readString(rec.message) || 'Codex item error';
    return [{ kind: 'error', message }];
  }
  const toolTypes = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list']);
  if (!toolTypes.has(itemType) && itemType !== 'tool_call' && itemType !== 'command') {
    return [];
  }
  const payload = readToolPayload(itemType, rec);
  const itemStatus = readString(rec.status).toLowerCase();
  const failed = itemStatus === 'failed' || itemStatus === 'error';
  const event = buildToolCallEvent({
    callId: readItemId(rec) || itemType,
    name: payload.name,
    status: failed ? 'error' : status,
    args: payload.args,
    result: status === 'completed' ? payload.result : undefined,
  });
  return [event];
}

export function normalizeCodexThreadEvent(event: unknown): Array<Record<string, unknown>> {
  let rec: Record<string, unknown> | null = asRecord(event);
  if (!rec) return [];
  if (typeof rec.method === 'string') {
    const params = asRecord(rec.params) || {};
    const turn = asRecord(params.turn);
    rec = { ...params, type: rec.method.replace('/', '.'), thread_id: params.threadId };
    if (rec.type === 'turn.completed' && turn?.error) rec = { ...rec, type: 'turn.failed', error: turn.error };
    if (rec.type === 'thread.tokenUsage/updated') return [];
  }
  const type = readEventType(rec);
  const threadId = readCodexThreadId(rec);
  if (type === 'thread.started') {
    return threadId ? [{ kind: 'thread', threadId }] : [];
  }
  if (type === 'turn.started') {
    return [{ kind: 'turn', status: 'started', threadId }];
  }
  if (type === 'turn.completed') {
    const usage = asRecord(rec.usage);
    return [
      { kind: 'turn', status: 'completed', threadId },
      ...(usage ? [{ kind: 'usage', usage }] : []),
    ];
  }
  if (type === 'turn.failed') {
    const error = asRecord(rec.error);
    const message = readString(error?.message) || readString(rec.message) || 'Codex turn failed';
    return [{ kind: 'turn', status: 'failed', threadId, message }];
  }
  if (type === 'error') {
    const message = readString(rec.message) || 'Codex error';
    return [{ kind: 'error', message, threadId }];
  }
  if (type === 'item.started') {
    return normalizeItem(rec.item, 'running');
  }
  if (type === 'item.updated') {
    const item = asRecord(rec.item);
    const itemStatus = readString(item?.status).toLowerCase();
    const status = itemStatus === 'completed' || itemStatus === 'failed' || itemStatus === 'error'
      ? 'completed'
      : 'running';
    return normalizeItem(item, status);
  }
  if (type === 'item.completed') {
    return normalizeItem(rec.item, 'completed');
  }
  return [];
}
