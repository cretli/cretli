/**
 * Pure usage/diagnostics summary of a chat history event list. Lives apart from
 * chat-history-persist.js so the SQLite worker handlers and the async adapter
 * can share it without loading the file-backed legacy store.
 */
import { estimateEffectiveUsageInputTokens } from '../sdk/sdk-context-advisory.ts';

/** Reason attached to usage events stored before `usageMeta` existed. */
export const LEGACY_USAGE_REASON = 'legacy_no_metadata';

/**
 * Metadata of a stored usage event. Events written before `usageMeta` carry only
 * what the record itself holds (harness, creation time); nothing else is
 * invented, so they are never occupancy-eligible and have no epoch.
 *
 * @param {Record<string, any>} rec history record
 * @param {Record<string, any>} event sdk event inside the record
 * @returns {Record<string, any>}
 */
export function resolveHistoryUsageMeta(rec, event) {
  const meta = event.usageMeta;
  if (meta && typeof meta === 'object') return { ...meta, legacy: false };
  return {
    legacy: true,
    harness: typeof rec.harness === 'string' && rec.harness ? rec.harness : null,
    observedAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : null,
    provenance: null,
    accountingScope: null,
    completeness: null,
    contextEpoch: null,
    logicalEventKey: null,
    occupancy: { eligible: false, reasons: [LEGACY_USAGE_REASON] },
  };
}

/** @returns {{ events: number, inputTokens: number|null, outputTokens: number|null }} */
function emptyScopeTotals() {
  return { events: 0, inputTokens: null, outputTokens: null };
}

/**
 * @param {{ events: number, inputTokens: number|null, outputTokens: number|null }} totals
 * @param {number} input NaN when the payload did not report it
 * @param {number} output NaN when the payload did not report it
 */
function addScopeTotals(totals, input, output) {
  totals.events += 1;
  // null = never reported; a reported zero stays 0 and is not "missing".
  if (Number.isFinite(input)) totals.inputTokens = (totals.inputTokens ?? 0) + input;
  if (Number.isFinite(output)) totals.outputTokens = (totals.outputTokens ?? 0) + output;
}

/**
 * Token and count snapshot for diagnostics. Stored on the in-memory document
 * so a later diag read does not walk the event list again.
 *
 * @param {Array<{ rec?: unknown }> | undefined} events
 * @returns {object}
 */
export function summarizeChatHistoryUsage(events) {
  let localUserCount = 0;
  let sdkEventCount = 0;
  let lastUsageInputTokens = null;
  let maxUsageInputTokens = null;
  let lastEffectiveUsageInputTokens = null;
  let maxEffectiveUsageInputTokens = null;
  let lastUsageOutputTokens = null;
  let lastUsageTotalTokens = null;
  let lastContextUsage = null;
  let lastCallContextTokens = null;
  let lastCallModel = null;
  let lastCallContextWindowTokens = null;
  let lastStatusError = null;
  // Provenance-aware view (additive): own/consolidated stay separate, replays are
  // counted once, and only an eligible current-prompt snapshot of the latest
  // epoch/session/model may become `currentPrompt`.
  const seenKeys = new Set();
  const counts = { total: 0, withMeta: 0, legacy: 0, duplicates: 0, lateEpoch: 0, lateTime: 0, cumulative: 0, sessionChanges: 0, modelChanges: 0 };
  const byScope = { own: emptyScopeTotals(), consolidated: emptyScopeTotals(), unknown: emptyScopeTotals() };
  let latestContextEpoch = null;
  let latestSourceMs = null;
  let lastUsageMeta = null;
  let currentPrompt = null;
  let latestSession = null;
  let latestModel = null;
  for (const entry of Array.isArray(events) ? events : []) {
    const rec = entry?.rec;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.kind === 'localUser') localUserCount += 1;
    if (rec.kind !== 'sdk') continue;
    sdkEventCount += 1;
    const event = rec.event;
    if (!event || typeof event !== 'object') continue;
    const isUsageShaped = event.type === 'usage' || event.type === 'context_usage';
    let replay = false;
    if (isUsageShaped) {
      const meta = resolveHistoryUsageMeta(rec, event);
      counts.total += 1;
      if (meta.legacy) counts.legacy += 1; else counts.withMeta += 1;
      replay = typeof meta.logicalEventKey === 'string' && seenKeys.has(meta.logicalEventKey);
      if (replay) {
        counts.duplicates += 1;
      } else {
        if (typeof meta.logicalEventKey === 'string') seenKeys.add(meta.logicalEventKey);
        const epoch = typeof meta.contextEpoch === 'number' ? meta.contextEpoch : null;
        const own = meta.accountingScope === 'own';
        // Lateness is provable only from an epoch the event itself carried; a room
        // epoch stamped at observation time can never be older than the room's.
        const late = epoch != null && meta.contextEpochSource === 'event'
          && latestContextEpoch != null && epoch < latestContextEpoch;
        // Same session and epoch but an adapter timestamp older than one already
        // accepted: a reordered delivery of an earlier call.
        const sourceMs = typeof meta.sourceObservedAt === 'string' ? Date.parse(meta.sourceObservedAt) : NaN;
        const lateTime = own && !meta.legacy && Number.isFinite(sourceMs)
          && latestSourceMs != null && sourceMs < latestSourceMs
          && !(epoch != null && latestContextEpoch != null && epoch > latestContextEpoch);
        if (late) counts.lateEpoch += 1;
        else if (lateTime) counts.lateTime += 1;
        if (meta.measurementKind === 'cumulative') counts.cumulative += 1;
        const scope = own || meta.accountingScope === 'consolidated' ? meta.accountingScope : 'unknown';
        if (event.type === 'usage') {
          addScopeTotals(byScope[scope], Number(event.usage?.inputTokens), Number(event.usage?.outputTokens));
        }
        // Only the parent's own, on-time measurements move the epoch/session/model
        // markers; child (consolidated), late and unattributed events must not.
        const advances = own && !late && !lateTime && !meta.legacy;
        if (advances && Number.isFinite(sourceMs)) latestSourceMs = sourceMs;
        if (advances && epoch != null && (latestContextEpoch == null || epoch > latestContextEpoch)) {
          latestContextEpoch = epoch;
          // A newer epoch invalidates every earlier current-prompt snapshot.
          if (currentPrompt && currentPrompt.contextEpoch !== epoch) currentPrompt = null;
        }
        // Billing `usage` events carry a call model only incidentally; the
        // session/model markers follow prompt snapshots.
        const marksContext = advances && event.type === 'context_usage';
        const session = typeof meta.sourceSessionId === 'string' ? meta.sourceSessionId : null;
        if (marksContext && session) {
          if (latestSession && session !== latestSession) {
            counts.sessionChanges += 1;
            currentPrompt = null;
          }
          latestSession = session;
        }
        const model = typeof meta.model === 'string' && meta.model ? meta.model : null;
        if (marksContext && model) {
          if (latestModel && model !== latestModel) {
            counts.modelChanges += 1;
            currentPrompt = null;
          }
          latestModel = model;
        }
        // A legacy label is shown only while no attributed measurement exists.
        if (advances || (meta.legacy && (!lastUsageMeta || lastUsageMeta.legacy))) lastUsageMeta = meta;
        if (advances && meta.occupancy?.eligible === true && Number.isFinite(meta.occupancy.promptTokens)) {
          currentPrompt = {
            promptTokens: meta.occupancy.promptTokens,
            limitTokens: meta.occupancy.limitTokens ?? null,
            observedAt: meta.observedAt ?? null,
            contextEpoch: epoch,
            model,
            harness: meta.harness ?? null,
            sourceSessionId: session,
            provenance: meta.provenance ?? null,
            completeness: meta.completeness ?? null,
            accountingScope: meta.accountingScope ?? null,
            granularity: meta.granularity ?? null,
            measurementKind: meta.measurementKind ?? null,
          };
        }
      }
    }
    if (event.type === 'usage' && event.usage && typeof event.usage === 'object') {
      const inputTokens = Number(event.usage.inputTokens);
      const outputTokens = Number(event.usage.outputTokens);
      const totalTokens = Number(event.usage.totalTokens);
      const cacheReadTokens = Number(event.usage.cacheReadTokens);
      const effectiveInputTokens = estimateEffectiveUsageInputTokens(inputTokens, cacheReadTokens);
      if (Number.isFinite(inputTokens)) {
        lastUsageInputTokens = inputTokens;
        if (!Number.isFinite(maxUsageInputTokens) || inputTokens > maxUsageInputTokens) {
          maxUsageInputTokens = inputTokens;
        }
      }
      if (Number.isFinite(effectiveInputTokens)) {
        lastEffectiveUsageInputTokens = effectiveInputTokens;
        if (!Number.isFinite(maxEffectiveUsageInputTokens) || effectiveInputTokens > maxEffectiveUsageInputTokens) {
          maxEffectiveUsageInputTokens = effectiveInputTokens;
        }
      }
      if (Number.isFinite(outputTokens)) lastUsageOutputTokens = outputTokens;
      if (Number.isFinite(totalTokens)) lastUsageTotalTokens = totalTokens;
    }
    if (event.type === 'context_usage') lastContextUsage = event;
    if (event.type === 'context_usage' || (event.type === 'usage' && rec.harness !== 'codex')) {
      const lastCallTotalTokens = Number((event.type === 'context_usage' ? event.usage : event.lastCallUsage)?.totalTokens);
      lastCallContextTokens = Number.isFinite(lastCallTotalTokens) && lastCallTotalTokens > 0
        ? lastCallTotalTokens
        : null;
      const measuredModel = event.type === 'context_usage' ? event.model : event.lastCallModel;
      lastCallModel = typeof measuredModel === 'string' && measuredModel
        ? measuredModel
        : null;
      // Runs stored before the explicit field still carry the SDK's modelUsage.
      const reportedWindow = Number(
        (event.type === 'context_usage' ? event.contextWindowTokens : event.lastCallContextWindowTokens)
          ?? (lastCallModel ? event.modelUsage?.[lastCallModel]?.contextWindow : null),
      );
      lastCallContextWindowTokens = lastCallContextTokens != null
        && Number.isFinite(reportedWindow) && reportedWindow > 0
        ? Math.round(reportedWindow)
        : null;
    }
    if (event.type === 'status' && String(event.status || '').toUpperCase() === 'ERROR') {
      lastStatusError = typeof event.message === 'string' ? event.message : null;
    }
  }
  return {
    localUserCount,
    sdkEventCount,
    lastUsageInputTokens,
    maxUsageInputTokens,
    lastEffectiveUsageInputTokens,
    maxEffectiveUsageInputTokens,
    lastUsageOutputTokens,
    lastUsageTotalTokens,
    lastContextUsage,
    lastCallContextTokens,
    lastCallModel,
    lastCallContextWindowTokens,
    lastStatusError,
    usageMeta: {
      counts,
      latestContextEpoch,
      lastUsageMeta,
      byScope,
      currentPrompt,
      occupancySource: currentPrompt ? 'snapshot' : 'estimated',
    },
  };
}
