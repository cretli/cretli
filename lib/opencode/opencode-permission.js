/**
 * OpenCode permission skill — normalize SSE events and reply via HTTP API.
 */

import { isPlanModeMutatingToolName } from '../sdk/sdk-plan-guard.js';
import { readOpenCodeEventPayload } from './opencode-question.js';

const OPENCODE_PLAN_DENY_PERMISSIONS = Object.freeze(['edit', 'bash']);

/** @typedef {'once' | 'always' | 'reject'} OpenCodePermissionReply */

/**
 * Session permission ruleset for Plan (deny writes/shell) or Agent (ask again).
 *
 * @param {unknown} mode
 * @returns {Array<{ permission: string, pattern: string, action: 'allow' | 'deny' | 'ask' }>}
 */
export function buildOpenCodePlanPermissionRuleset(mode) {
  const action = mode === 'plan' ? 'deny' : 'ask';
  return OPENCODE_PLAN_DENY_PERMISSIONS.map((permission) => ({
    permission,
    pattern: '*',
    action,
  }));
}

/**
 * @param {unknown} permissionEvent
 * @returns {boolean}
 */
export function isOpenCodePlanMutatingPermission(permissionEvent) {
  if (!permissionEvent || typeof permissionEvent !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (permissionEvent);
  const action = String(record.action || '').trim().toLowerCase();
  if (isPlanModeMutatingToolName(action)) return true;
  if (/\b(edit|write|delete|bash|shell)\b/.test(action)) return true;
  const saveOptions = Array.isArray(record.saveOptions) ? record.saveOptions : [];
  return saveOptions.some((entry) => isPlanModeMutatingToolName(entry) || /\b(edit|write|bash|shell)\b/.test(String(entry || '').toLowerCase()));
}

/**
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {Record<string, unknown> | null}
 */
export function buildOpenCodePermissionSdkEvent(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'permission.asked' && type !== 'permission.v2.asked') return null;
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const sessionId = typeof payload.sessionID === 'string'
    ? payload.sessionID
    : typeof context.opencodeSessionId === 'string'
      ? context.opencodeSessionId
      : '';
  const requestId = typeof payload.id === 'string' ? payload.id : '';
  if (!requestId) return null;
  if (sessionId && context.opencodeSessionId && sessionId !== context.opencodeSessionId) return null;
  const action = typeof payload.action === 'string'
    ? payload.action.trim()
    : typeof payload.permission === 'string'
      ? payload.permission.trim()
      : 'Permission required';
  const resources = Array.isArray(payload.resources)
    ? payload.resources.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
    : Array.isArray(payload.patterns)
      ? payload.patterns.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
      : [];
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
 * @param {unknown} event
 * @param {{ opencodeSessionId?: string }} [context]
 * @returns {string | null}
 */
export function resolveOpenCodePermissionResolvedRequestId(event, context = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type !== 'permission.replied' && type !== 'permission.v2.replied') return null;
  const payload = readOpenCodeEventPayload(event);
  if (!payload) return null;
  const sessionId = typeof payload.sessionID === 'string' ? payload.sessionID : '';
  if (sessionId && context.opencodeSessionId && sessionId !== context.opencodeSessionId) return null;
  return typeof payload.requestID === 'string' ? payload.requestID : null;
}

/**
 * @param {{
 *   baseUrl: string,
 *   requestId: string,
 *   sessionId?: string,
 *   directory?: string,
 *   reply: OpenCodePermissionReply,
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
  const path = sessionId
    ? `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`
    : `/permission/${encodeURIComponent(requestId)}/reply`;
  const query = sessionId || !directory ? '' : `?directory=${encodeURIComponent(directory)}`;
  const response = await fetch(`${baseUrl}${path}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail.trim() || `OpenCode permission reply failed (${response.status})`);
  }
}
