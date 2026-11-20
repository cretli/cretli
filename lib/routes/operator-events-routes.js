/**
 * Operator state-event feed: a long-poll over the `operator_events` journal so
 * the external operator wakes on a transition (review_failed, needs_rescope,
 * integration_ready, watcher_stopped, ...) instead of polling on a cron.
 *
 * GET /api/operator/events?workspaceFolder=&since=&types=&wait=&limit=
 *   - `since`: numeric cursor from a previous response. `since=0` returns the
 *     backlog; an absent `since` returns no events and the current head cursor.
 *     A `since` beyond the head is answered with that same cursor (never backwards).
 *     `since` and `limit` (1-500) must be plain decimal integers, else 400.
 *   - `types`: comma-separated event kinds; empty means every kind.
 *   - `wait`: long-poll budget in ms (capped), used only when nothing is ready.
 * Local only (loopback peers) and behind the global auth middleware; widget and
 * MCP-integration callers are refused.
 */

import { isLoopbackAddress } from '../local-login.js';
import { getOperatorEventsHead, listOperatorEventsSince, onOperatorEventRecorded } from '../persist/operator-journal-persist.js';

export const OPERATOR_EVENTS_MAX_WAIT_MS = 25_000;
export const OPERATOR_EVENTS_DEFAULT_WAIT_MS = 20_000;
export const OPERATOR_EVENTS_MAX_LIMIT = 500;
/** Re-read cadence while waiting; covers writers outside this process. */
const FALLBACK_POLL_MS = 2_000;

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function parseTypes(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))].slice(0, 20);
}

/**
 * @param {import('express').Express} app
 * @param {{ dataDir?: string, getCurrentCwd?: () => string, maxWaitMs?: number, pollMs?: number, isLocal?: (req: any) => boolean }} [ctx]
 */
export function registerOperatorEventsRoutes(app, ctx = {}) {
  const options = ctx.dataDir ? { dataDir: ctx.dataDir } : {};
  const maxWait = Number.isFinite(ctx.maxWaitMs) ? Number(ctx.maxWaitMs) : OPERATOR_EVENTS_MAX_WAIT_MS;
  const pollMs = Number.isFinite(ctx.pollMs) && Number(ctx.pollMs) > 0 ? Number(ctx.pollMs) : FALLBACK_POLL_MS;
  const isLocal = ctx.isLocal || ((req) => isLoopbackAddress(req.socket?.remoteAddress));

  app.get('/api/operator/events', (req, res) => {
    if (req.widgetAccess || req.mcpIntegration) return res.status(403).json({ ok: false, error: 'operator_events_unavailable' });
    if (!isLocal(req)) return res.status(403).json({ ok: false, error: 'operator_events_local_only' });
    const folder = String(req.query?.workspaceFolder || '').trim() || String(ctx.getCurrentCwd?.() || '').trim();
    if (!folder) return res.status(400).json({ ok: false, error: 'workspaceFolder_required' });
    const kinds = parseTypes(req.query?.types);
    // Strict decimal integers only: no floats, signs, exponents or whitespace.
    const rawLimit = req.query?.limit;
    const limit = rawLimit === undefined ? 100 : (typeof rawLimit === 'string' && /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : NaN);
    if (!Number.isInteger(limit) || limit < 1 || limit > OPERATOR_EVENTS_MAX_LIMIT) return res.status(400).json({ ok: false, error: 'invalid_limit' });
    const rawSince = req.query?.since;
    const hasSince = rawSince !== undefined;
    const since = hasSince && typeof rawSince === 'string' && /^\d{1,15}$/.test(rawSince) ? Number(rawSince) : NaN;
    if (hasSince && !Number.isSafeInteger(since)) return res.status(400).json({ ok: false, error: 'invalid_since' });
    const waitRaw = Number(req.query?.wait);
    const wait = Math.min(maxWait, Math.max(0, Number.isFinite(waitRaw) ? waitRaw : OPERATOR_EVENTS_DEFAULT_WAIT_MS));

    /** @returns {{ events: any[], cursor: number }} */
    const read = (after) => listOperatorEventsSince(folder, { after, kinds, limit }, options);

    try {
      if (!hasSince) {
        // First contact: nothing to replay, just hand out the head cursor.
        return res.json({ ok: true, events: [], cursor: getOperatorEventsHead(folder, options), waited: false });
      }
      const first = read(since);
      if (first.events.length > 0 || wait === 0) return res.json({ ok: true, events: first.events, cursor: first.cursor, waited: false });

      let cursor = first.cursor;
      let done = false;
      /** @type {NodeJS.Timeout | undefined} */
      let deadline;
      /** @type {NodeJS.Timeout | undefined} */
      let poller;
      let unsubscribe = () => {};
      const finish = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        clearInterval(poller);
        unsubscribe();
        if (!res.headersSent) res.json({ ok: true, waited: true, ...payload });
      };
      const check = () => {
        if (done) return;
        try {
          const next = read(since);
          cursor = next.cursor;
          if (next.events.length > 0) finish({ events: next.events, cursor: next.cursor });
        } catch (error) {
          finish({ events: [], cursor, error: error instanceof Error ? error.message : 'read_failed' });
        }
      };
      unsubscribe = onOperatorEventRecorded((changed) => { if (changed === folder || normalize(changed) === normalize(folder)) check(); });
      poller = setInterval(check, pollMs);
      deadline = setTimeout(() => finish({ events: [], cursor }), wait);
      req.on('close', () => { done = true; clearTimeout(deadline); clearInterval(poller); unsubscribe(); });
      return undefined;
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      return res.status(code === 'VALIDATION_ERROR' ? 400 : 500).json({ ok: false, error: error instanceof Error ? error.message : 'operator_events_failed' });
    }
  });
}

/** @param {unknown} value */
function normalize(value) {
  return String(value ?? '').replace(/\/+$/, '');
}
