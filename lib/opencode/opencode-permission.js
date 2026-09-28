/**
 * OpenCode permission skill — normalize SSE events and reply via HTTP API.
 */

import path from 'node:path';

import { isOpenCodeEventForSession } from '../agent-harness/opencode-event-normalizer.js';
import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';
import { isMutatingPlanModeShellCommand, isPlanModeMutatingToolName } from '../sdk/sdk-plan-guard.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { isReadOnlySdkMode } from '../sdk/sdk-mode.js';
import { postOpenCodeInstanceWithFallback } from './opencode-instance-http.js';
import { readOpenCodeEventPayload, readOpenCodeRequestId } from './opencode-question.js';
import {
  APPROVAL_BROKER_POLICY_VERSION,
  normalizeApprovalBrokerMode,
} from '../approval/approval-broker.js';

/** @typedef {'once' | 'always' | 'reject'} OpenCodePermissionReply */

/**
 * Plan denies file edits at the engine. Bash is `ask` so read-only shell can
 * explore; Cretli still auto-rejects mutating commands.
 *
 * @param {unknown} mode
 * @param {{ review?: boolean }} [options]
 * @returns {Array<{ permission: string, pattern: string, action: 'allow' | 'deny' | 'ask' }>}
 */
export function buildOpenCodePlanPermissionRuleset(mode, options = {}) {
  // Reviews run in Agent mode so the model can inspect the workspace. Give
  // their session an explicit shell ask path; the host approval handler then
  // auto-allows safe reads and rejects mutations before OpenCode executes them.
  if (options.review === true) {
    return [
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ];
  }
  if (isReadOnlySdkMode(mode)) {
    return [
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ];
  }
  return [
    { permission: 'edit', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: '*', action: 'ask' },
  ];
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
function readOpenCodePermissionCommand(record) {
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? /** @type {Record<string, unknown>} */ (record.metadata)
    : null;
  if (typeof metadata?.command === 'string' && metadata.command.trim()) {
    return metadata.command.trim();
  }
  const resources = Array.isArray(record.resources) ? record.resources : [];
  return resources
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => String(entry).trim())
    .join('; ');
}

/**
 * @param {unknown} permissionEvent
 * @param {{ allowReviewVerify?: boolean }} [options]
 * @returns {boolean}
 */
export function isOpenCodePlanMutatingPermission(permissionEvent, options = {}) {
  if (!permissionEvent || typeof permissionEvent !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (permissionEvent);
  const action = String(record.action || '').trim().toLowerCase();
  if (action === 'bash' || action === 'shell' || action.startsWith('shell.')) {
    const command = readOpenCodePermissionCommand(record);
    if (command) return isMutatingPlanModeShellCommand(command, options);
    return true;
  }
  if (isPlanModeMutatingToolName(action)) return true;
  if (/\b(edit|write|delete)\b/.test(action)) return true;
  const saveOptions = Array.isArray(record.saveOptions) ? record.saveOptions : [];
  return saveOptions.some((entry) => {
    const name = String(entry || '').toLowerCase();
    if (name === 'bash' || name === 'shell') {
      const command = readOpenCodePermissionCommand(record);
      if (command) return isMutatingPlanModeShellCommand(command, options);
      return true;
    }
    return isPlanModeMutatingToolName(entry) || /\b(edit|write|delete)\b/.test(name);
  });
}

/**
 * Auto-reject mutating OpenCode permissions in Plan or an active review
 * before the tool runs.
 * @param {unknown} mode
 * @param {unknown} permissionEvent
 * @param {unknown} [assignment]
 * @returns {boolean}
 */
export function shouldRejectOpenCodePlanPermission(mode, permissionEvent, assignment) {
  const review = isReviewReadOnlyAssignment(assignment);
  if (!isReadOnlySdkMode(mode) && !review) return false;
  if (!review && !resolveHarnessPlanPolicy('opencode').denyMutatingTools) return false;
  return isOpenCodePlanMutatingPermission(permissionEvent, { allowReviewVerify: review });
}

/**
 * Review delegations auto-allow non-mutating OpenCode permissions (DSH approval
 * never parity) so fanout reviews are not blocked on shell read probes.
 *
 * @param {unknown} mode
 * @param {unknown} permissionEvent
 * @param {unknown} [assignment]
 * @returns {boolean}
 */
export function shouldAutoAllowOpenCodeReviewPermission(mode, permissionEvent, assignment) {
  if (!isReviewReadOnlyAssignment(assignment)) return false;
  return !shouldRejectOpenCodePlanPermission(mode, permissionEvent, assignment);
}

/**
 * Delegated children may inspect the assigned workspace without waiting for a
 * browser permission card. Mutating tools remain interactive; this only
 * removes the deadlock where an implementer cannot even locate its TODO.
 * @param {unknown} mode
 * @param {unknown} permissionEvent
 * @param {unknown} assignment
 * @returns {boolean}
 */
export function shouldAutoAllowOpenCodeDelegationPermission(mode, permissionEvent, assignment) {
  const normalized = String(assignment || '').trim().toLowerCase();
  if (normalized !== 'review' && normalized !== 'implement') return false;
  if (normalized === 'review') return shouldAutoAllowOpenCodeReviewPermission(mode, permissionEvent, assignment);
  return !isOpenCodePlanMutatingPermission(permissionEvent);
}

/**
 * Denylist overlay on top of the shared plan-guard heuristics. It never
 * replaces `isMutatingPlanModeShellCommand` / `isPlanModeMutatingToolName`; it
 * only marks actions the broker must never auto-approve (network, secrets,
 * production/privilege, destructive).
 */
const APPROVAL_NETWORK_TOOL_RE = /^(web[._]?(fetch|search)|webfetch|websearch|http[._]?request|fetch|browser)$/;
const APPROVAL_NETWORK_COMMAND_RE = /\b(curl|wget|nc|netcat|ncat|ssh|scp|sftp|rsync|telnet|ftp|lftp|gh\s+api|npm\s+(install|i|ci|add|publish|exec)|pnpm\s+(install|add|publish|dlx)|yarn\s+(add|install|publish|dlx)|bun\s+(add|install|x)|pip3?\s+install|uv\s+(pip|add)|poetry\s+add|apt(-get)?\s+(install|update|upgrade)|brew\s+(install|upgrade)|go\s+get|gem\s+install|cargo\s+install|docker\s+pull|git\s+(fetch|pull|clone|push))\b/i;
const APPROVAL_SECRET_TEXT_RE = /(^|[\\/\s"'`=(])(\.env(\.[a-z0-9]+)?|\.envrc|id_rsa|id_ed25519|credentials|auth\.json|mcp-secrets\.json|\.cretli-sdk\.env|\.npmrc|\.netrc|[^\s\\/]+\.(pem|p12|pfx|key))($|[\s"'`),;:])/i;
const APPROVAL_SECRET_COMMAND_RE = /(^|\s)(printenv|cat\s+\S*(\.env|id_rsa|id_ed25519|\.pem|credentials|auth\.json|mcp-secrets\.json)|grep\s+[^\n]*(\.env|id_rsa|credentials)|rg\s+[^\n]*(\.env|id_rsa|credentials)|aws\s+configure|gcloud\s+auth|gh\s+auth\s+token|op\s+item\s+get|kubectl\s+get\s+secrets?)(\s|$)/i;
const APPROVAL_PRIVILEGE_COMMAND_RE = /\b(sudo|doas|chmod|chown|chgrp|setfacl|systemctl|service|kill|pkill|killall|mount|umount|useradd|usermod|passwd|visudo|docker|kubectl|helm|terraform\s+apply|ansible-playbook|deploy|pm2\s+(start|stop|restart|delete)|supervisorctl|npm\s+publish)\b/i;
const APPROVAL_DESTRUCTIVE_COMMAND_RE = /(^|\s)(rm|rmdir|shred|truncate|dd|mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)(\s|$)|:\(\)\s*\{/i;

/**
 * @param {unknown} permissionEvent
 * @returns {{ action: string, command: string, text: string }}
 */
function readOpenCodeApprovalText(permissionEvent) {
  const record = permissionEvent && typeof permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (permissionEvent)
    : {};
  const action = String(record.action || '').trim();
  const command = readOpenCodePermissionCommand(record);
  const resources = Array.isArray(record.resources)
    ? record.resources.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
    : [];
  const text = [action, command, ...resources].filter(Boolean).join(' ');
  return { action, command, text };
}

/**
 * @param {unknown} permissionEvent
 * @param {unknown} workspaceFolder
 * @returns {boolean}
 */
export function isOpenCodePermissionWithinWorkspace(permissionEvent, workspaceFolder) {
  const root = String(workspaceFolder || '').trim();
  if (!root) return false;
  const workspace = path.resolve(root);
  const record = permissionEvent && typeof permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (permissionEvent)
    : {};
  const resources = Array.isArray(record.resources)
    ? record.resources.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => String(entry).trim())
    : [];
  const command = readOpenCodePermissionCommand(record);
  const candidates = [];
  for (const raw of resources) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:\/\//i.test(raw)) return false;
    if (/^file:\/\//i.test(raw)) {
      try {
        candidates.push(new URL(raw).pathname);
      } catch {
        return false;
      }
    } else {
      candidates.push(raw);
    }
  }
  const absolutePathPattern = /(?:^|[\s"'=])(\/|~\/)([^\s"'`;|&]*)/g;
  for (const match of command.matchAll(absolutePathPattern)) {
    candidates.push(`${match[1]}${match[2]}`);
  }
  return candidates.every((candidate) => {
    const value = String(candidate || '').replace(/[),:]+$/, '');
    if (!value) return true;
    const resolved = value.startsWith('~/')
      ? path.resolve(process.env.HOME || '/', value.slice(2))
      : path.resolve(workspace, value);
    const relative = path.relative(workspace, resolved);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/**
 * Deterministic risk classification for an OpenCode permission request.
 *
 * @param {unknown} permissionEvent
 * @param {{ allowReviewVerify?: boolean }} [options]
 * @returns {{
 *   categories: string[],
 *   risk: 'low' | 'medium' | 'high',
 *   action: string,
 *   command: string,
 * }}
 */
export function classifyOpenCodePermissionRisk(permissionEvent, options = {}) {
  const { action, command, text } = readOpenCodeApprovalText(permissionEvent);
  const normalizedAction = action.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  /** @type {string[]} */
  const categories = [];
  if (isOpenCodePlanMutatingPermission(permissionEvent, options)) categories.push('mutation');
  if (APPROVAL_NETWORK_TOOL_RE.test(normalizedAction) || APPROVAL_NETWORK_COMMAND_RE.test(command || text)) {
    categories.push('network');
  }
  if (APPROVAL_SECRET_TEXT_RE.test(text) || APPROVAL_SECRET_COMMAND_RE.test(text)) categories.push('secrets');
  if (APPROVAL_PRIVILEGE_COMMAND_RE.test(command || text)) categories.push('privilege');
  if (APPROVAL_DESTRUCTIVE_COMMAND_RE.test(command || text)) categories.push('destructive');
  let risk = 'low';
  if (categories.some((entry) => entry !== 'mutation')) risk = 'high';
  else if (categories.includes('mutation')) risk = 'medium';
  return { categories, risk, action, command };
}

/**
 * Pure local decision for the OpenCode approval broker MVP. Reuses the existing
 * plan/review guard and delegation auto-allow helpers — it never carries its own
 * command-name allowlist.
 *
 * `off` preserves the pre-broker behaviour exactly: delegated read-only
 * permissions keep their one-shot auto-allow, interactive permissions stay
 * manual. `shadow` computes a recommendation but never sends a reply.
 * `local_reads` auto-replies `once` only for safe local reads (delegation reads
 * or interactive read probes) and never for network/secrets/privilege/mutation.
 *
 * @param {{
 *   mode?: unknown,
 *   sdkMode?: unknown,
 *   permissionEvent?: unknown,
 *   assignment?: unknown,
 *   workspaceFolder?: string,
 * }} [input]
 * @returns {{
 *   mode: string,
 *   decision: 'allow' | 'deny' | 'ask_user',
 *   reply: 'once' | 'reject' | null,
 *   risk: 'low' | 'medium' | 'high',
 *   reason: string,
 *   confidence: number,
 *   policyVersion: string,
 *   categories: string[],
 *   action: string,
 *   command: string,
 *   shadow: boolean,
 *   notifyUser: boolean,
 * }}
 */
export function resolveOpenCodeApprovalAction(input = {}) {
  const mode = normalizeApprovalBrokerMode(input.mode);
  const permissionEvent = input.permissionEvent;
  const assignment = input.assignment;
  const review = isReviewReadOnlyAssignment(assignment);
  const classification = classifyOpenCodePermissionRisk(permissionEvent, { allowReviewVerify: review });
  const guardDenied = shouldRejectOpenCodePlanPermission(input.sdkMode, permissionEvent, assignment);
  const legacyDelegationAllow = shouldAutoAllowOpenCodeDelegationPermission(
    input.sdkMode,
    permissionEvent,
    assignment,
  );
  const unsafe = classification.risk === 'high';
  const legacySafeRead = !guardDenied && !unsafe && !classification.categories.includes('mutation');
  const safeRead = legacySafeRead && isOpenCodePermissionWithinWorkspace(
    permissionEvent,
    input.workspaceFolder,
  );
  const delegationRead = legacyDelegationAllow && safeRead;
  const legacyDelegationRead = legacyDelegationAllow && legacySafeRead;
  const interactiveRead = !String(assignment || '').trim() && safeRead;
  const wouldAllow = delegationRead || interactiveRead;

  let recommendation;
  if (guardDenied) recommendation = { decision: 'deny', reason: 'plan_or_review_guard' };
  else if (unsafe) {
    const category = classification.categories.find((entry) => entry !== 'mutation')
      || classification.categories[0]
      || 'unknown';
    recommendation = { decision: 'ask_user', reason: `high_risk_${category}` };
  } else if (wouldAllow) recommendation = { decision: 'allow', reason: delegationRead ? 'delegation_read_once' : 'interactive_safe_read' };
  else recommendation = {
    decision: 'ask_user',
    reason: classification.categories.includes('mutation') ? 'mutation_requires_user' : 'manual_review',
  };

  const base = {
    mode,
    risk: classification.risk,
    confidence: 1,
    policyVersion: APPROVAL_BROKER_POLICY_VERSION,
    categories: classification.categories,
    action: classification.action,
    command: classification.command,
  };

  if (mode === 'off') {
    // The plan/review guard owns deny; `off` otherwise preserves the pre-broker
    // flow (delegated read auto-allow, interactive stays manual).
    if (guardDenied) {
      return {
        ...base,
        decision: 'deny',
        reply: 'reject',
        reason: 'plan_or_review_guard',
        shadow: false,
        notifyUser: false,
      };
    }
    const allowLegacy = legacyDelegationRead;
    return {
      ...base,
      decision: allowLegacy ? 'allow' : 'ask_user',
      reply: allowLegacy ? 'once' : null,
      reason: allowLegacy ? 'legacy_delegation_read_once' : 'broker_off',
      shadow: false,
      notifyUser: !allowLegacy,
    };
  }
  if (mode === 'shadow') {
    return {
      ...base,
      decision: /** @type {'allow' | 'deny' | 'ask_user'} */ (recommendation.decision),
      reply: null,
      reason: `shadow_${recommendation.reason}`,
      shadow: true,
      notifyUser: true,
    };
  }
  const reply = recommendation.decision === 'allow'
    ? 'once'
    : recommendation.decision === 'deny'
      ? 'reject'
      : null;
  return {
    ...base,
    decision: /** @type {'allow' | 'deny' | 'ask_user'} */ (recommendation.decision),
    reply,
    reason: recommendation.reason,
    shadow: false,
    notifyUser: reply === null,
  };
}

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
