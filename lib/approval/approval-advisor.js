/**
 * Approval broker — Phase 2: external model advisor.
 *
 * A single, provider-neutral call to one external decision endpoint. Two wire
 * contracts are supported, selected by `approvalBroker.advisor.protocol`:
 * - `openai_chat` (default): an OpenAI-compatible `chat/completions` endpoint.
 * - `systemone`: the System One protocol used by Jev (TypeSafe AI) and Laya
 *   (Convai) — a `POST` with `{ model?, state, questions }` and a `noul`
 *   probability answer.
 *
 * The model is never hosted locally and this path never uses a Cretli harness as
 * the advisor: it talks to one operator configured HTTPS endpoint and nothing
 * else.
 *
 * Hard safety contract (mirrors `lib/approval/approval-broker.js`):
 * - Default-off: `approvalBroker.mode` defaults to `off` and the advisor
 *   `enabled` defaults to `false`. A missing endpoint or key means zero network.
 * - HTTPS only, no exceptions. `file:`/`unix`, userinfo, loopback, RFC1918/ULA,
 *   link-local, cloud metadata (IMDS) and any non-public resolved address are
 *   rejected. The existing browser `url-policy` decides reachability, and the
 *   validated IPs are *pinned* into the TLS connection so a DNS answer that
 *   changes between validation and connect (rebinding / TOCTOU) cannot redirect
 *   the request to an internal host.
 * - One short, non-streaming request, no tools. A timeout (clamped 3-8s), a
 *   quota miss, HTTP/429, malformed JSON, an SSRF rejection or a missing key
 *   all collapse to `ask_user`. There is never a retry or a failover.
 * - Only a redacted permission tuple is sent: never cwd, chat history, diffs,
 *   secrets or the full workspace. High-risk actions and anything carrying a
 *   secret category are never eligible, so nothing sensitive leaves the process.
 * - The model may answer `allow` or `ask_user`. `deny` is mapped to `ask_user`
 *   (the advisor can only ever reduce automation to a human card, never add a
 *   new reject). Reason is capped at 200 chars; confidence is optional.
 * - The advisor can send at most one `once`, only for a request that is still
 *   pending when the answer arrives, guarded per `requestId`. A human reply
 *   already taken wins. `shadow` mode never reaches this code path.
 * - The audit records provider host, model, latency, usage/cost, the advisor
 *   decision, the final decision and any error — never the key or Authorization.
 */

import https from 'node:https';

import { redactText } from '../browser/redaction.js';
import {
  classifyIp,
  evaluateUrlPolicy,
  isLoopbackHostname,
  isPrivateHostname,
  parseHttpUrl,
} from '../browser/url-policy.js';
import { loadSettings } from '../persist/settings.js';
import { appendApprovalAuditEntry } from './approval-audit.js';
import {
  APPROVAL_ADVISOR_DEFAULT_DAILY_QUOTA,
  APPROVAL_ADVISOR_DEFAULT_MIN_PROBABILITY,
  APPROVAL_ADVISOR_DEFAULT_TIMEOUT_MS,
  APPROVAL_BROKER_POLICY_VERSION,
  DEFAULT_APPROVAL_ADVISOR_PROTOCOL,
  normalizeApprovalAdvisorSettings,
  readApprovalBrokerMode,
} from './approval-broker.js';

/** @typedef {import('./approval-broker.js').ApprovalAdvisorSettings} ApprovalAdvisorSettings */

/** Env var that overrides the stored advisor key. It always wins over Settings. */
export const APPROVAL_ADVISOR_API_KEY_ENV = 'CRETLI_APPROVAL_ADVISOR_API_KEY';
export const APPROVAL_ADVISOR_SETTING_FIELD = 'approvalAdvisorApiKey';

export const ADVISOR_POLICY_VERSION = 'advisor-external-2';

/** The advisor reason string is capped here (also enforced on parse). */
export const ADVISOR_MAX_REASON_CHARS = 200;
/** Hard cap on the request body we are willing to put on the wire (UTF-8 bytes). */
export const ADVISOR_MAX_REQUEST_BYTES = 8_192;
/** Hard cap on how much of the provider response we will buffer. */
export const ADVISOR_MAX_RESPONSE_BYTES = 262_144;

const DEFAULT_ADVISOR = Object.freeze({
  enabled: false,
  protocol: DEFAULT_APPROVAL_ADVISOR_PROTOCOL,
  baseUrl: '',
  model: '',
  minProbability: APPROVAL_ADVISOR_DEFAULT_MIN_PROBABILITY,
  timeoutMs: APPROVAL_ADVISOR_DEFAULT_TIMEOUT_MS,
  dailyQuota: APPROVAL_ADVISOR_DEFAULT_DAILY_QUOTA,
});

const ADVISOR_SYSTEM_PROMPT = [
  'You are a read-only safety advisor for an automated approval broker.',
  'A coding agent asked to run a single low-risk, read-only action.',
  'Decide whether a human should be bypassed for this one call.',
  'Respond with ONLY a JSON object: {"decision":"allow"|"ask_user","reason":string,"confidence":number}.',
  'Set decision to "allow" only when the action is unambiguously a safe, read-only',
  'operation confined to the given file names. If there is any doubt, or the action',
  'could write, delete, change privileges, touch secrets, or reach the network, use',
  '"ask_user". Never approve something you are not sure about.',
].join(' ');

/** System One `noul` question: short English instruction, no local context. */
const SYSTEMONE_SAFE_READ_INSTRUCTIONS = [
  'Decide whether this is a single read-only action confined to the listed files,',
  'with no writes, no secrets and no network access.',
  'Answer with the probability that it is safe to run without asking a human.',
].join(' ');

/**
 * @param {unknown} settings
 * @returns {ApprovalAdvisorSettings} always a fully-populated, safe shape.
 */
export function readApprovalAdvisorSettings(settings) {
  const normalized = normalizeApprovalAdvisorSettings(settings?.approvalBroker?.advisor);
  return normalized || { ...DEFAULT_ADVISOR };
}

// --- API key resolution (env always wins over the stored setting) ----------

/** @returns {string} */
export function getApprovalAdvisorApiKeyFromEnv() {
  return (process.env[APPROVAL_ADVISOR_API_KEY_ENV] || '').trim();
}

/** @returns {string} */
export function getApprovalAdvisorApiKeyFromSettings(settings = null) {
  const source = settings || loadSettings();
  const key = source?.[APPROVAL_ADVISOR_SETTING_FIELD];
  return typeof key === 'string' && key.trim() ? key.trim() : '';
}

/**
 * Provider-neutral: any non-empty opaque bearer token is accepted (the endpoint
 * decides validity). The env key always wins over the stored key.
 * @returns {string}
 */
export function getEffectiveApprovalAdvisorApiKey(settings = null) {
  const fromEnv = getApprovalAdvisorApiKeyFromEnv();
  if (fromEnv) return fromEnv;
  return getApprovalAdvisorApiKeyFromSettings(settings);
}

/**
 * Client-safe metadata. It exposes only booleans/short strings — never the key.
 * @param {object | null} [settings]
 */
export function getApprovalAdvisorMetaForClient(settings = null) {
  const source = settings || loadSettings();
  const advisor = readApprovalAdvisorSettings(source);
  const envRaw = getApprovalAdvisorApiKeyFromEnv();
  const settingsRaw = getApprovalAdvisorApiKeyFromSettings(source);
  return {
    approvalAdvisorEnabled: advisor.enabled === true,
    approvalAdvisorEndpointConfigured: Boolean(advisor.baseUrl),
    approvalAdvisorKeyEffective: Boolean(getEffectiveApprovalAdvisorApiKey(source)),
    approvalAdvisorKeyFromEnv: Boolean(envRaw),
    approvalAdvisorKeyStoredInSettings: Boolean(settingsRaw),
  };
}

// --- eligibility -----------------------------------------------------------

/**
 * @typedef {{
 *   eligible: boolean,
 *   reason: string,
 *   url: string,
 *   hostname: string,
 *   protocol: string,
 *   model: string,
 *   minProbability: number,
 *   timeoutMs: number,
 *   dailyQuota: number,
 * }} ApprovalAdvisorPlan
 */

/**
 * Decide whether the external advisor may be consulted for one local broker
 * result. Fails closed: anything unexpected returns `eligible: false` so the
 * human card is kept and no network happens.
 *
 * @param {object | null | undefined} settings
 * @param {{ decision?: string, risk?: string, categories?: string[], shadow?: boolean, mode?: string } | null | undefined} action
 * @returns {ApprovalAdvisorPlan}
 */
export function resolveApprovalAdvisorPlan(settings, action) {
  const advisor = readApprovalAdvisorSettings(settings);
  const base = {
    eligible: false,
    reason: '',
    url: advisor.baseUrl,
    hostname: '',
    protocol: advisor.protocol,
    model: advisor.model,
    minProbability: advisor.minProbability,
    timeoutMs: advisor.timeoutMs,
    dailyQuota: advisor.dailyQuota,
  };

  // Only the active automation mode may consult the advisor; `off` and `shadow`
  // must never trigger a request.
  const mode = readApprovalBrokerMode(settings);
  if (mode !== 'local_reads') return { ...base, reason: 'mode_not_local_reads' };
  if (action?.mode && action.mode !== 'local_reads') return { ...base, reason: 'action_mode_mismatch' };
  if (action?.shadow) return { ...base, reason: 'shadow' };
  if (!advisor.enabled) return { ...base, reason: 'advisor_disabled' };

  // The advisor only widens a local `ask_user`; it never touches allow/deny.
  if (!action || action.decision !== 'ask_user') return { ...base, reason: 'not_ask_user' };
  // Low-risk read only: any category (secrets/network/privilege/destructive) or
  // a medium/high risk classification (mutation) is ineligible and unsent.
  if (action.risk !== 'low') return { ...base, reason: 'not_low_risk' };
  const categories = Array.isArray(action.categories) ? action.categories : [];
  if (categories.length > 0) return { ...base, reason: 'unsafe_category' };

  // System One endpoints have a server-side default model, so a missing model is
  // only fatal for the OpenAI-compatible chat protocol.
  if (advisor.protocol === DEFAULT_APPROVAL_ADVISOR_PROTOCOL && !advisor.model) {
    return { ...base, reason: 'no_model' };
  }
  const parsed = parseHttpUrl(advisor.baseUrl);
  if (!parsed || parsed.protocol !== 'https:') return { ...base, reason: 'no_https_endpoint' };
  if (parsed.hasUserInfo) return { ...base, reason: 'userinfo_not_allowed' };
  if (!getEffectiveApprovalAdvisorApiKey(settings)) return { ...base, reason: 'no_api_key' };

  return { ...base, eligible: true, reason: '', hostname: parsed.hostname };
}

/**
 * Pure scheduling gate used by the WS integration: decides whether to fire the
 * async advisory for a freshly-pending permission. Keeps `requested` (a Set of
 * requestIds already advised this room) so one request is never advised twice.
 *
 * @param {{ approvalAction: any, settings: any, requestId: string, requested?: Set<string> }} input
 * @returns {boolean}
 */
export function shouldScheduleApprovalAdvisor(input) {
  const { approvalAction, settings, requestId, requested } = input || {};
  if (!requestId) return false;
  if (requested instanceof Set && requested.has(requestId)) return false;
  return resolveApprovalAdvisorPlan(settings, approvalAction).eligible;
}

// --- request body ----------------------------------------------------------

/**
 * @param {string} value
 * @returns {string}
 */
function basenameOnly(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Handle both POSIX and Windows separators without importing path (keeps the
  // pure builder platform-independent for tests).
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** Remove absolute filesystem prefixes before sending command text externally. */
function sanitizeAdvisorCommand(value) {
  const redacted = redactText(String(value || ''));
  return redacted.replace(/(^|[\s"'=])((?:(?:[A-Za-z]:[\\/])|(?:\\\\)|(?:\/|~\/))[^\s"'=;&|]+)/g, (_match, prefix, pathValue) => (
    `${prefix}${basenameOnly(pathValue)}`
  ));
}

/**
 * Reduce a permission event to the *only* fields the advisor may ever see. The
 * tuple is deliberately minimal: a redacted action name, a redacted/capped
 * command, and the basenames of any resources (never their directory, so no cwd
 * or workspace layout leaks). No chat history, no diffs, no secrets.
 *
 * @param {{ permissionEvent?: any, approvalAction?: any, requestId?: string }} input
 * @returns {Record<string, unknown>}
 */
export function buildAdvisorPermissionTuple(input = {}) {
  const event = input.permissionEvent && typeof input.permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (input.permissionEvent)
    : {};
  const action = input.approvalAction && typeof input.approvalAction === 'object'
    ? /** @type {Record<string, unknown>} */ (input.approvalAction)
    : {};
  const permission = redactText(String(event.action || action.action || '')).slice(0, 120);
  const command = sanitizeAdvisorCommand(action.command).slice(0, 300);
  const resources = Array.isArray(event.resources)
    ? event.resources
      .filter((entry) => typeof entry === 'string' && entry.trim())
      .slice(0, 8)
      .map((entry) => redactText(basenameOnly(String(entry))).slice(0, 120))
    : [];
  return {
    requestId: String(input.requestId || event.requestId || '').slice(0, 64),
    harness: 'opencode',
    permission,
    command,
    resources,
    risk: String(action.risk || 'low'),
    categories: Array.isArray(action.categories) ? action.categories.slice(0, 8) : [],
    policyVersion: String(action.policyVersion || APPROVAL_BROKER_POLICY_VERSION).slice(0, 80),
  };
}

/**
 * Build the OpenAI-compatible, non-streaming request body. No `tools`, no
 * streaming, temperature 0, small completion budget, JSON response format.
 *
 * @param {{ model: string, tuple: Record<string, unknown> }} input
 * @returns {Record<string, unknown>}
 */
export function buildAdvisorRequestBody(input) {
  return {
    model: String(input.model || ''),
    messages: [
      { role: 'system', content: ADVISOR_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(input.tuple) },
    ],
    temperature: 0,
    stream: false,
    max_tokens: 200,
    response_format: { type: 'json_object' },
  };
}

/**
 * Build the System One (Jev/Laya) request body: the same redacted tuple as
 * `state`, one `noul` question and an optional model (omitted when empty so the
 * server uses its default).
 *
 * @param {{ model?: string, tuple: Record<string, unknown> }} input
 * @returns {Record<string, unknown>}
 */
export function buildSystemOneRequestBody(input) {
  /** @type {Record<string, unknown>} */
  const body = {
    state: input.tuple,
    questions: {
      safe_read: {
        type: 'noul',
        instructions: SYSTEMONE_SAFE_READ_INSTRUCTIONS,
      },
    },
  };
  const model = String(input.model || '').trim();
  if (model) body.model = model;
  return body;
}

// --- response parsing ------------------------------------------------------

function clamp01(value) {
  if (!Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The provider's `reason` is model-controlled text and could echo back a secret
 * (including the advisor key if it were ever leaked into the prompt). Run it
 * through the shared redactor and then explicitly strip the effective key so it
 * can never appear in the audit, UI or logs.
 *
 * @param {string} text
 * @returns {string}
 */
function scrubAdvisorSecrets(text) {
  let out = redactText(String(text || ''));
  const key = getEffectiveApprovalAdvisorApiKey();
  if (key && out.includes(key)) out = out.split(key).join('[redacted]');
  return out;
}

/**
 * Extract the assistant message text from an OpenAI-compatible completion.
 * @param {any} json
 * @returns {string}
 */
export function extractAdvisorContent(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  // Some providers return the object directly under `message` when forced JSON.
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return '';
    }
  }
  return '';
}

/**
 * Parse the advisor's structured decision. The advisor may only ever produce
 * `allow` or `ask_user`; a `deny` (or anything unrecognized) is coerced to
 * `ask_user` so the advisor never adds a new rejection path. Bad JSON is an
 * error (also `ask_user`).
 *
 * @param {string | Record<string, unknown> | null | undefined} raw
 * @returns {{ decision: 'allow' | 'ask_user', reason: string, confidence: number | null, error: string | null }}
 */
export function parseAdvisorCompletion(raw) {
  let object = raw;
  if (typeof raw === 'string') {
    try {
      object = JSON.parse(raw);
    } catch {
      return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_json' };
    }
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_json' };
  }
  const record = /** @type {Record<string, unknown>} */ (object);
  const verdict = String(record.decision || record.action || record.verdict || '')
    .trim()
    .toLowerCase();
  const reason = redactText(String(record.reason || '')).replace(/\s+/g, ' ').trim().slice(0, ADVISOR_MAX_REASON_CHARS);
  const confidence = clamp01(Number(record.confidence));
  if (verdict === 'allow') {
    return { decision: 'allow', reason, confidence, error: null };
  }
  return { decision: 'ask_user', reason, confidence, error: null };
}

/**
 * Parse a System One `noul` answer. Only `answers.safe_read.type === 'noul'`
 * with a real number in [0, 1] is accepted; strings are never coerced and values
 * are never clamped. `allow` requires `noul >= minProbability`, everything else
 * (below the threshold, missing field, wrong type, NaN/Infinity/out of range)
 * stays `ask_user`. Extra Laya fields (`routing`, `action`, `confidence`) are
 * ignored — `confidence` is not a substitute for `noul`.
 *
 * @param {string | Record<string, unknown> | null | undefined} raw
 * @param {number} [minProbability]
 * @returns {{ decision: 'allow' | 'ask_user', reason: string, confidence: number | null, error: string | null }}
 */
export function parseSystemOneAnswer(raw, minProbability) {
  let object = raw;
  if (typeof raw === 'string') {
    try {
      object = JSON.parse(raw);
    } catch {
      return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_json' };
    }
  }
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_answer' };
  }
  const record = /** @type {Record<string, unknown>} */ (object);
  const answers = record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)
    ? /** @type {Record<string, unknown>} */ (record.answers)
    : null;
  const answer = answers?.safe_read;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_answer' };
  }
  const noul = /** @type {Record<string, unknown>} */ (answer).noul;
  if (
    /** @type {Record<string, unknown>} */ (answer).type !== 'noul'
    || typeof noul !== 'number'
    || !Number.isFinite(noul)
    || noul < 0
    || noul > 1
  ) {
    return { decision: 'ask_user', reason: '', confidence: null, error: 'bad_answer' };
  }
  const threshold = Number.isFinite(minProbability)
    ? Number(minProbability)
    : APPROVAL_ADVISOR_DEFAULT_MIN_PROBABILITY;
  const decision = noul >= threshold ? 'allow' : 'ask_user';
  return { decision, reason: `noul ${noul}`, confidence: noul, error: null };
}

// --- quota -----------------------------------------------------------------

let quotaState = { count: 0, windowStart: 0, day: '' };

/**
 * Per-process daily budget. A miss collapses to `ask_user` without touching
 * the network. `dailyQuota <= 0` disables the advisor.
 *
 * @param {number} maxPerMinute
 * @param {number} [now]
 * @returns {boolean} true when the call is allowed to proceed
 */
export function tryConsumeApprovalAdvisorQuota(dailyQuota, now = Date.now()) {
  const limit = Number.isFinite(dailyQuota) ? Math.floor(dailyQuota) : 0;
  if (limit <= 0) return false;
  const day = new Date(now).toISOString().slice(0, 10);
  if (!quotaState.windowStart || quotaState.day !== day) {
    quotaState = { count: 1, windowStart: now, day };
    return true;
  }
  if (quotaState.count >= limit) return false;
  quotaState.count += 1;
  return true;
}

/** Reset the in-memory quota counter (test helper; no production caller). */
export function resetApprovalAdvisorQuota() {
  quotaState = { count: 0, windowStart: 0, day: '' };
}

// --- SSRF-validated, IP-pinned HTTPS transport -----------------------------

/**
 * Validate an advisor endpoint before any connection is opened. Combines the
 * shared browser `url-policy` (scheme, port, DNS, always-blocked metadata, and
 * DNS-rebinding of public names) with an explicit non-public check, because an
 * operator could allowlist a loopback origin that `url-policy` alone would let
 * through. Returns the resolved public IPs to pin the actual connection to.
 *
 * @param {string} rawUrl
 * @param {{ lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>> }} [options]
 * @returns {Promise<{ ok: true, hostname: string, port: number, path: string, resolvedIps: string[] } | { ok: false, code: string, reason: string }>}
 */
export async function validateApprovalAdvisorEndpoint(rawUrl, options = {}) {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) return { ok: false, code: 'invalid-url', reason: 'Invalid endpoint URL' };
  if (parsed.protocol !== 'https:') return { ok: false, code: 'https-only', reason: 'HTTPS is required' };
  if (parsed.hasUserInfo) return { ok: false, code: 'userinfo-not-allowed', reason: 'URL userinfo is not allowed' };
  // Reject literal loopback / private endpoints even if an operator allowlisted
  // them — the advisor must only ever reach a public HTTPS host.
  if (isLoopbackHostname(parsed.hostname) || isPrivateHostname(parsed.hostname)) {
    return { ok: false, code: 'local-address', reason: 'Loopback/private endpoints are not allowed' };
  }

  let targetPath = '/';
  try {
    const full = new URL(rawUrl);
    targetPath = `${full.pathname || '/'}${full.search || ''}`;
  } catch {
    return { ok: false, code: 'invalid-url', reason: 'Invalid endpoint URL' };
  }

  // Reuse the existing policy: this handles link-local / IMDS / special ranges,
  // blocked ports, the public-name -> private-address rebinding case, and does
  // the authoritative DNS resolution we then pin.
  const decision = await evaluateUrlPolicy({
    url: rawUrl,
    // The operator-configured origin is the only allowlist entry; no localhost or
    // private-network opt-in is ever granted here.
    policy: { allowedOrigins: [parsed.origin] },
    lookup: typeof options.lookup === 'function' ? options.lookup : undefined,
  });
  if (!decision.allowed) return { ok: false, code: decision.code, reason: decision.reason };

  const resolvedIps = Array.isArray(decision.resolvedIps) ? decision.resolvedIps.filter(Boolean) : [];
  if (resolvedIps.length === 0) return { ok: false, code: 'dns-failed', reason: 'Could not resolve endpoint' };
  for (const address of resolvedIps) {
    const kind = classifyIp(address);
    if (kind.alwaysBlocked || kind.scope !== 'public') {
      return { ok: false, code: 'blocked-address', reason: `${parsed.hostname} resolves to a non-public address` };
    }
  }

  return {
    ok: true,
    hostname: parsed.hostname,
    port: Number(parsed.port) || 443,
    path: targetPath,
    resolvedIps,
  };
}

/**
 * A `lookup` that answers *only* from the pre-validated IP set. This is what
 * makes the connection immune to a DNS-rebinding TOCTOU: whatever DNS says at
 * connect time is ignored in favour of the addresses we already classified as
 * public. SNI/`servername` and certificate verification still use the real
 * hostname, so a mismatched cert fails.
 *
 * @param {string[]} resolvedIps
 */
function createPinnedLookup(resolvedIps) {
  const records = resolvedIps.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4,
  }));
  return function pinnedLookup(_hostname, opts, cb) {
    const callback = typeof opts === 'function' ? opts : cb;
    const all = typeof opts === 'object' && opts ? opts.all === true : false;
    if (records.length === 0) {
      callback(new Error('No pinned address'), []);
      return;
    }
    if (all) {
      callback(null, records);
      return;
    }
    callback(null, records[0].address, records[0].family);
  };
}

/**
 * Perform the actual HTTPS POST, pinned to the validated IPs. Returns a small,
 * structured result; every failure becomes an `error` code that the caller maps
 * to `ask_user`. Never throws.
 *
 * @param {{
 *   url: string,
 *   apiKey: string,
 *   payload: string,
 *   timeoutMs: number,
 *   lookup?: (hostname: string, options?: object) => Promise<Array<{ address: string }>>,
 *   requestImpl?: Function,
 * }} options
 * @returns {Promise<{ status?: number, json?: any, error?: string, code?: string }>}
 */
export async function postApprovalAdvisorRequest(options) {
  const requestImpl = typeof options.requestImpl === 'function' ? options.requestImpl : defaultHttpsRequest;
  const validation = await validateApprovalAdvisorEndpoint(options.url, { lookup: options.lookup });
  if (!validation.ok) {
    return { error: 'ssrf', code: validation.code };
  }
  const payloadBytes = Buffer.byteLength(options.payload, 'utf8');
  if (payloadBytes > ADVISOR_MAX_REQUEST_BYTES) {
    return { error: 'request_too_large', code: 'request_too_large' };
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${options.apiKey}`,
    'Content-Length': String(payloadBytes),
  };
  return new Promise((resolve) => {
    requestImpl(
      {
        hostname: validation.hostname,
        servername: validation.hostname,
        port: validation.port,
        path: validation.path,
        method: 'POST',
        headers,
        lookup: createPinnedLookup(validation.resolvedIps),
        timeout: options.timeoutMs,
        rejectUnauthorized: true,
      },
      options.payload,
      resolve,
    );
  });
}

/**
 * The default transport built on `node:https`. Kept separate so tests can
 * substitute `requestImpl` and assert the SSRF gate short-circuits before this
 * ever runs.
 *
 * @param {object} requestOptions
 * @param {string} payload
 * @param {(result: { status?: number, json?: any, error?: string, code?: string }) => void} done
 */
function defaultHttpsRequest(requestOptions, payload, done) {
  /** @type {boolean} */
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    done(result);
  };
  let req;
  try {
    req = https.request(requestOptions, (res) => {
      const status = res.statusCode || 0;
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > ADVISOR_MAX_RESPONSE_BYTES) {
          req.destroy();
          finish({ status, error: 'response_too_large', code: 'response_too_large' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (raw) {
          try {
            json = JSON.parse(raw);
          } catch {
            json = null;
          }
        }
        finish({ status, json });
      });
      res.on('error', () => finish({ status, error: 'network', code: 'network' }));
    });
  } catch {
    finish({ error: 'network', code: 'network' });
    return;
  }
  req.on('timeout', () => {
    req.destroy();
    finish({ error: 'timeout', code: 'timeout' });
  });
  req.on('error', () => finish({ error: 'network', code: 'network' }));
  try {
    req.write(payload);
    req.end();
  } catch {
    finish({ error: 'network', code: 'network' });
  }
}

// --- orchestration ---------------------------------------------------------

/**
 * @typedef {{
 *   advisorDecision: 'allow' | 'ask_user',
 *   reason: string,
 *   confidence: number | null,
 *   provider: string,
 *   model: string,
 *   protocol: string,
 *   latencyMs: number,
 *   usageTokens: number | null,
 *   usageCost: number | null,
 *   error: string | null,
 * }} ApprovalAdvisorResult
 */

function makeResult(overrides) {
  /** @type {ApprovalAdvisorResult} */
  return {
    advisorDecision: 'ask_user',
    reason: '',
    confidence: null,
    provider: '',
    model: '',
    protocol: DEFAULT_APPROVAL_ADVISOR_PROTOCOL,
    latencyMs: 0,
    usageTokens: null,
    usageCost: null,
    error: null,
    ...overrides,
  };
}

/**
 * Run one advisor request for a single, already-decided local `ask_user`. All
 * failure modes collapse to `advisorDecision: 'ask_user'` with an `error` code.
 * Exactly one transport call is made; there is no retry and no failover.
 *
 * @param {{
 *   plan?: ApprovalAdvisorPlan,
 *   settings?: any,
 *   permissionEvent?: any,
 *   approvalAction?: any,
 *   transport?: (opts: object) => Promise<{ status?: number, json?: any, error?: string, code?: string }>,
 *   lookup?: Function,
 *   requestImpl?: Function,
 *   now?: number,
 * }} [input]
 * @returns {Promise<ApprovalAdvisorResult>}
 */
export async function requestApprovalAdvisor(input = {}) {
  const settings = input.settings || loadSettings();
  const plan = input.plan || resolveApprovalAdvisorPlan(settings, input.approvalAction);
  const provider = plan.hostname || '';
  const model = plan.model || '';
  const protocol = plan.protocol || DEFAULT_APPROVAL_ADVISOR_PROTOCOL;

  if (!plan.eligible) {
    return makeResult({ provider, model, protocol, error: plan.reason || 'not_eligible' });
  }

  const apiKey = getEffectiveApprovalAdvisorApiKey(settings);
  if (!apiKey) return makeResult({ provider, model, protocol, error: 'no_api_key' });

  if (!tryConsumeApprovalAdvisorQuota(plan.dailyQuota, input.now)) {
    return makeResult({ provider, model, protocol, error: 'quota' });
  }

  const tuple = buildAdvisorPermissionTuple({
    permissionEvent: input.permissionEvent,
    approvalAction: input.approvalAction,
  });
  const body = protocol === 'systemone'
    ? buildSystemOneRequestBody({ model, tuple })
    : buildAdvisorRequestBody({ model, tuple });
  const transport = typeof input.transport === 'function' ? input.transport : postApprovalAdvisorRequest;

  const startedAt = Date.now();
  let response;
  try {
    response = await transport({
      url: plan.url,
      apiKey,
      payload: JSON.stringify(body),
      timeoutMs: plan.timeoutMs,
      lookup: input.lookup,
      requestImpl: input.requestImpl,
      body,
      tuple,
    });
  } catch {
    // A thrown transport is treated exactly like any other failure: ask_user.
    return makeResult({ provider, model, protocol, latencyMs: Date.now() - startedAt, error: 'transport' });
  }
  const latencyMs = Math.max(0, Date.now() - startedAt);

  const usage = extractAdvisorUsage(response?.json);
  const baseWithLatency = makeResult({
    provider,
    model,
    protocol,
    latencyMs,
    usageTokens: usage.tokens,
    usageCost: usage.cost,
  });

  if (!response || typeof response !== 'object') {
    return { ...baseWithLatency, error: 'bad_response' };
  }
  if (response.error === 'ssrf') return { ...baseWithLatency, error: 'ssrf' };
  if (response.error === 'timeout') return { ...baseWithLatency, error: 'timeout' };
  if (response.error) return { ...baseWithLatency, error: response.code || response.error };
  if (response.status === 429) return { ...baseWithLatency, error: 'rate_limited' };
  if (!(Number.isFinite(response.status) && response.status >= 200 && response.status < 300)) {
    return { ...baseWithLatency, error: 'http_error' };
  }

  const parsed = protocol === 'systemone'
    ? parseSystemOneAnswer(response.json, plan.minProbability)
    : parseAdvisorCompletion(extractAdvisorContent(response.json));
  if (parsed.error) {
    return { ...baseWithLatency, error: parsed.error };
  }
  return {
    ...baseWithLatency,
    advisorDecision: parsed.decision,
    reason: parsed.reason,
    confidence: parsed.confidence,
    error: null,
  };
}

/**
 * @param {any} json
 * @returns {{ tokens: number | null, cost: number | null }}
 */
function extractAdvisorUsage(json) {
  const usage = json?.usage && typeof json.usage === 'object' ? json.usage : null;
  let tokens = null;
  let cost = null;
  if (usage) {
    if (Number.isFinite(Number(usage.total_tokens))) tokens = Number(usage.total_tokens);
    else if (Number.isFinite(Number(usage.prompt_tokens)) || Number.isFinite(Number(usage.completion_tokens))) {
      tokens = (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
    } else if (Number.isFinite(Number(usage.input_tokens)) || Number.isFinite(Number(usage.output_tokens))) {
      // System One reports `input_tokens`/`output_tokens` instead.
      tokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    }
    if (Number.isFinite(Number(usage.cost))) cost = Number(usage.cost);
  }
  if (cost == null && Number.isFinite(Number(json?.cost))) cost = Number(json.cost);
  return { tokens, cost };
}

/**
 * Decide whether the advisor's answer should turn into an actual `once` reply.
 * Only an `allow` for a request that is still pending, in `local_reads`, not in
 * shadow mode, and whose reply guard we successfully claimed leads to
 * `allow_once`. Everything else (including a lost guard claim, i.e. the human
 * already answered) stays `ask_user`.
 *
 * @param {{ advisorDecision?: string } | null | undefined} result
 * @param {{ mode?: string, shadow?: boolean, stillPending?: boolean, replyStatus?: string }} context
 * @returns {'allow_once' | 'ask_user'}
 */
export function resolveAdvisorReplyOutcome(result, context = {}) {
  if (!result || result.advisorDecision !== 'allow') return 'ask_user';
  if (context.shadow) return 'ask_user';
  if (context.mode !== 'local_reads') return 'ask_user';
  if (!context.stillPending) return 'ask_user';
  if (context.replyStatus !== 'sent') return 'ask_user';
  return 'allow_once';
}

/**
 * Append the advisor audit entry. Records provider host, protocol, model,
 * latency, usage and cost, the advisor decision, the final decision and any
 * error. It never records the key or any Authorization header. Returns the
 * written entry (or null when the audit file write failed).
 *
 * @param {{
 *   room?: any,
 *   permissionEvent?: any,
 *   approvalAction?: any,
 *   plan?: any,
 *   result?: ApprovalAdvisorResult,
 *   finalDecision?: string,
 *   now?: number,
 * }} input
 * @param {{ file?: string }} [options]
 * @returns {Record<string, unknown> | null}
 */
export function recordApprovalAdvisorAudit(input, options = {}) {
  const action = input?.approvalAction;
  if (!action || action.mode !== 'local_reads') return null;
  const event = input?.permissionEvent && typeof input.permissionEvent === 'object'
    ? /** @type {Record<string, unknown>} */ (input.permissionEvent)
    : {};
  const result = input?.result || {};
  const entry = {
    ts: new Date(Number.isFinite(input?.now) ? Number(input.now) : Date.now()).toISOString(),
    kind: 'advisor',
    harness: 'opencode',
    mode: action.mode,
    requestId: String(event.requestId || '').slice(0, 64),
    chatId: String(input?.room?.chatId || '').slice(0, 64),
    advisorDecision: result.advisorDecision || 'ask_user',
    finalDecision: input?.finalDecision || 'ask_user',
    provider: String(result.provider || input?.plan?.hostname || '').slice(0, 253),
    model: String(result.model || input?.plan?.model || '').slice(0, 120),
    protocol: String(result.protocol || input?.plan?.protocol || DEFAULT_APPROVAL_ADVISOR_PROTOCOL).slice(0, 40),
    latencyMs: Number.isFinite(result.latencyMs) ? result.latencyMs : 0,
    usageTokens: Number.isFinite(result.usageTokens) ? result.usageTokens : null,
    usageCost: Number.isFinite(result.usageCost) ? result.usageCost : null,
    confidence: Number.isFinite(result.confidence) ? result.confidence : null,
    risk: action.risk || 'low',
    reason: scrubAdvisorSecrets(result.reason).slice(0, ADVISOR_MAX_REASON_CHARS),
    localReason: String(action.reason || '').slice(0, 120),
    error: result.error || null,
    advisorPolicyVersion: ADVISOR_POLICY_VERSION,
    policyVersion: action.policyVersion || APPROVAL_BROKER_POLICY_VERSION,
  };
  const ok = appendApprovalAuditEntry(entry, options);
  return ok ? entry : null;
}
