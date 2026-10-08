/**
 * Host-owned read-only policy for Scout chats.
 *
 * Scout runs in the technical `agent` transport mode (Plan/Ask mode makes
 * non-SDK harnesses abort), so the Plan/Ask allow-list does NOT protect it.
 * This policy is the authoritative gate applied by the host *before* a tool,
 * shell command or delegation executes, independent of the SDK/transport mode
 * and independent of any prompt text or profile argument.
 *
 * A chat is a Scout (and therefore read-only) only when the host chat store
 * says so (`pickPurpose: 'scout'`), never because a model or profile claimed it.
 *
 * Allowed: reads (file/grep/glob/read-only shell), builtin read-only MCP tools,
 * and the scan's own `scout_findings` `list`/`submit` protocol.
 * Denied: file writes/edits, mutating shell, every other MCP tool (builtin or
 * external), delegations/subagents, todo/config/browser mutations.
 */

import {
  getSdkToolCallName,
  isMutatingPlanModeShellCommand,
  isPlanModeShellToolName,
  readPlanModeShellCommand,
} from './sdk/sdk-plan-guard.js';
import {
  getBuiltinMcpMutatingTools,
  isExternalMcpToolName,
  isReadOnlyBuiltinMcpToolName,
  readEffectiveMcpToolName,
} from './mcp/mcp-policy.js';
import { resolveCretliBuiltinToolName } from './mcp/mcp-tool-names.js';
import {
  SCOUT_READ_ONLY_MESSAGE,
  isScoutProtocolToolCall,
  isScoutReadOnlyChat,
  isScoutReadOnlyChatId,
} from './workspace-scout-chat.js';

export {
  SCOUT_READ_ONLY_MESSAGE,
  isScoutProtocolToolCall,
  isScoutReadOnlyChat,
  isScoutReadOnlyChatId,
};
const SCOUT_DENIED_NATIVE_TOOLS = new Set([
  'agent',
  'delegation_start',
  'delegation_cancel',
  'delegation_reply',
  'subagent',
  'subagent_fork',
  'task',
  'todo',
  'todo_write',
  'todowrite',
  'exitplanmode',
  'workflow',
  'ralph',
  'apply_patch',
  'applypatch',
  'patch',
  'multiedit',
  'notebookedit',
  'str_replace_editor',
  'str_replace',
  'create_file',
  'edit_file',
  'write_file',
  'delete_file',
  'move_file',
  'rename_file',
  'killshell',
  'killbash',
  'taskstop',
  'monitor',
  'enterworktree',
  'croncreate',
  'remotetrigger',
  'sendmessage',
]);

/**
 * Known native / host tools that only read or inspect. Any other native name
 * is denied (fail-closed), including Claude Code tools such as `Monitor`.
 */
const SCOUT_ALLOWED_NATIVE_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'notebookread',
  'webfetch',
  'websearch',
  'web_search',
  'web_fetch',
  'web.search',
  'read_file',
  'list_directory',
  'list_files',
  'git_status',
  'git_diff',
  'git_log',
  'semsearch',
  'askuserquestion',
  'bashoutput',
  'listmcpresources',
  'listmcpresourcestool',
  'readmcpresource',
  'readmcpresourcedir',
  'readmcpresourcedirtool',
  'readmcpresourcetool',
  'skill',
  'fetch',
  'search',
  'read file',
]);

/** Suffix/substring patterns that always mutate, even for an unknown tool name. */
const SCOUT_DENIED_NATIVE_TOOL_PATTERNS = Object.freeze([
  /^apply_?patch$/,
  /(?:^|[._/])(write|edit|delete|move|rename|mkdir|rmdir|create_file)(?:$|[._/])/,
]);

/**
 * Harnesses whose host-side read-only enforcement is actually wired. The list is
 * closed on purpose: a profile that names any other harness could not be promised
 * that file writes, delegations and mutating MCP calls are blocked, so the
 * preview/start gate fails closed instead of claiming a guarantee the host cannot
 * enforce.
 */
export const SCOUT_READ_ONLY_ENFORCING_HARNESSES = Object.freeze([
  'sdk',
  'openrouter',
  'opencode',
  'codebuddy',
  'deepseek',
  'codex',
  'qwen',
  'claude',
]);

/**
 * Whether the host can enforce the read-only Scout policy for one harness id.
 * Unknown, empty or unsupported harnesses answer `false` (fail closed).
 *
 * @param {unknown} harness
 * @returns {boolean}
 */
export function scoutReadOnlyEnforcementSupported(harness) {
  const id = String(harness ?? '').trim().toLowerCase();
  return SCOUT_READ_ONLY_ENFORCING_HARNESSES.includes(id);
}

/**
 * @param {unknown} session
 * @param {{ loadChats?: () => unknown[] }} [options]
 * @returns {boolean}
 */
export function isScoutReadOnlySession(session, options = {}) {
  if (!session || typeof session !== 'object') return false;
  const row = /** @type {Record<string, unknown>} */ (session);
  if (row.readOnlyScout === true) return true;
  if (isScoutReadOnlyChat(row.chat)) return true;
  return isScoutReadOnlyChatId(row.chatId, options);
}

/**
 * @param {unknown} toolName
 * @returns {string}
 */
function normalizedToolName(toolName) {
  return String(toolName || '').trim().toLowerCase();
}

/**
 * Whether a name is one of the builtin mutating MCP tools, counting a legacy
 * alias and any `mcp__<cretli runtime>__<tool>` shape. The classification must
 * match the canonical name exactly, or a renamed mutating tool would be caught
 * only by the fail-closed default instead of this explicit deny. Names owned by
 * another server are not classified here; they fall through to the external
 * branch, which is deny-by-default.
 *
 * @param {string} toolName
 * @param {readonly string[]} mutatingTools
 * @returns {boolean}
 */
function isBuiltinMutatingMcpToolName(toolName, mutatingTools) {
  if (!toolName) return false;
  if (mutatingTools.includes(toolName)) return true;
  const builtin = resolveCretliBuiltinToolName(toolName);
  return builtin !== null && mutatingTools.includes(builtin);
}

/**
 * @param {string} toolName normalized lowercase
 * @returns {boolean}
 */
function isScoutAllowedReadOnlyNativeTool(toolName) {
  if (!toolName) return false;
  if (SCOUT_ALLOWED_NATIVE_TOOLS.has(toolName)) return true;
  const dotted = toolName.split(/[./]/);
  const lastDotted = dotted[dotted.length - 1] || '';
  if (SCOUT_ALLOWED_NATIVE_TOOLS.has(lastDotted)) return true;
  const lastSegment = toolName.split('__').pop() || toolName;
  if (SCOUT_ALLOWED_NATIVE_TOOLS.has(lastSegment)) return true;
  return isReadOnlyBuiltinMcpToolName(toolName);
}

/**
 * Whether a builtin Cretli MCP tool may run for a Scout.
 *
 * @param {{ readOnly?: boolean, name?: string } | null | undefined} tool
 * @param {unknown} toolName
 * @param {unknown} args
 * @returns {{ deny: boolean, reason: string }}
 */
export function resolveScoutBuiltinMcpToolDecision(tool, toolName, args) {
  if (tool?.readOnly === true) return { deny: false, reason: '' };
  if (isScoutProtocolToolCall(toolName, args)) return { deny: false, reason: '' };
  return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
}

/**
 * External MCP tools are opaque to the host, so a Scout never gets one.
 *
 * @returns {{ deny: boolean, reason: string }}
 */
export function resolveScoutExternalMcpToolDecision() {
  return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
}

/**
 * Pre-exec decision for a native SDK/CLI tool call.
 *
 * @param {{ toolName?: unknown, args?: unknown }} [input]
 * @returns {{ deny: boolean, reason: string }}
 */
export function resolveScoutNativeToolDecision(input = {}) {
  const toolName = normalizedToolName(input.toolName);
  if (!toolName) return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
  const args = input.args && typeof input.args === 'object'
    ? /** @type {Record<string, unknown>} */ (input.args)
    : {};

  if (isScoutProtocolToolCall(toolName, args)) return { deny: false, reason: '' };

  // A builtin MCP tool invoked by its bare name (no `mcp__` wrapper) is still a
  // mutation: `scout_findings` accept, `todo_create`, `delegation_start`
  // and friends must never slip through the "unknown name" default.
  const mutatingTools = getBuiltinMcpMutatingTools();
  const bare = toolName.split(/[./]/).pop()?.split('__').pop() || toolName;
  if (
    isBuiltinMutatingMcpToolName(toolName, mutatingTools)
    || isBuiltinMutatingMcpToolName(bare, mutatingTools)
  ) {
    return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
  }

  if (isExternalMcpToolName(toolName)) {
    const effective = readEffectiveMcpToolName(toolName, args);
    if (isScoutProtocolToolCall(effective, args)) return { deny: false, reason: '' };
    if (isScoutProtocolToolCall(toolName, args)) return { deny: false, reason: '' };
    const effectiveBare = effective.split(/[./]/).pop()?.split('__').pop() || effective;
    if (
      isBuiltinMutatingMcpToolName(effective, mutatingTools)
      || isBuiltinMutatingMcpToolName(effectiveBare, mutatingTools)
    ) {
      return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
    }
    if (isReadOnlyBuiltinMcpToolName(effective)) return { deny: false, reason: '' };
    return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
  }

  if (isPlanModeShellToolName(toolName)) {
    const command = readPlanModeShellCommand(args.command ?? args.cmd ?? args.commandLine);
    if (!command) return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
    return isMutatingPlanModeShellCommand(command)
      ? { deny: true, reason: SCOUT_READ_ONLY_MESSAGE }
      : { deny: false, reason: '' };
  }

  if (SCOUT_DENIED_NATIVE_TOOLS.has(toolName)) {
    return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
  }
  if (SCOUT_DENIED_NATIVE_TOOL_PATTERNS.some((pattern) => pattern.test(toolName))) {
    return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
  }
  if (isScoutAllowedReadOnlyNativeTool(toolName)) return { deny: false, reason: '' };
  return { deny: true, reason: SCOUT_READ_ONLY_MESSAGE };
}

/**
 * Pre-exec decision for a normalized SDK stream event.
 *
 * @param {unknown} event
 * @returns {{ deny: boolean, abortRun: boolean, notify: boolean, reason: string }}
 */
export function resolveScoutReadOnlySdkEventDecision(event) {
  if (!event || typeof event !== 'object') {
    return { deny: false, abortRun: false, notify: false, reason: '' };
  }
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'tool_call') return { deny: false, abortRun: false, notify: false, reason: '' };
  const status = typeof ev.status === 'string' ? ev.status.trim().toLowerCase() : '';
  if (status && status !== 'running' && status !== 'started' && status !== 'pending') {
    return { deny: false, abortRun: false, notify: false, reason: '' };
  }
  const toolName = getSdkToolCallName(ev);
  const args = ev.args && typeof ev.args === 'object' && !Array.isArray(ev.args)
    ? /** @type {Record<string, unknown>} */ (ev.args)
    : {};
  const decision = resolveScoutNativeToolDecision({ toolName, args });
  if (!decision.deny) return { deny: false, abortRun: false, notify: false, reason: '' };
  return { deny: true, abortRun: true, notify: true, reason: decision.reason };
}

/**
 * Audit label for a blocked Scout action (used by notices).
 *
 * @param {unknown} toolName
 * @returns {string}
 */
export function describeScoutReadOnlyTool(toolName) {
  return getSdkToolCallName({ name: String(toolName || '') }) || String(toolName || 'unknown');
}
