import { isHarnessPermissionControlDisabled } from './harness-permission-controls.js';
/**
 * Shared `permission required` path for `canUseTool` harnesses (Claude, Qwen).
 *
 * Mirrors the OpenCode pending-permission flow: a card (`opencode_permission`
 * sdk event) with a `requestId`, a human reply that resolves
 * the callback's wait promise, and an optional external advisor that may only
 * widen a narrow `ask_user` into a single allow under the existing gates.
 *
 * Fail-closed rules:
 * - broker `off` / `shadow` keep the legacy callback behaviour (no card, no
 *   automation); `shadow` only audits.
 * - advisor errors, `ask_user`, advisory role, quota, session change: the human
 *   card stays and nothing is auto-allowed.
 * - abort / timeout / room reset denies the tool call and closes the card.
 * - the first resolver wins (human, advisor, abort); later ones are no-ops.
 *
 * The plan/review/scout guard is enforced by the callers *before* this module.
 * Codex and Cursor SDK have no verified host gate and are not covered.
 */
import { randomUUID } from 'node:crypto';
import { buildCanUseToolGrantKeys, hasCanUseToolGrant, saveCanUseToolGrant } from './can-use-tool-grants.js';
import { redactText } from '../browser/redaction.js';
import { loadSettings } from '../persist/settings.js';
import { isQwenAskUserQuestionTool } from '../qwen/qwen-question.js';
import {
  captureApprovalActionSnapshot,
  buildOpenCodePermissionAdvisorStatusPayload,
  buildOpenCodePermissionDecisionPayload,
  recordApprovalAdvisorAudit,
  recordApprovalAdvisorSkipAudit,
  recordApprovalHumanPermissionDecisionAudit,
  requestApprovalAdvisor,
  resolveAdvisorReplyOutcome,
  resolveApprovalAdvisorPlan,
  shouldScheduleApprovalAdvisor,
  toPublicAdvisoryAssessment,
  waitForAdvisorApplyWindow,
} from './approval-advisor.js';
import { readApprovalBrokerMode } from './approval-broker.js';
import {
  classifyCanUseToolRequest,
  writeCanUseToolAudit,
} from './can-use-tool-adapter.js';

const PENDING_KEY = '_canUseToolPermissions';
const DISPLAY_RESOURCE_MAX = 8;
const DISPLAY_TEXT_MAX = 300;

/**
 * @typedef {{
 *   broadcast?: (payload: Record<string, unknown>, options?: Record<string, unknown>) => void,
 *   onPendingChange?: () => void,
 *   notify?: (event: Record<string, unknown>) => void,
 * }} CanUseToolPermissionHost
 */

/**
 * @param {any} room
 * @returns {Map<string, any>}
 */
function pendingMap(room) {
  if (!(room[PENDING_KEY] instanceof Map)) room[PENDING_KEY] = new Map();
  return room[PENDING_KEY];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function displayText(value) {
  return redactText(String(value || '')).slice(0, DISPLAY_TEXT_MAX);
}

/**
 * Card payload: redacted, capped display data only.
 *
 * @param {{ requestId: string, harness: string, permissionEvent: any }} input
 * @returns {Record<string, unknown>}
 */
export function buildCanUseToolPermissionCard({ requestId, harness, permissionEvent }) {
  const paths = Array.isArray(permissionEvent.resources) ? permissionEvent.resources : [];
  const command = String(permissionEvent.metadata?.command || '');
  const shown = (paths.length > 0 ? paths : [command])
    .map(displayText)
    .filter(Boolean)
    .slice(0, DISPLAY_RESOURCE_MAX);
  return {
    type: 'opencode_permission',
    requestId,
    harness,
    sessionId: '',
    action: displayText(permissionEvent.action) || 'Permission required',
    resources: shown,
    saveOptions: [],
    // Cretli persists human grants; SDK callbacks still receive a one-shot reply.
    allowAlways: true,
    allowHarnessGrant: true,
    metadata: command ? { command: displayText(command) } : undefined,
  };
}

/**
 * Whether the tool call is a permission-gated tool (not the question tool).
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isCanUseToolPermissionGated(toolName) {
  return !isQwenAskUserQuestionTool(toolName);
}

/**
 * Ask for permission before a non-question tool runs.
 *
 * @param {{
 *   harness: string,
 *   room: any,
 *   toolName: unknown,
 *   input?: Record<string, unknown>,
 *   signal?: AbortSignal,
 *   sdkMode?: unknown,
 *   scoutReadOnly?: boolean,
 *   host?: CanUseToolPermissionHost,
 *   timeoutMs?: number,
 *   settings?: any,
 *   auditOptions?: { file?: string },
 *   advisor?: typeof requestApprovalAdvisor,
 * }} params
 * @returns {Promise<{ outcome: 'proceed' | 'deny', requestId: string, message?: string }>}
 */
export async function requestCanUseToolPermission(params) {
  const { harness, room, toolName, signal, host = {}, auditOptions } = params;
  const requestId = randomUUID();
  if (!isCanUseToolPermissionGated(toolName)) return { outcome: 'proceed', requestId };
  const settings = params.settings || loadSettings();
  const mode = readApprovalBrokerMode(settings);
  if (mode === 'off') return { outcome: 'proceed', requestId };
  const { permissionEvent, action } = classifyCanUseToolRequest({
    harness,
    toolName,
    input: params.input,
    requestId,
    mode,
    sdkMode: params.sdkMode ?? room.sdkMode,
    assignment: room.delegationAssignment,
    workspaceFolder: room.cwd,
    scoutReadOnly: params.scoutReadOnly === true,
  });
  const audit = (overrides = {}) => writeCanUseToolAudit({
    harness, room, permissionEvent, action: { ...action, ...overrides },
  }, auditOptions);
  if (action.shadow) {
    audit();
    return { outcome: 'proceed', requestId };
  }
  if (action.reply === 'reject') {
    audit();
    return { outcome: 'deny', requestId, message: 'Blocked by local approval policy' };
  }
  if (isHarnessPermissionControlDisabled(settings, harness, toolName)) {
    audit({ decision: 'allow', reply: 'once', reason: 'harness_category_control_disabled' });
    return { outcome: 'proceed', requestId };
  }
  const grantKeys = buildCanUseToolGrantKeys({ harness, workspace: room.cwd, toolName, input: params.input });
  const grantsFile = auditOptions?.file ? `${auditOptions.file}.grants.json` : undefined;
  if (!action.shadow && hasCanUseToolGrant(grantKeys, grantsFile)) {
    audit({ decision: 'allow', reply: 'once', reason: 'human_persistent_grant' });
    return { outcome: 'proceed', requestId };
  }
  if (action.reply === 'once') {
    audit();
    return { outcome: 'proceed', requestId };
  }
  if (signal?.aborted) return { outcome: 'deny', requestId, message: 'Permission request cancelled' };
  // ask_user: audit the (unresolved) classification, then wait for a human.
  audit();
  return new Promise((resolve) => {
    const card = buildCanUseToolPermissionCard({ requestId, harness, permissionEvent });
    card.allowAlways = Boolean(grantKeys);
    card.allowHarnessGrant = Boolean(grantKeys);
    const entry = {
      grantKeys,
      grantsFile,
      requestId,
      harness,
      permissionEvent,
      card,
      approvalAction: action,
      snapshot: captureApprovalActionSnapshot(action),
      auditOptions,
      finish: null,
    };
    const map = pendingMap(room);
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      map.delete(requestId);
      room._pendingQuestions?.delete(requestId);
      host.broadcast?.({ type: 'opencodePermissionResolved', requestId }, { log: false });
      host.onPendingChange?.();
      resolve({ requestId, ...result });
      return true;
    };
    const onAbort = () => {
      finish({ outcome: 'deny', message: 'Permission request cancelled' });
    };
    entry.finish = finish;
    map.set(requestId, entry);
    if (!(room._pendingQuestions instanceof Map)) room._pendingQuestions = new Map();
    // Shared with questions so replay, idle sync and waiting-for-input follow.
    room._pendingQuestions.set(requestId, card);
    host.broadcast?.({ type: 'sdkEvent', event: card });
    host.onPendingChange?.();
    host.notify?.(card);
    const timeoutMs = Number(params.timeoutMs) || 0;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ outcome: 'deny', message: 'Permission request timed out' });
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    void runAdvisor({ room, host, entry, settings, mode, advisor: params.advisor, auditOptions });
  });
}

/**
 * Human reply from the card, optionally persisting an exact or harness-wide grant.
 *
 * @param {any} room
 * @param {CanUseToolPermissionHost} host
 * @param {{ requestId?: string, reply?: string, message?: string }} payload
 * @param {{ file?: string }} [auditOptions]
 * @returns {boolean} true when this reply resolved a pending request
 */
export function replyCanUseToolPermission(room, host, payload, auditOptions) {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId.trim() : '';
  const reply = payload?.reply;
  if (!requestId || !['once', 'always', 'harness', 'reject'].includes(reply)) return false;
  const entry = room?.[PENDING_KEY] instanceof Map ? room[PENDING_KEY].get(requestId) : null;
  if (!entry) return false;
  if (reply === 'always' || reply === 'harness') {
    if (!entry.grantKeys) return false;
    try {
      saveCanUseToolGrant(entry.grantKeys, reply === 'harness' ? 'harness' : 'tool', entry.grantsFile);
    } catch {
      entry.finish({ outcome: 'deny', message: 'Could not save permission grant' });
      return false;
    }
  }
  const won = entry.finish(reply !== 'reject'
    ? { outcome: 'proceed' }
    : { outcome: 'deny', message: String(payload.message || '').trim() || 'User rejected the tool call' });
  if (!won) return false;
  recordApprovalHumanPermissionDecisionAudit({
    harness: entry.harness,
    room,
    permissionEvent: entry.permissionEvent,
    approvalActionSnapshot: entry.snapshot,
    humanReply: reply === 'harness' ? 'always' : reply,
    grantScope: reply === 'harness' ? 'harness' : reply === 'always' ? 'tool' : undefined,
  }, auditOptions || entry.auditOptions);
  const decision = buildOpenCodePermissionDecisionPayload({ requestId, decidedBy: 'user', reply: reply === 'harness' ? 'always' : reply });
  if (decision) host.broadcast?.(decision);
  return true;
}

/**
 * Deny and close every pending permission (abort, session reset, dispose).
 *
 * @param {any} room
 * @param {string} [reason]
 * @returns {number}
 */
export function rejectPendingCanUseToolPermissions(room, reason = 'cancelled') {
  if (!(room?.[PENDING_KEY] instanceof Map)) return 0;
  let count = 0;
  for (const entry of [...room[PENDING_KEY].values()]) {
    if (entry.finish({ outcome: 'deny', message: `Permission request ${reason}` })) count += 1;
  }
  return count;
}

/**
 * @param {any} room
 * @returns {number}
 */
export function countPendingCanUseToolPermissions(room) {
  return room?.[PENDING_KEY] instanceof Map ? room[PENDING_KEY].size : 0;
}

/**
 * Optional advisor consultation. Never throws and never replies except a
 * single `once` for an authority-role allow that wins the resolve race.
 *
 * @param {{ room: any, host: CanUseToolPermissionHost, entry: any, settings: any, mode: string, advisor?: Function, auditOptions?: { file?: string } }} ctx
 * @returns {Promise<void>}
 */
async function runAdvisor(ctx) {
  const { room, host, entry, settings, mode, auditOptions } = ctx;
  const { requestId, permissionEvent, approvalAction, harness } = entry;
  const isPending = () => room[PENDING_KEY] instanceof Map && room[PENDING_KEY].get(requestId) === entry;
  const status = (extra, plan) => host.broadcast?.(buildOpenCodePermissionAdvisorStatusPayload({
    requestId, permissionEvent, approvalAction, plan, ...extra,
  }), { log: false });
  let plan = null;
  try {
    plan = resolveApprovalAdvisorPlan(settings, approvalAction);
    status({ status: 'checking' }, plan);
    if (!(room._approvalAdvisorRequested instanceof Set)) room._approvalAdvisorRequested = new Set();
    const gate = shouldScheduleApprovalAdvisor({
      approvalAction, settings, requestId, requested: room._approvalAdvisorRequested,
    });
    if (!gate.eligible) {
      status({ status: 'skipped', reason: gate.reason }, plan);
      recordApprovalAdvisorSkipAudit({
        harness, room, permissionEvent, approvalAction, requestId, reason: gate.reason,
      }, auditOptions);
      return;
    }
    room._approvalAdvisorRequested.add(requestId);
    const advisor = ctx.advisor || requestApprovalAdvisor;
    const result = await advisor({ harness, plan, settings, permissionEvent, approvalAction });
    if (!isPending()) {
      recordApprovalAdvisorSkipAudit({
        harness, room, permissionEvent, approvalAction, requestId, reason: 'permission_gone_late',
      }, auditOptions);
      return;
    }
    let replyStatus = 'skipped';
    if (plan.role === 'authority' && result?.advisorDecision === 'allow') {
      host.broadcast?.({
        type: 'opencodePermissionAdvisorPick',
        requestId,
        reply: 'once',
        applyAfterMs: plan.timeoutMs,
        advisorDecision: result.advisorDecision,
      }, { log: false });
      const stillPending = await waitForAdvisorApplyWindow(plan.timeoutMs, isPending);
      if (stillPending && entry.finish({ outcome: 'proceed' })) replyStatus = 'sent';
    }
    const outcome = resolveAdvisorReplyOutcome(result, {
      mode, shadow: approvalAction?.shadow, stillPending: true, replyStatus, role: plan.role,
    });
    recordApprovalAdvisorAudit({
      harness, room, permissionEvent, approvalAction, plan, result, advisorAutomationOutcome: outcome,
    }, auditOptions);
    if (outcome === 'allow_once') {
      const decision = buildOpenCodePermissionDecisionPayload({
        requestId, decidedBy: 'advisor', reply: 'once', result, plan, approvalAction,
      });
      if (decision) host.broadcast?.(decision);
    }
    if (isPending() || outcome === 'allow_once') {
      status({
        status: result?.error ? 'error' : 'decided',
        advisorDecision: result?.advisorDecision || 'ask_user',
        finalDecision: outcome,
        reason: result?.error || result?.reason || '',
        advisoryAssessment: toPublicAdvisoryAssessment(result?.advisoryAssessment),
      }, plan);
    }
  } catch (err) {
    // Fail closed: the card stays for a human.
    recordApprovalAdvisorAudit({
      harness,
      room,
      permissionEvent,
      approvalAction,
      plan,
      result: { advisorDecision: 'ask_user', error: 'advisor_run_exception' },
      advisorAutomationOutcome: 'ask_user',
    }, auditOptions);
    if (isPending()) status({ status: 'error', reason: 'advisor_run_exception' }, plan);
    console.warn('[approval-advisor] run failed:', err?.message || '');
  }
}
