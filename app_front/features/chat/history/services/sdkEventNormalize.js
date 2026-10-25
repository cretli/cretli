/**
 * Pure helpers that normalize persisted agent rows and SDK events for the rich view.
 */

import { t } from '../../../../i18n/index.js';

/** Translate a persisted reviewer session code, with legacy text as fallback. */
export function reviewerSessionLabel(prefix, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const key = `${prefix}.${text}`;
  const translated = t(key);
  return translated === key ? text : translated;
}

/**
 * Strips technical SDK telemetry lines from the plaintext history buffer,
 * so an old buffer does not mix tool statuses into the assistant answer.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripSdkTelemetryLines(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return '';
  const telemetryLinePattern =
    /^\[(status\s+[^\]]+|tool\s+[^\]]+|system|task|sdk\s+[^\]]+|SDK|OpenCode|OpenRouter|run finished:[^\]]*|SDK busy|SDK error|Mode:[^\]]*|request[^\]]*)\](?:\s.*)?$/i;
  return raw
    .split('\n')
    .filter((line) => !telemetryLinePattern.test(line.trim()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimeoutProgressSeconds(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const mm = Math.floor(safe / 60);
  const ss = safe % 60;
  if (mm <= 0) return `${ss}s`;
  return `${mm}m ${ss}s`;
}

/**
 * @param {unknown} args
 * @returns {string[]}
 */
export function pathsFromToolArgs(args) {
  if (!args || typeof args !== 'object') return [];
  const o = /** @type {Record<string, unknown>} */ (args);
  const keys = ['path', 'file_path', 'target_file', 'filePath', 'filename'];
  const out = [];
  for (const k of keys) {
    if (typeof o[k] === 'string') out.push(o[k]);
  }
  if (Array.isArray(o.paths)) {
    for (const p of o.paths) {
      if (typeof p === 'string') out.push(p);
    }
  }
  return [...new Set(out)];
}

/**
 * @param {unknown} val
 * @param {number} max
 * @returns {string}
 */
export function stringifySnippet(val, max) {
  if (val == null) return '';
  try {
    const s = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(val);
  }
}

/**
 * @param {unknown} ev
 * @returns {string}
 */
export function extractUserPlain(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const e = /** @type {Record<string, unknown>} */ (ev);
  const msg = e.message && typeof e.message === 'object' ? /** @type {Record<string, unknown>} */ (e.message) : null;
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  let t = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = /** @type {Record<string, unknown>} */ (block);
    if (b.type === 'text' && typeof b.text === 'string') t += b.text;
  }
  return t;
}

/**
 * @param {string} rawKey
 * @returns {string}
 */
function normalizeToolName(rawKey) {
  const k = String(rawKey || '').trim();
  if (!k) return 'tool';
  const base = k.endsWith('ToolCall') ? k.slice(0, -8) : k;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Converts a single Agent.messages.list row (agentConversationTurn) into a sequence of SDK events.
 *
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>[]}
 */
export function sdkEventsFromAgentRow(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  const turn =
    row.message &&
    typeof row.message === 'object' &&
    row.message.agentConversationTurn &&
    typeof row.message.agentConversationTurn === 'object'
      ? row.message.agentConversationTurn
      : null;
  if (!turn) return out;

  const userText =
    turn.userMessage && typeof turn.userMessage === 'object' && typeof turn.userMessage.text === 'string'
      ? turn.userMessage.text
      : '';
  if (userText.trim()) {
    out.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: userText }],
      },
    });
  }

  const steps = Array.isArray(turn.steps) ? turn.steps : [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;

    const assistantText =
      step.assistantMessage &&
      typeof step.assistantMessage === 'object' &&
      typeof step.assistantMessage.text === 'string'
        ? step.assistantMessage.text
        : '';
    if (assistantText.trim()) {
      out.push({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: assistantText }],
        },
      });
    }

    const thinkingText =
      step.thinkingMessage &&
      typeof step.thinkingMessage === 'object' &&
      typeof step.thinkingMessage.text === 'string'
        ? step.thinkingMessage.text
        : '';
    if (thinkingText.trim()) {
      out.push({ type: 'thinking', text: thinkingText });
    }

    if (step.usage && typeof step.usage === 'object' && !Array.isArray(step.usage)) {
      out.push({ type: 'usage', usage: step.usage });
    }

    const statusText =
      step.statusMessage &&
      typeof step.statusMessage === 'object' &&
      typeof step.statusMessage.text === 'string'
        ? step.statusMessage.text
        : '';
    if (statusText.trim()) {
      out.push({ type: 'status', status: statusText, message: '' });
    }

    const toolCall = step.toolCall;
    if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) continue;
    for (const key of Object.keys(toolCall)) {
      const payload = toolCall[key];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const result = payload.result;
      const status = result && typeof result === 'object' && result.error ? 'error' : 'completed';
      out.push({
        type: 'tool_call',
        name: normalizeToolName(key),
        status,
        args: payload.args && typeof payload.args === 'object' ? payload.args : {},
        result: result && typeof result === 'object' ? result : undefined,
        call_id: typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined,
      });
    }
  }

  if (turn.usage && typeof turn.usage === 'object' && !Array.isArray(turn.usage)) {
    out.push({ type: 'usage', usage: turn.usage });
  }

  return out;
}
