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

export function sanitizeAdvisorPermissionName(permission: unknown): string {
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

type AdvisorActionLike = { risk?: string; categories?: string[] } | null | undefined;

export function needsMinimalAdvisorPayload(action: AdvisorActionLike): boolean {
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

export function isValidHarnessAlwaysScopePattern(pattern: unknown): boolean {
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
 * @param saveOptions
 */
export function deriveHarnessBoundedAlwaysScopeFromSaveOptions(saveOptions: unknown): string | null {
  if (!Array.isArray(saveOptions)) return null;
  const validated: string[] = [];
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
 * @param tuple
 * @param approvalAction
 */
export function isAdvisoryAssessmentPayloadLimited(
  tuple: { command?: string; resources?: string[]; risk?: string },
  approvalAction: AdvisorActionLike,
): boolean {
  if (needsMinimalAdvisorPayload(approvalAction)) return true;
  const risk = String(tuple?.risk || '').trim().toLowerCase();
  if (risk === 'unknown' || !['low', 'medium', 'high'].includes(risk)) return true;
  const hasCommand = Boolean(String(tuple?.command || '').trim());
  const hasResources = Array.isArray(tuple?.resources) && tuple.resources.length > 0;
  if (!hasCommand && !hasResources) return true;
  return false;
}

export function resolveApprovalPolicyVersion(harness: unknown): string {
  const key = String(harness || '').trim().toLowerCase();
  if (key === 'opencode') return APPROVAL_BROKER_POLICY_VERSION;
  return HARNESS_NEUTRAL_POLICY_VERSION;
}

function basenameOnly(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  // Legacy behavior: a trailing separator yields '' (the path names a directory).
  const parts = text.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/**
 * Remove absolute filesystem prefixes before externalizing command text.
 *
 * @param value
 */
export function sanitizePermissionCommand(value: unknown): string {
  const redacted = redactText(String(value || ''));
  return redacted.replace(
    /(^|[\s"'=])((?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\/|~\/))[^\s"'=;&|]+)/g,
    (_match: string, prefix: string, pathValue: string) => `${prefix}${basenameOnly(pathValue)}`,
  );
}

export interface NormalizedPermissionRequest {
  harness: string;
  requestId: string;
  permission: string;
  command: string;
  resources: string[];
  risk: string;
  categories: string[];
  policyVersion: string;
}

export interface PermissionRequestInput {
  harness?: string;
  permissionEvent?: unknown;
  approvalAction?: unknown;
  requestId?: string;
}

/**
 * Reduce a permission event to the canonical request shape shared by the advisor
 * tuple and future harness adapters.
 *
 * @param input
 */
export function normalizePermissionRequest(input: PermissionRequestInput = {}): NormalizedPermissionRequest {
  const harness = String(input.harness || 'opencode').trim() || 'opencode';
  const event = input.permissionEvent && typeof input.permissionEvent === 'object'
    ? (input.permissionEvent as Record<string, unknown>)
    : {};
  const action = input.approvalAction && typeof input.approvalAction === 'object'
    ? (input.approvalAction as Record<string, unknown>)
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
    categories: Array.isArray(action.categories) ? (action.categories as string[]).slice(0, CAP_CATEGORIES) : [],
    policyVersion: String(action.policyVersion || policyDefault).slice(0, CAP_POLICY_VERSION),
  };
}

/**
 * Build the tuple for advisory-only consultations (`riskScope=advise_all`). Uses
 * {@link normalizePermissionRequest} then strips sensitive fields unless
 * `sendSensitiveCommand` is explicitly enabled (still redacted and path-stripped).
 *
 * @param input
 * @param options
 */
export function buildAdvisoryPermissionTuple(
  input: PermissionRequestInput = {},
  options: { sendSensitiveCommand?: boolean } = {},
): NormalizedPermissionRequest {
  const normalized = normalizePermissionRequest(input);
  normalized.permission = sanitizeAdvisorPermissionName(normalized.permission);
  const action = input.approvalAction && typeof input.approvalAction === 'object'
    ? (input.approvalAction as Record<string, unknown>)
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
