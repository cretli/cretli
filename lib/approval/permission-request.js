/**
 * Harness-neutral permission request normalization for the approval advisor and
 * audit trail.
 *
 * ## Adapter contract (D1)
 *
 * A harness adapter (not wired in this leaf — see sibling work) should call
 * {@link normalizePermissionRequest} immediately before that harness would
 * otherwise decide `ask_user` vs allow for a tool permission. Inputs are the
 * raw permission event from the harness plus the host's current
 * {@link resolveApprovalPolicyVersion} action snapshot (risk, categories,
 * optional command text). The caller may:
 *
 * - Pass the result to the external approval advisor (redacted tuple on the wire).
 * - Attach `harness` and `requestId` when writing audit rows via
 *   {@link recordApprovalAudit} in `approval-broker.js`.
 * - Compare `policyVersion` across stored audit lines.
 *
 * The caller must not send chat history, diffs, or secrets — this module
 * enforces caps and redaction only on the fields it knows about.
 *
 * No harness-specific adapters are registered here yet; OpenCode continues to
 * use `buildAdvisorPermissionTuple` / `recordOpenCodeApprovalAudit` wrappers.
 */

import { redactText } from '../browser/redaction.js';

/** OpenCode local broker ruleset id (also re-exported from approval-broker.js). */
export const APPROVAL_BROKER_POLICY_VERSION = 'opencode-local-1';

/** Default policy version for harnesses without a broker-local ruleset yet. */
export const HARNESS_NEUTRAL_POLICY_VERSION = 'harness-neutral-0';

const CAP_REQUEST_ID = 64;
const CAP_PERMISSION = 120;
const CAP_COMMAND = 300;
const CAP_RESOURCE_ITEM = 120;
const CAP_RESOURCES = 8;
const CAP_CATEGORIES = 8;
const CAP_POLICY_VERSION = 80;

/**
 * @param {unknown} harness
 * @returns {string}
 */
export function resolveApprovalPolicyVersion(harness) {
  const key = String(harness || '').trim().toLowerCase();
  if (key === 'opencode') return APPROVAL_BROKER_POLICY_VERSION;
  return HARNESS_NEUTRAL_POLICY_VERSION;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function basenameOnly(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Remove absolute filesystem prefixes before externalizing command text.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizePermissionCommand(value) {
  const redacted = redactText(String(value || ''));
  return redacted.replace(
    /(^|[\s"'=])((?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\/|~\/))[^\s"'=;&|]+)/g,
    (_match, prefix, pathValue) => `${prefix}${basenameOnly(pathValue)}`,
  );
}

/**
 * @typedef {Object} NormalizedPermissionRequest
 * @property {string} harness
 * @property {string} requestId
 * @property {string} permission
 * @property {string} command
 * @property {string[]} resources
 * @property {string} risk
 * @property {string[]} categories
 * @property {string} policyVersion
 */

/**
 * Reduce a permission event to the canonical request shape shared by the advisor
 * tuple and future harness adapters.
 *
 * @param {{ harness?: string, permissionEvent?: unknown, approvalAction?: unknown, requestId?: string }} input
 * @returns {NormalizedPermissionRequest}
 */
export function normalizePermissionRequest(input = {}) {
  const harness = String(input.harness || 'opencode').trim() || 'opencode';
  const event = input.permissionEvent && typeof input.permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (input.permissionEvent)
    : {};
  const action = input.approvalAction && typeof input.approvalAction === 'object'
    ? /** @type {Record<string, unknown>} */ (input.approvalAction)
    : {};
  const permission = redactText(String(event.action || action.action || '')).slice(0, CAP_PERMISSION);
  const command = sanitizePermissionCommand(action.command).slice(0, CAP_COMMAND);
  const resources = Array.isArray(event.resources)
    ? event.resources
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .slice(0, CAP_RESOURCES)
      .map((entry) => redactText(basenameOnly(String(entry))).slice(0, CAP_RESOURCE_ITEM))
    : [];
  const policyDefault = resolveApprovalPolicyVersion(harness);
  return {
    requestId: String(input.requestId || event.requestId || '').slice(0, CAP_REQUEST_ID),
    harness,
    permission,
    command,
    resources,
    risk: String(action.risk || 'low'),
    categories: Array.isArray(action.categories) ? action.categories.slice(0, CAP_CATEGORIES) : [],
    policyVersion: String(action.policyVersion || policyDefault).slice(0, CAP_POLICY_VERSION),
  };
}
