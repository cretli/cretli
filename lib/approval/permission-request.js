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

/** OpenCode-style permission names allowed on the advisor wire without sanitization. */
const ADVISOR_PERMISSION_ALLOWLIST = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'glob',
  'list',
  'fetch',
  'task',
  'webfetch',
  'patch',
  'multiedit',
  'question',
]);

/**
 * @param {unknown} permission
 * @returns {string}
 */
export function sanitizeAdvisorPermissionName(permission) {
  const trimmed = redactText(String(permission || '')).trim().toLowerCase().slice(0, CAP_PERMISSION);
  if (!trimmed) return '';
  if (ADVISOR_PERMISSION_ALLOWLIST.has(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9_-]{0,39}$/.test(trimmed)) return trimmed;
  return 'other';
}

/** Categories that force a minimal advisory payload (no command or resources). */
export const ADVISORY_MINIMAL_PAYLOAD_CATEGORIES = Object.freeze([
  'secrets',
  'network',
  'privilege',
  'destructive',
  'expansion',
]);

/**
 * @param {{ risk?: string, categories?: string[] } | null | undefined} action
 * @returns {boolean}
 */
export function needsMinimalAdvisorPayload(action) {
  const risk = String(action?.risk || 'low').trim().toLowerCase();
  if (risk === 'high' || risk === 'unknown' || !['low', 'medium', 'high'].includes(risk)) {
    return true;
  }
  const categories = Array.isArray(action?.categories) ? action.categories : [];
  return categories.some((entry) => ADVISORY_MINIMAL_PAYLOAD_CATEGORIES.includes(String(entry || '').trim()));
}

const CAP_ALWAYS_SCOPE_PATTERNS = 8;
const CAP_ALWAYS_SCOPE_PATTERN = 120;
const CAP_ALWAYS_SCOPE_TOKEN = 64;

/**
 * @param {unknown} pattern
 * @returns {boolean}
 */
export function isValidHarnessAlwaysScopePattern(pattern) {
  const text = typeof pattern === 'string' ? pattern.trim() : '';
  if (!text || text.length > CAP_ALWAYS_SCOPE_PATTERN) return false;
  if (text === '*' || text === '**') return false;
  if (/^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(text)) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/*+]*$/.test(text)) return false;
  if (/^\*+$/.test(text)) return false;
  return true;
}

/**
 * Derive a bounded Always-scope token from OpenCode `saveOptions` (payload `always` /
 * `save`). Never reads permission event metadata (forgeable).
 *
 * @param {unknown} saveOptions
 * @returns {string | null}
 */
export function deriveHarnessBoundedAlwaysScopeFromSaveOptions(saveOptions) {
  if (!Array.isArray(saveOptions)) return null;
  const validated = [];
  for (const entry of saveOptions.slice(0, CAP_ALWAYS_SCOPE_PATTERNS)) {
    if (!isValidHarnessAlwaysScopePattern(entry)) continue;
    validated.push(String(entry).trim());
  }
  if (validated.length === 0) return null;
  const token = validated.join(';').slice(0, CAP_ALWAYS_SCOPE_TOKEN);
  return token || null;
}

/**
 * True when the advisory wire tuple lacks enough command/resource detail for a
 * full recommendation (minimal categories, blanked command, or unknown risk).
 *
 * @param {{ command?: string, resources?: string[], risk?: string }} tuple
 * @param {{ risk?: string, categories?: string[] } | null | undefined} approvalAction
 * @returns {boolean}
 */
export function isAdvisoryAssessmentPayloadLimited(tuple, approvalAction) {
  if (needsMinimalAdvisorPayload(approvalAction)) return true;
  const risk = String(tuple?.risk || '').trim().toLowerCase();
  if (risk === 'unknown' || !['low', 'medium', 'high'].includes(risk)) return true;
  const hasCommand = Boolean(String(tuple?.command || '').trim());
  const hasResources = Array.isArray(tuple?.resources) && tuple.resources.length > 0;
  if (!hasCommand && !hasResources) return true;
  return false;
}

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
  const permission = sanitizeAdvisorPermissionName(event.action || action.action);
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

/**
 * Build the tuple for advisory-only consultations (`riskScope=advise_all`). Uses
 * {@link normalizePermissionRequest} then strips sensitive fields unless
 * `sendSensitiveCommand` is explicitly enabled (still redacted and path-stripped).
 *
 * @param {{ harness?: string, permissionEvent?: unknown, approvalAction?: unknown, requestId?: string }} input
 * @param {{ sendSensitiveCommand?: boolean }} [options]
 * @returns {NormalizedPermissionRequest}
 */
export function buildAdvisoryPermissionTuple(input = {}, options = {}) {
  const normalized = normalizePermissionRequest(input);
  normalized.permission = sanitizeAdvisorPermissionName(normalized.permission);
  const action = input.approvalAction && typeof input.approvalAction === 'object'
    ? /** @type {Record<string, unknown>} */ (input.approvalAction)
    : {};
  if (needsMinimalAdvisorPayload(action)) {
    return {
      ...normalized,
      command: '',
      resources: [],
    };
  }
  if (options.sendSensitiveCommand !== true) {
    return {
      ...normalized,
      command: '',
      resources: [],
    };
  }
  return normalized;
}
