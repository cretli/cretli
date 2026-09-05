/**
 * Maps Codex SDK ThreadEvent payloads to SDK-shaped chat events.
 */

import { readPlanModeShellCommand } from '../sdk/sdk-plan-guard.js';
import { buildAssistantDeltaEvent, buildToolCallEvent } from './event-normalizer.js';

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asRecord(value) {
  if (!value || typeof value !== 'object') return null;
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function readEventType(event) {
  const rec = asRecord(event);
  if (!rec) return '';
  return readString(rec.type) || readString(rec.kind);
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function readCodexThreadId(event) {
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

/**
 * @param {unknown} item
 * @returns {string}
 */
function readItemId(item) {
  const rec = asRecord(item);
  if (!rec) return '';
  return readString(rec.id) || readString(rec.item_id) || readString(rec.itemId);
}

/**
 * @param {unknown} item
 * @returns {string}
 */
/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeItemTypeToken(value) {
  return readString(value).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function readItemType(item) {
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

/**
 * @param {unknown} value
 * @returns {string}
 */
function readParsedCmd(value) {
  if (!Array.isArray(value)) return '';
  const parts = [];
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

/**
 * @param {Record<string, unknown>} item
 * @returns {string}
 */
function readCommandFromItem(item) {
  const fromArgv = readPlanModeShellCommand(item.command ?? item.aggregated_command);
  if (fromArgv) return fromArgv;
  return readParsedCmd(item.parsed_cmd ?? item.parsedCmd);
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function readItemText(item) {
  const rec = asRecord(item);
  if (!rec) return '';
  const direct = readString(rec.text);
  if (direct) return direct;
  const content = rec.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const parts = [];
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

/**
 * @param {string} itemType
 * @param {Record<string, unknown>} item
 * @returns {{ name: string, args: Record<string, unknown>, result?: unknown }}
 */
function readToolPayload(itemType, item) {
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
    return {
      name: 'edit',
      args: {
        changes: item.changes ?? item.files ?? item.paths ?? [],
      },
    };
  }
  if (itemType === 'mcp_tool_call') {
    const name = readString(item.tool) || readString(item.name) || 'mcp';
    const args = asRecord(item.arguments) || asRecord(item.args) || asRecord(item.input) || {};
    return {
      name,
      args,
      result: item.result ?? item.output,
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

/**
 * @param {unknown} item
 * @param {'running' | 'completed'} status
 * @returns {Array<Record<string, unknown>>}
 */
function normalizeItem(item, status) {
  const rec = asRecord(item);
  if (!rec) return [];
  const itemType = readItemType(rec);
  if (itemType === 'agent_message' || itemType === 'reasoning' || itemType === 'message') {
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
  const event = buildToolCallEvent({
    callId: readItemId(rec) || itemType,
    name: payload.name,
    status,
    args: payload.args,
    result: status === 'completed' ? payload.result : undefined,
  });
  return [event];
}

/**
 * @param {unknown} event
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeCodexThreadEvent(event) {
  const rec = asRecord(event);
  if (!rec) return [];
  const type = readEventType(rec);
  const threadId = readCodexThreadId(rec);
  if (type === 'thread.started') {
    return threadId ? [{ kind: 'thread', threadId }] : [];
  }
  if (type === 'turn.started') {
    return [{ kind: 'turn', status: 'started', threadId }];
  }
  if (type === 'turn.completed') {
    return [{ kind: 'turn', status: 'completed', threadId }];
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
  if (type === 'item.completed') {
    return normalizeItem(rec.item, 'completed');
  }
  return [];
}
