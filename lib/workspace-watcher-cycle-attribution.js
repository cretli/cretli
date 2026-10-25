/**
 * Versioned orchestrator attribution for one Workspace Watcher cycle.
 *
 * The cycle metric already records the requested/actual orchestrator pair, the
 * lifecycle timestamps and a disjoint cost correlation. This module adds the
 * two facts a model-comparison needs but a job counter cannot give:
 *
 * - **rounds per leaf** read from the durable delegation-workflow store. A
 *   round is the parent's implement -> review -> fix loop state, not the number
 *   of jobs or retries. A leaf with no durable row is `null`/`unknown`, never
 *   reconstructed from history.
 * - **child composition**: which child started, in which role, on which
 *   requested pair, and — only when telemetry confirms it — the actual
 *   provider/model/effort. Requested and actual identity stay separate; an
 *   unconfirmed actual stays null instead of being guessed.
 *
 * The result is pure: callers inject the workflow rows, delegation rows and
 * usage events. The persisted shape is normalized defensively so an older or
 * partial record degrades to `unknown` rather than fabricating a value.
 */

import { delegationController } from './delegation-control.js';
import { decodeModelValue } from './model-catalog.js';
import { MODEL_PICK_REVIEW_PROTOCOL_VERSION } from './model-pick-policy.js';

export const WORKSPACE_WATCHER_CYCLE_ATTRIBUTION_SCHEMA_VERSION = 1;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function optionalText(value) {
  const out = text(value);
  return out || null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function optionalPositiveInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const rounded = Math.floor(num);
  return rounded >= 0 ? rounded : null;
}

/**
 * @param {unknown} modelValue
 * @returns {string | null}
 */
function readEffort(modelValue) {
  const model = text(modelValue);
  if (!model) return null;
  const params = decodeModelValue(model).params;
  if (Array.isArray(params)) {
    const hit = params.find((row) => text(row?.id) === 'effort');
    return optionalText(hit?.value);
  }
  const effort = params && typeof params === 'object' ? /** @type {Record<string, unknown>} */ (params).effort : '';
  return optionalText(effort);
}

/**
 * Resolve the actual identity confirmed by telemetry for one delegation. Only a
 * matching usage event can confirm it; without one the actual fields stay null.
 *
 * @param {Record<string, any>} child
 * @param {Record<string, any>[]} events
 * @returns {{ harness: string | null, model: string | null, provider: string | null, effort: string | null }}
 */
function resolveActualIdentity(child, events) {
  const delegationId = text(child?.id);
  const childChatId = text(child?.childChatId);
  const event = events.find((row) => {
    if (!row || typeof row !== 'object') return false;
    const eventDelegation = text(row.delegationId);
    if (delegationId && eventDelegation === delegationId) return true;
    const eventChat = text(row.chatId);
    return Boolean(childChatId) && eventChat === childChatId;
  }) || null;
  if (!event) return { harness: null, model: null, provider: null, effort: null };
  const actualModel = optionalText(event.model);
  return {
    harness: optionalText(event.harness),
    model: actualModel,
    provider: optionalText(event.provider),
    effort: readEffort(actualModel),
  };
}

/**
 * @param {Record<string, any>} child
 * @param {Record<string, any>[]} events
 * @returns {Record<string, any>}
 */
function buildChildAttribution(child, events) {
  const executor = child?.executor && typeof child.executor === 'object' ? child.executor : {};
  const requestedModel = optionalText(executor.model);
  const actual = resolveActualIdentity(child, events);
  return {
    delegationId: optionalText(child?.id),
    childChatId: optionalText(child?.childChatId),
    leafId: optionalText(child?.leafId),
    role: optionalText(child?.pickRole || child?.assignment),
    requestedHarness: optionalText(executor.harness || executor.transport),
    requestedModel,
    requestedEffort: readEffort(requestedModel),
    harness: actual.harness,
    model: actual.model,
    provider: actual.provider,
    effort: actual.effort,
    status: optionalText(child?.status),
    outcome: optionalText(child?.taskOutcome),
  };
}

/**
 * @param {string[]} leafIds
 * @param {Record<string, any>[]} workflowRows
 * @param {string} parentChatId
 * @returns {Record<string, Record<string, any>>}
 */
function buildRoundsByLeaf(leafIds, workflowRows, parentChatId) {
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const leafId of leafIds) {
    const row = workflowRows.find((candidate) => (
      text(candidate?.leafId) === leafId
      && (!parentChatId || !text(candidate?.parentChatId) || text(candidate.parentChatId) === parentChatId)
    ));
    out[leafId] = row
      ? {
        round: optionalPositiveInt(row.round),
        maxRounds: optionalPositiveInt(row.maxRounds),
        lastVerdict: optionalText(row.lastVerdict),
        source: 'durable',
      }
      : {
        round: null,
        maxRounds: null,
        lastVerdict: null,
        source: 'unknown',
      };
  }
  return out;
}

/**
 * Build the versioned attribution block for one cycle.
 *
 * @param {{
 *   cycle?: Record<string, any>,
 *   workflowRows?: Record<string, any>[],
 *   delegations?: Record<string, any>[],
 *   events?: Record<string, any>[],
 *   reviewProtocolVersion?: string | null,
 * }} [input]
 * @returns {Record<string, any>}
 */
export function buildWorkspaceWatcherCycleAttribution(input = {}) {
  const cycle = input.cycle && typeof input.cycle === 'object' ? input.cycle : {};
  const workflowRows = Array.isArray(input.workflowRows) ? input.workflowRows : [];
  const delegations = Array.isArray(input.delegations) ? input.delegations : [];
  const events = Array.isArray(input.events) ? input.events : [];
  const orchestratorChatId = text(cycle.orchestratorChatId || cycle.chatId);
  const leafIds = [...new Set(
    (Array.isArray(cycle.todoIds) ? cycle.todoIds : [])
      .map((id) => text(id))
      .filter(Boolean),
  )];
  const children = delegations
    .filter((row) => row && typeof row === 'object')
    .filter((row) => {
      const parent = text(delegationController(row)) || text(row.sourceChatId);
      return Boolean(orchestratorChatId) && parent === orchestratorChatId;
    })
    .map((row) => buildChildAttribution(row, events));
  return {
    schemaVersion: WORKSPACE_WATCHER_CYCLE_ATTRIBUTION_SCHEMA_VERSION,
    reviewProtocolVersion: optionalText(input.reviewProtocolVersion ?? MODEL_PICK_REVIEW_PROTOCOL_VERSION),
    roundsByLeaf: buildRoundsByLeaf(leafIds, workflowRows, orchestratorChatId),
    children,
    childCount: children.length,
  };
}

/**
 * Defensive normalizer for the stored attribution block. A corrupt/partial
 * record must not crash a reader; unknown fields fall back to `null`.
 *
 * @param {unknown} raw
 * @returns {Record<string, any> | null}
 */
export function normalizeWorkspaceWatcherCycleAttribution(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = /** @type {Record<string, unknown>} */ (raw);
  const roundsSource = source.roundsByLeaf && typeof source.roundsByLeaf === 'object' && !Array.isArray(source.roundsByLeaf)
    ? /** @type {Record<string, unknown>} */ (source.roundsByLeaf)
    : {};
  /** @type {Record<string, Record<string, any>>} */
  const roundsByLeaf = {};
  for (const [leafId, value] of Object.entries(roundsSource)) {
    const id = text(leafId);
    if (!id) continue;
    const row = value && typeof value === 'object' && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : {};
    roundsByLeaf[id] = {
      round: optionalPositiveInt(row.round),
      maxRounds: optionalPositiveInt(row.maxRounds),
      lastVerdict: optionalText(row.lastVerdict),
      source: text(row.source) === 'durable' ? 'durable' : 'unknown',
    };
  }
  const children = Array.isArray(source.children)
    ? source.children
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map((row) => {
        const child = /** @type {Record<string, unknown>} */ (row);
        return {
          delegationId: optionalText(child.delegationId),
          childChatId: optionalText(child.childChatId),
          leafId: optionalText(child.leafId),
          role: optionalText(child.role),
          requestedHarness: optionalText(child.requestedHarness),
          requestedModel: optionalText(child.requestedModel),
          requestedEffort: optionalText(child.requestedEffort),
          harness: optionalText(child.harness),
          model: optionalText(child.model),
          provider: optionalText(child.provider),
          effort: optionalText(child.effort),
          status: optionalText(child.status),
          outcome: optionalText(child.outcome),
        };
      })
    : [];
  return {
    schemaVersion: WORKSPACE_WATCHER_CYCLE_ATTRIBUTION_SCHEMA_VERSION,
    reviewProtocolVersion: optionalText(source.reviewProtocolVersion),
    roundsByLeaf,
    children,
    childCount: children.length,
  };
}
