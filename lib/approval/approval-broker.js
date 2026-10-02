/**
 * External approval broker for automatic acceptance of agent actions.
 *
 * Phase 1 (this module) — local, deterministic policy only:
 * - Only the OpenCode permission flow is integrated (`permission.asked` /
 *   `permission.v2.asked`).
 * - Modes: `off` (default), `shadow` (log a recommendation, never reply) and
 *   opt-in `local_reads` (auto-approve only safe local read-only actions with a
 *   one-shot `once`).
 *
 * Safety invariants:
 * - `always` is never sent; the only automatic reply is `once`.
 * - A local deterministic deny always wins; the model advisor can only ever
 *   advise `ask_user` (or widen a low-risk read-only or host-owned
 *   `node scripts/review-verify.js` `ask_user` into a one-shot `once`).
 * - Edits, deletes, network, secrets, production, privilege changes and git
 *   writes are never auto-approved.
 *
 * Phase 2 (a provider-neutral, default-off external model advisor) lives in
 * `lib/approval/approval-advisor.js`. It consults one HTTPS endpoint — either an
 * OpenAI-compatible `chat/completions` API or a System One (Jev/Laya) API — only
 * for low-risk read-only or host-owned `node scripts/review-verify.js` `ask_user`
 * cases under `local_reads`, uses strict
 * structured JSON, maps timeout/quota/HTTP/bad-JSON/SSRF/missing-key to
 * `ask_user` (never `allow`), sends only a redacted permission tuple, pins the
 * connection to validated public IPs to defeat DNS rebinding, and never retries
 * across providers. Its settings live in the `approvalBroker.advisor` block and
 * `approvalAdvisorApiKey`; the key is never returned to the client.
 */

import { redactText } from '../browser/redaction.js';
import { appendApprovalAuditEntry } from './approval-audit.js';

/** @typedef {'off' | 'shadow' | 'local_reads'} ApprovalBrokerMode */

export const APPROVAL_BROKER_MODES = Object.freeze(['off', 'shadow', 'local_reads']);
export const DEFAULT_APPROVAL_BROKER_MODE = 'off';
export const APPROVAL_BROKER_POLICY_VERSION = 'opencode-local-1';

/**
 * Phase 2 adds an optional, provider-neutral external *advisor* behind the
 * `local_reads` automation. It is disabled by default and, on its own, never
 * sends a network request. The advisor may only ever widen a local `ask_user`
 * for one of two narrow cases: a low-risk read, or the host-owned
 * `node scripts/review-verify.js` runner (the only mutation-only command it may
 * touch). A local deny, a high-risk action and every other
 * secret/privilege/network/mutation stay with the human. The full
 * request/SSRF/audit contract lives in `lib/approval/approval-advisor.js`.
 */
export const APPROVAL_ADVISOR_DEFAULT_TIMEOUT_MS = 5000;
export const APPROVAL_ADVISOR_MIN_TIMEOUT_MS = 3000;
export const APPROVAL_ADVISOR_MAX_TIMEOUT_MS = 8000;
export const APPROVAL_ADVISOR_DEFAULT_DAILY_QUOTA = 100;
export const APPROVAL_ADVISOR_MAX_DAILY_QUOTA = 10_000;
export const APPROVAL_ADVISOR_DEFAULT_MIN_PROBABILITY = 0.9;
export const APPROVAL_ADVISOR_MIN_MIN_PROBABILITY = 0.5;
export const APPROVAL_ADVISOR_MAX_MIN_PROBABILITY = 0.99;
/** Advisor wire protocols: OpenAI-compatible chat or System One (Jev/Laya). */
export const APPROVAL_ADVISOR_PROTOCOLS = Object.freeze(['openai_chat', 'systemone']);
export const DEFAULT_APPROVAL_ADVISOR_PROTOCOL = 'openai_chat';
// Compatibility aliases for the first unmerged draft of Phase 2.
export const APPROVAL_ADVISOR_DEFAULT_MAX_PER_MINUTE = APPROVAL_ADVISOR_DEFAULT_DAILY_QUOTA;
export const APPROVAL_ADVISOR_MAX_PER_MINUTE_CAP = APPROVAL_ADVISOR_MAX_DAILY_QUOTA;

/**
 * @typedef {'openai_chat' | 'systemone'} ApprovalAdvisorProtocol
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   protocol: ApprovalAdvisorProtocol,
 *   baseUrl: string,
 *   model: string,
 *   minProbability: number,
 *   timeoutMs: number,
 *   dailyQuota: number,
 * }} ApprovalAdvisorSettings
 */

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseFloat(String(value ?? ''));
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, base));
}

/**
 * @param {unknown} value
 * @returns {ApprovalAdvisorProtocol}
 */
export function normalizeApprovalAdvisorProtocol(value) {
  const protocol = String(value || '').trim().toLowerCase();
  return APPROVAL_ADVISOR_PROTOCOLS.includes(protocol)
    ? /** @type {ApprovalAdvisorProtocol} */ (protocol)
    : DEFAULT_APPROVAL_ADVISOR_PROTOCOL;
}

/**
 * Normalize the persisted `approvalBroker.advisor` block. It never carries the
 * API key (that is stored separately in `settings.approvalAdvisorApiKey`). The
 * advisor is default-disabled; a fresh install has no block at all.
 *
 * @param {unknown} raw
 * @returns {ApprovalAdvisorSettings | null} `null` when nothing was configured,
 *   so the parent broker block stays byte-identical for installs without one.
 */
export function normalizeApprovalAdvisorSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  return {
    enabled: record.enabled === true,
    protocol: normalizeApprovalAdvisorProtocol(record.protocol),
    baseUrl: String(record.baseUrl || '').trim().slice(0, 2048),
    model: String(record.model || '').trim().slice(0, 120),
    minProbability: clampNumber(
      record.minProbability,
      APPROVAL_ADVISOR_DEFAULT_MIN_PROBABILITY,
      APPROVAL_ADVISOR_MIN_MIN_PROBABILITY,
      APPROVAL_ADVISOR_MAX_MIN_PROBABILITY,
    ),
    timeoutMs: clampInteger(
      record.timeoutMs,
      APPROVAL_ADVISOR_DEFAULT_TIMEOUT_MS,
      APPROVAL_ADVISOR_MIN_TIMEOUT_MS,
      APPROVAL_ADVISOR_MAX_TIMEOUT_MS,
    ),
    dailyQuota: clampInteger(
      record.dailyQuota ?? record.maxPerMinute,
      APPROVAL_ADVISOR_DEFAULT_DAILY_QUOTA,
      0,
      APPROVAL_ADVISOR_MAX_DAILY_QUOTA,
    ),
  };
}

/**
 * @param {unknown} value
 * @returns {ApprovalBrokerMode}
 */
export function normalizeApprovalBrokerMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return APPROVAL_BROKER_MODES.includes(mode) ? /** @type {ApprovalBrokerMode} */ (mode) : DEFAULT_APPROVAL_BROKER_MODE;
}

/**
 * Normalize the persisted `settings.approvalBroker` block. Missing/unknown
 * values fail closed to `off`. The `advisor` sub-block is only present when it
 * was configured, so a Phase 1 install stays byte-identical.
 *
 * @param {unknown} raw
 * @returns {{ mode: ApprovalBrokerMode, policyVersion: string, advisor?: ApprovalAdvisorSettings }}
 */
export function normalizeApprovalBrokerSettings(raw) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  const advisor = normalizeApprovalAdvisorSettings(record.advisor);
  const normalized = {
    mode: normalizeApprovalBrokerMode(record.mode),
    policyVersion: APPROVAL_BROKER_POLICY_VERSION,
  };
  if (advisor) normalized.advisor = advisor;
  return normalized;
}

/**
 * @param {object | null | undefined} settings
 * @returns {ApprovalBrokerMode}
 */
export function readApprovalBrokerMode(settings) {
  return normalizeApprovalBrokerSettings(settings?.approvalBroker).mode;
}

/**
 * Persist the mode (and an optional advisor block); `off` with no advisor is
 * represented by the absence of the block so a fresh install stays
 * byte-identical. The advisor API key is never stored here — it lives in
 * `settings.approvalAdvisorApiKey`.
 *
 * @param {Record<string, unknown>} settings
 * @param {unknown} raw
 * @returns {ApprovalBrokerMode}
 */
export function applyApprovalBrokerSettingsPatch(settings, raw) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : null;
  const mode = normalizeApprovalBrokerMode(record ? record.mode : raw);
  const previous = settings.approvalBroker && typeof settings.approvalBroker === 'object'
    ? /** @type {Record<string, unknown>} */ (settings.approvalBroker).advisor
    : null;
  const hasAdvisorPatch = Boolean(record && Object.prototype.hasOwnProperty.call(record, 'advisor'));
  let advisorInput = previous;
  if (hasAdvisorPatch) {
    if (!record.advisor || typeof record.advisor !== 'object' || Array.isArray(record.advisor)) {
      advisorInput = null;
    } else {
      advisorInput = {
        ...(previous && typeof previous === 'object' ? previous : {}),
        ...record.advisor,
      };
    }
  }
  const advisor = normalizeApprovalAdvisorSettings(advisorInput);
  if (mode === DEFAULT_APPROVAL_BROKER_MODE && !advisor) {
    delete settings.approvalBroker;
    return mode;
  }
  const block = {};
  if (mode !== DEFAULT_APPROVAL_BROKER_MODE) block.mode = mode;
  if (advisor) block.advisor = advisor;
  settings.approvalBroker = block;
  return mode;
}

/**
 * Build the redacted audit entry for one local broker decision. Only decisions
 * taken while the broker is enabled are recorded; `off` keeps today's manual
 * flow untouched.
 *
 * @param {{
 *   room?: any,
 *   permissionEvent?: any,
 *   action?: {
 *     mode?: string,
 *     decision?: string,
 *     reply?: string | null,
 *     risk?: string,
 *     reason?: string,
 *     policyVersion?: string,
 *     categories?: string[],
 *   } | null,
 *   now?: number,
 * }} input
 * @param {{ file?: string }} [options]
 * @returns {Record<string, unknown> | null}
 */
export function recordOpenCodeApprovalAudit(input, options = {}) {
  const action = input?.action;
  if (!action || action.mode === DEFAULT_APPROVAL_BROKER_MODE) return null;
  const event = input?.permissionEvent && typeof input.permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (input.permissionEvent)
    : {};
  const metadata = event.metadata && typeof event.metadata === 'object'
    ? /** @type {Record<string, unknown>} */ (event.metadata)
    : {};
  const command = typeof metadata.command === 'string' ? metadata.command : '';
  const resources = Array.isArray(event.resources) ? event.resources.join('; ') : '';
  const finalDecision = action.reply === 'once'
    ? 'allow_once'
    : action.reply === 'reject'
      ? 'reject'
      : 'ask_user';
  const entry = {
    ts: new Date(Number.isFinite(input?.now) ? Number(input.now) : Date.now()).toISOString(),
    harness: 'opencode',
    mode: action.mode || DEFAULT_APPROVAL_BROKER_MODE,
    requestId: String(event.requestId || '').trim(),
    chatId: String(input?.room?.chatId || '').trim(),
    action: redactText(String(event.action || '')).slice(0, 160),
    command: redactText(command || resources).slice(0, 500),
    decision: action.decision || 'ask_user',
    risk: action.risk || 'high',
    reason: action.reason || '',
    categories: Array.isArray(action.categories) ? action.categories.slice(0, 8) : [],
    policyVersion: action.policyVersion || APPROVAL_BROKER_POLICY_VERSION,
    finalDecision,
  };
  const ok = appendApprovalAuditEntry(entry, options);
  return ok ? entry : null;
}
