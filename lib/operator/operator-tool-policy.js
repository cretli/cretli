/**
 * Default-deny tool policy of the internal operator run chat.
 *
 * Applied by the builtin catalog gate BEFORE the Plan-mode, read-only and Scout
 * shortcuts: the operator observes and proposes, it never mutates. Anything not
 * listed here is denied, so a tool added to the catalog stays denied until
 * someone decides about it.
 */

import { resolveCretliBuiltinToolName } from '../mcp/mcp-tool-names.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../mcp/mcp-config.js';

export const OPERATOR_DENIED_MESSAGE =
  'The operator run is observe-and-propose only: this tool is not on its allowlist.';

/** Hidden tools that exist only for operator run chats. */
export const OPERATOR_ONLY_TOOL_NAMES = Object.freeze(['operator_note', 'operator_report']);

/**
 * Allowed builtin tools. `null` = any call; a Set = only these `action` values
 * (a missing action counts as `list`). Reads only, plus the two run protocol
 * tools. `cretli_feedback`, `voice_reply` and `chat_archive/delete/rename` are
 * deliberately absent.
 *
 * @type {ReadonlyMap<string, ReadonlySet<string> | null>}
 */
export const OPERATOR_BUILTIN_ALLOWLIST = new Map([
  ['todo_list', null],
  ['todo_show', null],
  ['todo_next_ready', null],
  ['watcher_show', null],
  ['watcher_status', null],
  ['workflow_show', null],
  ['chat_list', null],
  ['chat_show', null],
  ['chat_history', null],
  ['chat_search', null],
  ['wmem_list', null],
  ['lesson_list', null],
  ['usage_summary', null],
  ['scout_findings', new Set(['list'])],
  ['operator_note', null],
  ['operator_report', null],
]);

/**
 * @param {unknown} toolName
 * @param {unknown} [args]
 * @returns {{ allow: boolean, tool: string, action: string, reason: string }}
 */
export function resolveOperatorBuiltinToolDecision(toolName, args = {}) {
  const canonical = resolveCretliBuiltinToolName(String(toolName || '').trim(), {
    id: BUILTIN_CRETILI_SERVER_ID,
    kind: 'builtin-cretli',
  }) || String(toolName || '').trim();
  const tool = canonical.toLowerCase();
  const rawAction = args && typeof args === 'object' ? /** @type {any} */ (args).action : undefined;
  const action = String(rawAction === undefined || rawAction === null || rawAction === '' ? 'list' : rawAction).trim().toLowerCase();
  if (!OPERATOR_BUILTIN_ALLOWLIST.has(tool)) {
    return { allow: false, tool, action, reason: 'not_allowlisted' };
  }
  const actions = OPERATOR_BUILTIN_ALLOWLIST.get(tool);
  if (actions && !actions.has(action)) {
    return { allow: false, tool, action, reason: 'action_not_allowed' };
  }
  return { allow: true, tool, action, reason: 'allowlisted' };
}

/** @param {unknown} toolName @returns {boolean} */
export function isOperatorOnlyTool(toolName) {
  return OPERATOR_ONLY_TOOL_NAMES.includes(String(toolName || '').trim());
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[_-]?key|cookie|credential|private[_-]?key|bearer|session)/i;
export const OPERATOR_AUDIT_DETAIL_MAX_BYTES = 2048;

/**
 * Redacts secret-looking keys and caps the serialized arguments at 2 KB.
 *
 * @param {unknown} args
 * @returns {string}
 */
export function redactOperatorAuditArgs(args) {
  const seen = new WeakSet();
  const walk = (value, depth) => {
    if (value === null || typeof value !== 'object') return typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value;
    if (depth > 4 || seen.has(value)) return '[truncated]';
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => walk(item, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : walk(item, depth + 1);
    }
    return out;
  };
  let text;
  try { text = JSON.stringify(walk(args ?? {}, 0)) ?? '{}'; } catch { text = '"[unserializable]"'; }
  if (Buffer.byteLength(text) <= OPERATOR_AUDIT_DETAIL_MAX_BYTES) return text;
  return `${Buffer.from(text).subarray(0, OPERATOR_AUDIT_DETAIL_MAX_BYTES - 3).toString('utf8').replace(/�+$/, '')}…`;
}
