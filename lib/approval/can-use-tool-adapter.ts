/**
 * Harness-neutral adapter for `canUseTool` style callbacks (Claude, Qwen).
 *
 * Maps `(toolName, input)` to the permission event shape the local approval
 * broker already classifies, then records an audit entry tagged with the real
 * harness. Classification and audit only: it never replies. The effective
 * decision (local allow/deny, human card, advisor) is made by
 * `can-use-tool-permission.js`, which audits through the same helpers.
 */
import { randomUUID } from 'node:crypto';
import { mcpBuiltinToolBridgeEncodedName, encodeMcpToolName } from '../mcp/mcp-tool-names.js';
import { BUILTIN_CRETILI_SERVER_ID } from '../mcp/mcp-config.js';
import { isReviewProtocolMcpToolName } from '../mcp/mcp-policy.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { readApprovalBrokerMode } from './approval-broker.ts';
import { recordApprovalAudit } from './approval-broker.ts';
import { resolveApprovalPolicyVersion, normalizePermissionRequest } from './permission-request.ts';
import { resolveApprovalAction } from './permission-classifier.ts';

// Only exact builtin names qualify; external MCP tools stay permission-gated.
const TODO_READ_TOOLS = new Set(['todo_list', 'todo_next_ready', 'todo_show'].flatMap((name) => [
  mcpBuiltinToolBridgeEncodedName(name),
  encodeMcpToolName(BUILTIN_CRETILI_SERVER_ID, name),
]));
const REVIEW_REPLY_TOOLS = new Set([
  mcpBuiltinToolBridgeEncodedName('delegation_reply'),
  encodeMcpToolName(BUILTIN_CRETILI_SERVER_ID, 'delegation_reply'),
]);

const EDIT_TOOLS = new Set(['edit', 'write', 'write_file', 'search_replace', 'multiedit', 'notebookedit']);

/** Room fields read by the callback audit (callers may pass wider objects). */
export type CanUseToolRoom = {
  sdkMode?: unknown,
  delegationAssignment?: unknown,
  cwd?: string,
  chatId?: unknown,
};

export type CanUseToolPermissionEvent = {
  requestId: string,
  action: string,
  resources: string[],
  metadata: { command: string },
};

export type CanUseToolParams = {
  harness: string,
  toolName: unknown,
  input?: Record<string, unknown>,
  sdkMode?: unknown,
  assignment?: unknown,
  workspaceFolder?: string,
  scoutReadOnly?: boolean,
  mode?: unknown,
  requestId?: string,
};

type ClassifiedAction = ReturnType<typeof resolveApprovalAction> & { policyVersion: string, [key: string]: unknown };

function mapToolAction(toolName: unknown, assignment: unknown, scoutReadOnly: boolean): string {
  const rawName = String(toolName || '').trim();
  // Review reports use the job protocol, while every foreign namespace and
  // other assignment retains its existing permission classification.
  const protocolName = rawName.replace(/^functions\./, '').replace(/[./]/g, '__');
  if (!scoutReadOnly && isReviewReadOnlyAssignment(assignment)
    && isReviewProtocolMcpToolName(rawName)
    && REVIEW_REPLY_TOOLS.has(protocolName)) return 'read';
  if (TODO_READ_TOOLS.has(String(toolName || '').trim())) return 'read';
  const name = String(toolName || '').trim().toLowerCase();
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (name === 'read_file') return 'read';
  if (name === 'list_directory') return 'ls';
  if (name === 'run_terminal_command') return 'bash';
  if (name === 'bash' || name === 'run_shell_command' || name === 'shell') return 'bash';
  if (name === 'webfetch' || name === 'websearch') return 'webfetch';
  return name.replace(/[^a-z0-9_]+/g, '_') || 'unknown';
}

export function buildCanUseToolPermissionEvent(
  { toolName, input = {}, requestId = '', assignment, scoutReadOnly = false }:
  { harness: string, toolName: unknown, input?: Record<string, unknown>, requestId?: string, assignment?: unknown, scoutReadOnly?: boolean },
): CanUseToolPermissionEvent {
  const data: Record<string, unknown> = input && typeof input === 'object' ? input : {};
  const command = typeof data.command === 'string' ? data.command : '';
  const paths = [data.file_path, data.path, data.notebook_path, data.filePath]
    .filter((entry) => typeof entry === 'string' && entry.trim());
  return {
    requestId: String(requestId || ''),
    action: mapToolAction(toolName, assignment, scoutReadOnly),
    resources: paths.map(String),
    metadata: { command },
  };
}

/**
 * Local classification of one callback invocation. Never returns a reply.
 */
export function classifyCanUseToolRequest(params: CanUseToolParams): { permissionEvent: CanUseToolPermissionEvent, action: ClassifiedAction } {
  const permissionEvent = buildCanUseToolPermissionEvent(params);
  const action = resolveApprovalAction({
    mode: params.mode,
    sdkMode: params.sdkMode,
    permissionEvent,
    assignment: params.assignment,
    workspaceFolder: params.workspaceFolder,
    scoutReadOnly: params.scoutReadOnly === true,
  });
  return {
    permissionEvent,
    action: {
      ...action,
      policyVersion: resolveApprovalPolicyVersion(params.harness),
    },
  };
}

/**
 * Sanitized neutral request for advisor/audit consumers (basenames only).
 */
export function toNormalizedCanUseToolRequest(params: Parameters<typeof classifyCanUseToolRequest>[0]): ReturnType<typeof normalizePermissionRequest> {
  const { permissionEvent, action } = classifyCanUseToolRequest(params);
  return normalizePermissionRequest({
    harness: params.harness,
    permissionEvent,
    approvalAction: action,
  });
}

/**
 * Record one local-only audit entry (no-op while the broker mode is `off`).
 */
export function auditCanUseToolPermission(
  params: { harness: string, room?: CanUseToolRoom | null, toolName: unknown, input?: Record<string, unknown>, settings?: Record<string, unknown> | null, requestId?: string, sdkMode?: unknown, scoutReadOnly?: boolean },
  options: { file?: string } = {},
): Record<string, unknown> | null {
  const mode = readApprovalBrokerMode(params.settings);
  const room = params.room || {};
  const { permissionEvent, action } = classifyCanUseToolRequest({
    ...params,
    mode,
    sdkMode: params.sdkMode ?? room.sdkMode,
    assignment: room.delegationAssignment,
    workspaceFolder: room.cwd,
    scoutReadOnly: params.scoutReadOnly === true,
  });
  return writeCanUseToolAudit({ harness: params.harness, room, permissionEvent, action }, options);
}

/**
 * Local plan/review/scout guard denial. Always recorded as a local reject with
 * the callback's requestId (no-op while the broker mode is `off`).
 */
export function auditCanUseToolGuardDeny(params: Parameters<typeof auditCanUseToolPermission>[0], options: { file?: string } = {}): Record<string, unknown> | null {
  const mode = readApprovalBrokerMode(params.settings);
  const room = params.room || {};
  const { permissionEvent, action } = classifyCanUseToolRequest({
    ...params,
    requestId: params.requestId || randomUUID(),
    mode,
    sdkMode: params.sdkMode ?? room.sdkMode,
    assignment: room.delegationAssignment,
    workspaceFolder: room.cwd,
    scoutReadOnly: params.scoutReadOnly === true,
  });
  const denied = { ...action, decision: 'deny', reply: 'reject', reason: 'plan_or_review_guard', shadow: false };
  return writeCanUseToolAudit({ harness: params.harness, room, permissionEvent, action: denied }, options);
}

/**
 * Append one audit row for an already-classified callback invocation.
 */
export function writeCanUseToolAudit(
  input: { harness: string, room?: CanUseToolRoom | null, permissionEvent: CanUseToolPermissionEvent, action: Parameters<typeof recordApprovalAudit>[0]['action'] },
  options: { file?: string } = {},
): Record<string, unknown> | null {
  const { permissionEvent, action, room } = input;
  const params = { harness: input.harness };
  // Audit entries carry basenames only, never absolute host paths.
  const safeEvent = {
    ...permissionEvent,
    resources: permissionEvent.resources.map((entry) => String(entry).split(/[\\/]/).pop() || ''),
    metadata: { command: normalizePermissionRequest({ permissionEvent, approvalAction: action }).command },
  };
  return recordApprovalAudit({
    harness: params.harness,
    room,
    permissionEvent: safeEvent,
    action,
  }, options);
}
