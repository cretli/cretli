/**
 * Audited, scoped overrides for model selection.
 *
 * `data/model-role-profiles.json` edits *role membership* (which model claims a
 * role). This module is the separate, auditable layer on top of the ranking:
 * an operator can pin a pair for the Watcher orchestrator (`explicit-orchestrator`),
 * express a soft `prefer`, or `exclude` a harness/model for a bounded time. The
 * two layers are deliberately independent: a role edit never creates an
 * override, and an override never grants a role or a Settings favorite.
 *
 * Contract (all enforced here, not in the route):
 * - `action` is one of `prefer` / `exclude` / `explicit-orchestrator`;
 * - `exclude` and `prefer` must name at least a harness or a model; an
 *   `explicit-orchestrator` must name a harness;
 * - a non-empty `reason` is mandatory;
 * - `expiresAt` is mandatory and bounded — the server clamps the accepted TTL to
 *   `[MODEL_PICK_OVERRIDE_MIN_TTL_MS, MODEL_PICK_OVERRIDE_MAX_TTL_MS]` and the
 *   TTL is re-evaluated on every read, including the start gate;
 * - `id`, `createdBy`, `source` and `createdAt` are set by the server and never
 *   taken from the request body;
 * - precedence is `hard deny > active workspace override > active global
 *   override > normal ranking`; `exclude` sets from every active scope are
 *   combined, and two different `explicit-orchestrator` targets at the same
 *   precedence are a conflict that refuses the selection;
 * - `prefer` changes no eligibility: a preferred pair that the shared hard-gate
 *   validator rejects stays rejected.
 *
 * The refusal decision still lives in the ONE shared validator
 * (`lib/model-pick-hard-gates.js`). `evaluateModelPickStartOverrides` only
 * merges the override excludes into that validator's input and refuses a
 * precedence conflict before it runs; it never re-implements a gate.
 */

import { randomUUID } from 'node:crypto';
import { evaluateModelPickHardGates } from './model-pick-hard-gates.js';
import { MODEL_PICK_ROLES } from './model-pick-gate-primitives.js';
import { decodeModelValue } from './model-catalog.js';

/** Scope vocabulary. */
export const MODEL_PICK_OVERRIDE_SCOPES = Object.freeze(['global', 'workspace']);

/** Action vocabulary. */
export const MODEL_PICK_OVERRIDE_ACTIONS = Object.freeze(['prefer', 'exclude', 'explicit-orchestrator']);

/** Audit event vocabulary (a refusal/expiry is recorded, not only mutation). */
export const MODEL_PICK_OVERRIDE_AUDIT_TYPES = Object.freeze([
  'create',
  'revoke',
  'reset',
  'refuse',
  'expire',
]);

/** Hard ceiling for one override's TTL: 30 days. */
export const MODEL_PICK_OVERRIDE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A TTL shorter than a minute is almost certainly a mistake. */
export const MODEL_PICK_OVERRIDE_MIN_TTL_MS = 60 * 1000;

/** How many audit rows the durable store keeps. */
export const MODEL_PICK_OVERRIDE_AUDIT_LIMIT = 200;

/** Machine codes for a rejected override document. */
export const MODEL_PICK_OVERRIDE_ERROR_CODES = Object.freeze({
  SHAPE: 'override_invalid',
  ID: 'override_invalid_id',
  ACTION: 'override_invalid_action',
  SCOPE: 'override_invalid_scope',
  WORKSPACE: 'override_workspace_required',
  TARGET: 'override_target_required',
  REASON: 'override_reason_required',
  TTL: 'override_invalid_ttl',
  ROLE: 'override_invalid_role',
  NOT_FOUND: 'override_not_found',
  CONFLICT: 'override_conflict',
});

/**
 * Error thrown for an override document the store refuses to persist.
 */
export class ModelPickOverrideError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ModelPickOverrideError';
    this.code = code;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function lower(value) {
  return text(value).toLowerCase();
}

/**
 * Normalize a workspace folder for comparison. Kept a plain lowercase string so
 * an override recorded in `/w/App` still matches a start from `/w/app`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeOverrideWorkspaceFolder(value) {
  return text(value).replace(/\/+$/, '').toLowerCase();
}

/**
 * Pair identity used for duplicate/conflict checks: harness + BASE model + role.
 *
 * @param {{ targetHarness?: unknown, targetModel?: unknown, targetRole?: unknown }} record
 * @returns {string}
 */
export function modelPickOverrideTargetKey(record) {
  const harness = lower(record?.targetHarness);
  const base = lower(decodeModelValue(String(record?.targetModel || '')).modelId || record?.targetModel);
  const role = lower(record?.targetRole);
  return `${harness}|${base}|${role}`;
}

/**
 * Whether two override records pin the exact same pair.
 *
 * @param {object} left
 * @param {object} right
 * @returns {boolean}
 */
export function sameModelPickOverrideTarget(left, right) {
  return modelPickOverrideTargetKey(left) === modelPickOverrideTargetKey(right);
}

/**
 * Validate and canonicalize one override. Server-owned fields are injected by
 * the caller; any value for those fields inside `raw` is ignored.
 *
 * @param {unknown} raw request body / stored row
 * @param {{
 *   now?: number,
 *   createdBy?: string,
 *   source?: string,
 *   generateId?: () => string,
 *   allowExistingId?: boolean,
 * }} [context]
 * @returns {object} canonical record
 * @throws {ModelPickOverrideError}
 */
export function normalizeModelPickOverride(raw, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.SHAPE, 'override must be a JSON object');
  }
  const now = Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now();
  const source = /** @type {Record<string, unknown>} */ (raw);

  const requestedId = text(source.id);
  let id;
  if (context.allowExistingId === true && requestedId) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(requestedId)) {
      throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.ID, 'override id has an invalid shape');
    }
    id = requestedId;
  } else {
    // The id is server-owned; a body cannot pick it.
    id = String(context.generateId ? context.generateId() : randomUUID());
  }

  const action = lower(source.action);
  if (!MODEL_PICK_OVERRIDE_ACTIONS.includes(/** @type {any} */ (action))) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.ACTION,
      'action must be prefer, exclude or explicit-orchestrator',
    );
  }

  const scope = lower(source.scope) || 'global';
  if (!MODEL_PICK_OVERRIDE_SCOPES.includes(/** @type {any} */ (scope))) {
    throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.SCOPE, 'scope must be global or workspace');
  }

  const workspaceFolder = normalizeOverrideWorkspaceFolder(source.workspaceFolder);
  if (scope === 'workspace' && !workspaceFolder) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.WORKSPACE,
      'a workspace override requires a workspaceFolder',
    );
  }

  const targetHarness = lower(source.targetHarness);
  const targetModel = text(source.targetModel);
  const requestedRole = lower(source.targetRole);
  if (requestedRole && !MODEL_PICK_ROLES.includes(/** @type {any} */ (requestedRole))) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.ROLE,
      'targetRole must be plan, implement, review or fix',
    );
  }
  if (action === 'explicit-orchestrator' && !targetHarness) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.TARGET,
      'explicit-orchestrator requires a targetHarness',
    );
  }
  if ((action === 'exclude' || action === 'prefer') && !targetHarness && !targetModel) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.TARGET,
      `${action} requires a targetHarness and/or a targetModel`,
    );
  }

  const reason = text(source.reason);
  if (reason.length < 3) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.REASON,
      'a non-empty reason (at least 3 characters) is mandatory',
    );
  }

  const expiresMs = Date.parse(text(source.expiresAt));
  if (!Number.isFinite(expiresMs)) {
    throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.TTL, 'expiresAt must be an ISO date-time');
  }
  if (expiresMs <= now) {
    throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.TTL, 'expiresAt must be in the future');
  }
  if (expiresMs > now + MODEL_PICK_OVERRIDE_MAX_TTL_MS) {
    throw new ModelPickOverrideError(
      MODEL_PICK_OVERRIDE_ERROR_CODES.TTL,
      `expiresAt is more than ${Math.floor(MODEL_PICK_OVERRIDE_MAX_TTL_MS / 86_400_000)} days away`,
    );
  }
  if (expiresMs < now + MODEL_PICK_OVERRIDE_MIN_TTL_MS) {
    throw new ModelPickOverrideError(MODEL_PICK_OVERRIDE_ERROR_CODES.TTL, 'expiresAt is too close to the present');
  }

  const record = {
    // Unknown fields are preserved verbatim; every known field is overwritten
    // below so a request body cannot smuggle a server-owned value.
    ...source,
    id,
    scope,
    workspaceFolder,
    targetHarness,
    targetModel,
    targetRole: requestedRole,
    action,
    reason,
    createdBy: text(context.createdBy) || 'operator',
    source: text(context.source) || 'api',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    revokedAt: null,
    revokedBy: null,
    revokeReason: '',
  };
  delete /** @type {Record<string, unknown>} */ (record).now;
  return record;
}

/**
 * Whether one row counts as active at `now`. A revoked or reset row is never
 * active; an expired row is inactive even when it was never revoked.
 *
 * @param {object} record
 * @param {number} [now]
 * @returns {boolean}
 */
export function isModelPickOverrideActive(record, now = Date.now()) {
  if (!record || typeof record !== 'object') return false;
  if (text(record.revokedAt)) return false;
  const expiresMs = Date.parse(text(record.expiresAt));
  return Number.isFinite(expiresMs) && expiresMs > now;
}

/**
 * @param {object} record
 * @param {number} now
 * @returns {boolean}
 */
function isModelPickOverrideExpired(record, now) {
  if (!record || typeof record !== 'object' || text(record.revokedAt)) return false;
  const expiresMs = Date.parse(text(record.expiresAt));
  return Number.isFinite(expiresMs) && expiresMs <= now;
}

/**
 * Scope gate: a global row always applies to the caller's workspace; a
 * workspace row only applies to its own folder.
 *
 * @param {object} record
 * @param {string} workspaceFolder normalized
 * @returns {boolean}
 */
export function modelPickOverrideMatchesScope(record, workspaceFolder) {
  if (lower(record?.scope) !== 'workspace') return true;
  return normalizeOverrideWorkspaceFolder(record?.workspaceFolder) === workspaceFolder;
}

/**
 * @param {object} record
 * @param {string} role
 * @returns {boolean}
 */
export function modelPickOverrideMatchesRole(record, role) {
  const targetRole = lower(record?.targetRole);
  if (!targetRole) return true;
  return targetRole === lower(role);
}

/**
 * @param {object} record
 * @param {string} harness
 * @param {string} model
 * @returns {boolean}
 */
export function modelPickPairExcludedByOverride(record, harness, model) {
  if (lower(record?.action) !== 'exclude') return false;
  const wantedHarness = lower(harness);
  const wantedBase = lower(decodeModelValue(String(model || '')).modelId || model);
  const targetHarness = lower(record?.targetHarness);
  if (targetHarness && targetHarness !== wantedHarness) return false;
  const targetModel = lower(record?.targetModel);
  if (targetModel) {
    const targetBase = lower(decodeModelValue(String(record.targetModel)).modelId || record.targetModel);
    if (targetBase !== wantedBase) return false;
  }
  return true;
}

/**
 * Collect the override effects for one selection. Filters by scope, role and
 * TTL only; it does NOT filter by the candidate pair, so a target-specific
 * exclude removes the whole named pair from the pool.
 *
 * @param {{
 *   overrides?: object[],
 *   now?: number,
 *   workspaceFolder?: string,
 *   role?: string,
 * }} [input]
 * @returns {{
 *   active: object[],
 *   expired: object[],
 *   excludedHarnesses: string[],
 *   excludedModels: string[],
 *   excludedPairs: { harness: string, model: string }[],
 *   preferredPairs: object[],
 *   explicit: { harness: string, model: string, role: string, overrideId: string } | null,
 *   conflict: { code: string, targets: object[] } | null,
 *   refusals: object[],
 *   audit: object[],
 * }}
 */
export function collectModelPickOverrideEffects(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const workspaceFolder = normalizeOverrideWorkspaceFolder(input.workspaceFolder);
  const role = lower(input.role);
  const rows = Array.isArray(input.overrides) ? input.overrides.filter((row) => row && typeof row === 'object') : [];

  /** @type {object[]} */
  const active = [];
  /** @type {object[]} */
  const expired = [];
  /** @type {Set<string>} */
  const excludedHarnesses = new Set();
  /** @type {Set<string>} */
  const excludedModels = new Set();
  /** @type {{ harness: string, model: string }[]} */
  const excludedPairs = [];
  /** @type {object[]} */
  const preferredPairs = [];
  /** @type {object[]} */
  const refusals = [];
  /** @type {object[]} */
  const audit = [];

  for (const record of rows) {
    if (!isModelPickOverrideActive(record, now)) {
      if (isModelPickOverrideExpired(record, now)) {
        expired.push(record);
        audit.push(buildModelPickOverrideAuditEvent({
          type: 'expire',
          id: text(record.id),
          at: text(record.expiresAt),
          detail: `${text(record.action)} override expired`,
        }));
      }
      continue;
    }
    if (!modelPickOverrideMatchesScope(record, workspaceFolder)) continue;
    if (!modelPickOverrideMatchesRole(record, role)) continue;
    active.push(record);
    const action = lower(record.action);
    if (action === 'exclude') {
      const targetHarness = text(record.targetHarness);
      const targetModel = text(record.targetModel);
      if (targetHarness && targetModel) {
        excludedPairs.push({ harness: lower(targetHarness), model: targetModel });
      } else if (targetHarness) {
        excludedHarnesses.add(lower(targetHarness));
      } else if (targetModel) {
        excludedModels.add(lower(targetModel));
      }
    } else if (action === 'prefer') {
      preferredPairs.push({
        harness: lower(record.targetHarness),
        model: text(record.targetModel),
        role: lower(record.targetRole),
        overrideId: text(record.id),
        scope: lower(record.scope) === 'workspace' ? 'workspace' : 'global',
      });
    }
  }

  // Explicit precedence: workspace rows win; a single target per precedence
  // level is required. Two different explicit targets at the same level is a
  // conflict (the operator must revoke one), not a coin flip.
  let explicit = null;
  let conflict = null;
  for (const scope of ['workspace', 'global']) {
    const explicitRows = active.filter((record) => {
      if (lower(record.action) !== 'explicit-orchestrator') return false;
      return lower(record.scope) === scope;
    });
    if (explicitRows.length === 0) continue;
    const distinct = [];
    for (const row of explicitRows) {
      const key = modelPickOverrideTargetKey(row);
      if (!distinct.some((entry) => modelPickOverrideTargetKey(entry) === key)) distinct.push(row);
    }
    if (distinct.length > 1) {
      conflict = {
        code: MODEL_PICK_OVERRIDE_ERROR_CODES.CONFLICT,
        scope,
        targets: distinct.map((row) => ({
          overrideId: text(row.id),
          harness: lower(row.targetHarness),
          model: text(row.targetModel),
          role: lower(row.targetRole),
        })),
      };
      for (const row of distinct) {
        refusals.push({
          id: text(row.id),
          code: MODEL_PICK_OVERRIDE_ERROR_CODES.CONFLICT,
          reason: 'conflicting explicit-orchestrator override at the same precedence',
        });
      }
    } else {
      const row = distinct[0];
      explicit = {
        harness: lower(row.targetHarness),
        model: text(row.targetModel),
        role: lower(row.targetRole),
        overrideId: text(row.id),
      };
    }
    break;
  }

  for (const refusal of refusals) {
    audit.push(buildModelPickOverrideAuditEvent({
      type: 'refuse',
      id: refusal.id,
      at: new Date(now).toISOString(),
      detail: refusal.reason,
    }));
  }

  return {
    active,
    expired,
    excludedHarnesses: [...excludedHarnesses],
    excludedModels: [...excludedModels],
    excludedPairs: excludedPairs.map((pair) => ({ harness: pair.harness, model: pair.model })),
    // A workspace preference outranks a global one, so the first surviving
    // match in the picker is the highest-precedence preference.
    preferredPairs: preferredPairs.sort((left, right) => (
      (left.scope === 'workspace' ? 0 : 1) - (right.scope === 'workspace' ? 0 : 1)
    )),
    explicit,
    conflict,
    refusals,
    audit,
  };
}

/**
 * Whether the exact pair is refused by an active exclude at a precedence that
 * outranks the ordinary ranking. The public helper so the picker can annotate a
 * candidate without importing the sets.
 *
 * @param {object[]} overrides
 * @param {{ harness?: string, model?: string, role?: string, workspaceFolder?: string, now?: number }} [input]
 * @returns {boolean}
 */
export function isModelPickPairExcluded(overrides, input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  const workspaceFolder = normalizeOverrideWorkspaceFolder(input.workspaceFolder);
  const role = lower(input.role);
  return (Array.isArray(overrides) ? overrides : []).some((record) => (
    isModelPickOverrideActive(record, now)
    && modelPickOverrideMatchesScope(record, workspaceFolder)
    && modelPickOverrideMatchesRole(record, role)
    && modelPickPairExcludedByOverride(record, String(input.harness || ''), String(input.model || ''))
  ));
}

/**
 * Build one bounded audit event. The store persists these; the pure evaluator
 * only emits them so a caller can log an expiry/refusal it actually observed.
 *
 * @param {{ type: string, id?: string, at?: string, actor?: string, detail?: string }} input
 * @returns {object}
 */
export function buildModelPickOverrideAuditEvent(input = {}) {
  const type = lower(input.type);
  return {
    type: MODEL_PICK_OVERRIDE_AUDIT_TYPES.includes(/** @type {any} */ (type)) ? type : 'refuse',
    id: text(input.id),
    at: text(input.at) || new Date().toISOString(),
    actor: text(input.actor) || 'server',
    detail: text(input.detail),
  };
}

/**
 * Merge the active override excludes into one candidate input and return the
 * decision a caller should persist. A precedence conflict refuses before any
 * candidate is ranked.
 *
 * @param {{ harness?: string, model?: string, role?: string, workspaceFolder?: string, now?: number, overrides?: object[] }} [input]
 * @returns {object}
 */
export function resolveModelPickOverrideDecision(input = {}) {
  const resolution = collectModelPickOverrideEffects(input);
  return {
    ...resolution,
    ok: !resolution.conflict,
    explicitPair: resolution.explicit,
    preferredPairs: resolution.preferredPairs,
  };
}

/**
 * Start-time composition: override excludes feed the ONE shared hard-gate
 * validator, which still decides. A pair the override names as explicit is not
 * granted anything: it must pass every gate like any other pair. A precedence
 * conflict refuses first because the selection is ambiguous.
 *
 * @param {{
 *   hardGateInput?: object,
 *   harness?: string,
 *   model?: string,
 *   role?: string,
 *   workspaceFolder?: string,
 *   now?: number,
 *   overrides?: object[],
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   code: string,
 *   error: string,
 *   status: number,
 *   verdict: object | null,
 *   overrides: object,
 * }}
 */
export function evaluateModelPickStartOverrides(input = {}) {
  const decision = resolveModelPickOverrideDecision(input);
  if (decision.conflict) {
    return {
      ok: false,
      code: MODEL_PICK_OVERRIDE_ERROR_CODES.CONFLICT,
      error: 'Conflicting explicit-orchestrator overrides apply to this selection.',
      status: 409,
      verdict: null,
      overrides: decision,
    };
  }
  const base = input.hardGateInput && typeof input.hardGateInput === 'object' ? input.hardGateInput : {};
  const verdict = evaluateModelPickHardGates({
    ...base,
    role: input.role ?? base.role,
    harness: input.harness ?? base.harness,
    model: input.model ?? base.model,
    excludeModels: [
      ...(Array.isArray(base.excludeModels) ? base.excludeModels : []),
      ...decision.excludedModels,
    ],
    excludeHarnesses: [
      ...(Array.isArray(base.excludeHarnesses) ? base.excludeHarnesses : []),
      ...decision.excludedHarnesses,
    ],
    excludePairs: [
      ...(Array.isArray(base.excludePairs) ? base.excludePairs : []),
      ...decision.excludedPairs,
    ],
    now: Number.isFinite(Number(input.now)) ? Number(input.now) : base.now,
  });
  return {
    ok: verdict.ok === true,
    code: verdict.ok === true ? '' : String(verdict.code || ''),
    error: verdict.ok === true ? '' : String(verdict.error || ''),
    status: verdict.ok === true ? 200 : Number(verdict.status) || 409,
    verdict,
    overrides: decision,
  };
}

/**
 * Apply a resolved override decision to a picker result without granting any
 * eligibility. A preferred pair that survived the picker's own hard gates is
 * promoted to the front of the returned arrays; a pair that is absent is left
 * alone. This is the only place `prefer` influences a pick, and it can never
 * resurrect a filtered candidate.
 *
 * @param {object} picked return value of `selectModelPick`
 * @param {object} decision from {@link resolveModelPickOverrideDecision}
 * @returns {object} the same shape, possibly reordered, with an `overrides` block
 */
export function applyModelPickOverridePreference(picked, decision) {
  if (!picked || typeof picked !== 'object' || picked.ok !== true) {
    return { ...(picked && typeof picked === 'object' ? picked : {}), overrides: summarizeOverrideDecision(decision) };
  }
  const preferred = Array.isArray(decision?.preferredPairs) ? decision.preferredPairs : [];
  if (preferred.length === 0) {
    return { ...picked, overrides: summarizeOverrideDecision(decision) };
  }
  const candidates = Array.isArray(picked.candidates) ? picked.candidates : [];
  const picks = Array.isArray(picked.picks) ? picked.picks : [];
  const matchIndex = candidates.findIndex((candidate) => preferred.some((pair) => pairMatchesCandidate(pair, candidate)));
  if (matchIndex <= 0) {
    return {
      ...picked,
      overrides: { ...summarizeOverrideDecision(decision), preferred_applied: matchIndex === 0 },
    };
  }
  const promoted = candidates[matchIndex];
  const reordered = [promoted, ...candidates.slice(0, matchIndex), ...candidates.slice(matchIndex + 1)];
  return {
    ...picked,
    pick: promoted,
    picks: picks.length > 0 ? [promoted, ...picks.filter((row) => row !== promoted)] : picks,
    candidates: reordered,
    overrides: { ...summarizeOverrideDecision(decision), preferred_applied: true },
  };
}

/**
 * Prompt-free summary of a decision, safe to persist on a pick/start record.
 *
 * @param {object} decision
 * @returns {object}
 */
export function summarizeOverrideDecision(decision) {
  const source = decision && typeof decision === 'object' ? decision : {};
  return {
    ok: source.conflict == null,
    active: Array.isArray(source.active) ? source.active.map((row) => text(row.id)).filter(Boolean) : [],
    excludedHarnesses: Array.isArray(source.excludedHarnesses) ? [...source.excludedHarnesses] : [],
    excludedModels: Array.isArray(source.excludedModels) ? [...source.excludedModels] : [],
    excludedPairs: Array.isArray(source.excludedPairs) ? source.excludedPairs.map((row) => ({
      harness: lower(row?.harness),
      model: text(row?.model),
    })).filter((row) => row.harness && row.model) : [],
    preferredPairs: Array.isArray(source.preferredPairs) ? source.preferredPairs : [],
    explicit: source.explicit || null,
    conflict: source.conflict || null,
    expired: Array.isArray(source.expired) ? source.expired.map((row) => text(row.id)).filter(Boolean) : [],
  };
}

/**
 * @param {{ harness?: string, model?: string }} pair
 * @param {object} candidate
 * @returns {boolean}
 */
function pairMatchesCandidate(pair, candidate) {
  const wantedHarness = lower(pair?.harness);
  const wantedBase = lower(decodeModelValue(String(pair?.model || '')).modelId || pair?.model);
  if (!wantedHarness || !wantedBase) return false;
  const candidateHarness = lower(candidate?.harness);
  const candidateBase = lower(decodeModelValue(String(candidate?.model || '')).modelId || candidate?.model);
  return candidateHarness === wantedHarness && candidateBase === wantedBase;
}
