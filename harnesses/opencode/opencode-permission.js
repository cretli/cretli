/**
 * OpenCode permission skill — normalize SSE events and reply via HTTP API.
 *
 * The harness-neutral classifier and approval policy (`resolveOpenCodeApprovalAction`
 * and friends) lives in core at lib/approval/permission-classifier.ts and is
 * re-exported here so the plugin keeps one import point.
 */

import { isOpenCodeEventForSession } from './opencode-event-normalizer.js';
import { postOpenCodeInstanceWithFallback } from './opencode-instance-http.js';
import { readOpenCodeEventPayload, readOpenCodeRequestId } from './opencode-question.js';

export * from '../../lib/approval/permission-classifier.ts';

// Former OpenCode-prefixed names of the core policy functions (plugin callers and tests).
export {
  buildPlanPermissionRuleset as buildOpenCodePlanPermissionRuleset,
  classifyPermissionRisk as classifyOpenCodePermissionRisk,
  isPermissionWithinWorkspace as isOpenCodePermissionWithinWorkspace,
  isPlanMutatingPermission as isOpenCodePlanMutatingPermission,
  resolveApprovalAction as resolveOpenCodeApprovalAction,
  shouldAutoAllowDelegationPermission as shouldAutoAllowOpenCodeDelegationPermission,
  shouldAutoAllowReviewPermission as shouldAutoAllowOpenCodeReviewPermission,
  shouldRejectPlanPermission as shouldRejectOpenCodePlanPermission,
} from '../../lib/approval/permission-classifier.ts';

/** @typedef {import('../../lib/approval/permission-classifier.ts').PermissionReply} PermissionReply */

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {Record<string, unknown> | null}
 */
export function buildOpenCodePermissionSdkEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  if (!isOpenCodeEventForSession(event, context.opencodeSessionId)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'permission.asked' && type !== 'permission.v2.asked') return null;
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const sessionId = typeof payload.sessionID === 'string'
    ? payload.sessionID
    : typeof context.opencodeSessionId === 'string'
      ? context.opencodeSessionId
      : '';
  const requestId = readOpenCodeRequestId(payload);
  if (!requestId) return null;
  const action = typeof payload.action === 'string'
    ? payload.action.trim()
    : typeof payload.permission === 'string'
      ? payload.permission.trim()
      : 'Permission required';
  const resources = readOpenCodePermissionResources(payload);
  const saveOptions = Array.isArray(payload.save)
    ? payload.save.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
    : Array.isArray(payload.always)
      ? payload.always.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : [];
  const metadata = payload.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : undefined;
  return {
    type: 'opencode_permission',
    requestId,
    sessionId,
    action,
    resources,
    saveOptions,
    metadata,
  };
}

/**
 * Prefer the original command over OpenCode's split argv fragments.
 * @param {Record<string, unknown>} payload
 * @returns {string[]}
 */
function readOpenCodePermissionResources(payload) {
  const metadata = payload.metadata && typeof payload.metadata === 'object'
    ? /** @type {Record<string, unknown>} */ (payload.metadata)
    : null;
  const command = typeof metadata?.command === 'string' ? metadata.command.trim() : '';
  if (command) return [command];
  const raw = Array.isArray(payload.resources)
    ? payload.resources
    : Array.isArray(payload.patterns)
      ? payload.patterns
      : [];
  return raw
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => String(entry).trim());
}

/**
 * Drop pending permission cards when OpenCode already failed the matching tool
 * (auto-deny / expired request) without emitting permission.v2.replied.
 *
 * @param {Map<string, unknown> | null | undefined} pending
 * @param {unknown} toolEvent
 * @returns {string[]}
 */
export function listOpenCodePermissionIdsForFailedTool(pending, toolEvent) {
  if (!(pending instanceof Map) || pending.size === 0) return [];
  if (!toolEvent || typeof toolEvent !== 'object') return [];
  const event = /** @type {Record<string, unknown>} */ (toolEvent);
  if (String(event.type || '').toLowerCase() !== 'tool_call') return [];
  if (String(event.status || '').toLowerCase() !== 'error') return [];
  const toolName = String(event.name || '').trim().toLowerCase();
  if (!toolName) return [];
  /** @type {string[]} */
  const ids = [];
  for (const [requestId, permissionEvent] of pending) {
    if (!permissionEvent || typeof permissionEvent !== 'object') continue;
    const action = String(/** @type {Record<string, unknown>} */ (permissionEvent).action || '')
      .trim()
      .toLowerCase();
    if (!action) continue;
    if (action === toolName || action.includes(toolName) || toolName.includes(action)) {
      ids.push(String(requestId));
    }
  }
  return ids;
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {string | null}
 */
export function resolveOpenCodePermissionResolvedRequestId(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  if (!isOpenCodeEventForSession(event, context.opencodeSessionId)) return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'permission.replied' && type !== 'permission.v2.replied') return null;
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const requestId = readOpenCodeRequestId(payload);
  return requestId || null;
}

/**
 * @param {{
 *   baseUrl: string,
 *   requestId: string,
 *   sessionId?: string,
 *   directory?: string,
 *   reply: PermissionReply,
 *   message?: string,
 * }} input
 */
export async function postOpenCodePermissionResponse(input) {
  const baseUrl = String(input.baseUrl || '').replace(/\/$/, '');
  const requestId = String(input.requestId || '').trim();
  const reply = input.reply;
  if (!baseUrl || !requestId) {
    throw new Error('Missing OpenCode permission reply target');
  }
  if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
    throw new Error('Invalid OpenCode permission reply');
  }
  const sessionId = String(input.sessionId || '').trim();
  const directory = String(input.directory || '').trim();
  const body = { reply };
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (message) body.message = message;
  const globalPath = `/permission/${encodeURIComponent(requestId)}/reply`;
  const sessionPath = sessionId
    ? `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`
    : '';
  await postOpenCodeInstanceWithFallback({
    baseUrl,
    directory,
    sessionPath,
    globalPath,
    body: JSON.stringify(body),
    errorLabel: 'permission reply',
  });
}
