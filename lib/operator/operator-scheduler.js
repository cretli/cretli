/**
 * Scheduler of the internal operator: at most ONE run at a time in the whole
 * Cretli (the single `running` row of `operator_runs`), one run = one workspace.
 *
 * Per tick: ingest journal events -> supervise our running run (report,
 * deadline, token cap, idle without report) -> start the next run when the
 * limits allow. Every run gets a NEW hidden chat (`pickPurpose: operator_run`)
 * and starts in plan mode with `origin: system/operator`; the owner thread only
 * receives host notices. Executors are limited to `claude` and `sdk` (the
 * harnesses with a hard read-only gate); any other pick is a
 * `failed/no_safe_harness` run, never a fallback.
 *
 * Run end reasons: `done` (report recorded), `deadline` (15 min by default),
 * `missing_report` (chat idle without a report), `token_cap`, `start_failed`,
 * `no_model`, `no_safe_harness`, `server_shutdown`.
 */

import { randomUUID } from 'node:crypto';
import { VALID_TRANSPORTS } from '../agent-transport.js';
import { SCOUT_READ_ONLY_ENFORCING_HARNESSES } from '../workspace-scout-read-only.js';
import { addChatAsync } from '../persist/chats-persist.js';
import { startChatRun, cancelChatRun, probeChatRunLivenessAsync } from '../chat-run-service.js';
import { pickModelForPurpose } from '../model-pick-service.js';
import { readUsageEvents } from '../persist/usage-persist.js';
import { sumAttributedUsage } from '../delegation-workflow-budget.js';
import { getWorkspaceWatcher } from '../persist/workspace-watchers-persist.js';
import { listOperatorNotes, onOperatorEventRecorded } from '../persist/operator-journal-persist.js';
import { OPERATOR_RUN_PICK_PURPOSE } from './operator-constants.js';
import { appendOperatorAudit } from './operator-audit.js';
import { ingestOperatorEvents } from './operator-event-ingest.js';
import {
  ackEvents, claimPendingEvents, claimRunSlot, heartbeatRunSlot, openOperatorStore, recoverInterruptedWork, releaseRunSlot,
} from './operator-internal-store.js';
import { appendOperatorOwnerNotice, ensureOperatorChat } from './operator-chat.js';
import { buildOperatorBriefing } from './operator-briefing.js';
import {
  classifyRunKind, evaluateDailyBudget, evaluateHourlyLimit, markBreakerNotified, operatorEventPriority, readBreaker,
  readDailyTokens, recordRunOutcome,
} from './operator-limits.js';
import { readOperatorSettings } from './operator-settings.js';
import { readOwnerPause } from './operator-owner.js';
import { noteChatRowsForOperatorIndex } from './operator-run-chat-registry.js';

/**
 * @typedef {object} OperatorQueueRow
 * @property {string} event_id
 * @property {string} workspace
 * @property {string} kind
 * @property {string} enqueued_at
 * @property {string} event_created_at
 */
/** @typedef {{ id: string, summary: string }} OperatorRunSummaryRow */
/** @typedef {{ id: string, title: string, rationale: string }} OperatorProposalRow */
/** @typedef {{ id: string, direction: string, text: string }} OperatorOwnerMessageRow */

/** Harnesses with a host-enforced read-only gate for operator runs. */
export const OPERATOR_SAFE_HARNESSES = Object.freeze(['claude', 'sdk']);
/** Every harness the picker must never return for an operator run: all known transports except the safe ones. */
export function operatorExcludedHarnesses() {
  return [...new Set([...VALID_TRANSPORTS, ...SCOUT_READ_ONLY_ENFORCING_HARNESSES])].filter((id) => !OPERATOR_SAFE_HARNESSES.includes(id));
}
export const OPERATOR_TICK_MS = 15_000;
/** A chat that is idle this long after the run started, with no report, is `missing_report`. */
export const OPERATOR_IDLE_GRACE_MS = 20_000;
const MAX_EVENTS_PER_RUN = 20;
const iso = (ms) => new Date(ms).toISOString();

/** @param {unknown} text @param {number} max */
const clip = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * One-line summary of the tool calls of a run, from its audit rows.
 *
 * @param {Record<string, any>} storeOptions
 * @param {string} runId
 * @returns {string}
 */
export function summarizeRunToolCalls(storeOptions, runId) {
  const db = openOperatorStore(storeOptions);
  try {
    const rows = db.prepare('SELECT tool, outcome, COUNT(*) AS n FROM operator_audit WHERE run_id = ? AND tool != ? GROUP BY tool, outcome ORDER BY n DESC, tool').all(runId, 'operator_run');
    if (!rows.length) return 'Tool calls: none.';
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
    const denied = rows.filter((row) => row.outcome === 'denied').reduce((sum, row) => sum + Number(row.n), 0);
    const list = rows.slice(0, 8).map((row) => `${row.tool}${row.outcome === 'denied' ? ' (denied)' : ''}×${row.n}`).join(', ');
    return `Tool calls: ${total}${denied ? `, ${denied} denied` : ''} — ${list}${rows.length > 8 ? ', …' : ''}.`;
  } finally { db.close(); }
}

/**
 * @param {{
 *   dataDir?: string, file?: string, settings?: Record<string, any> | (() => Record<string, any>),
 *   now?: () => number, tickMs?: number, idleGraceMs?: number, logger?: { warn?: Function, error?: Function },
 *   deps?: Record<string, any>,
 * }} [options] `deps`: pickExecutor, addChat, startChatRun, cancelRun, probeLiveness, measureTokens, readWorkspaceState,
 *   appendNotice, notify (tests inject fakes)
 */
export function createOperatorScheduler(options = {}) {
  const deps = options.deps || {};
  const instanceId = randomUUID();
  const clock = options.now || (() => Date.now());
  const logger = options.logger || console;
  const idleGraceMs = options.idleGraceMs ?? OPERATOR_IDLE_GRACE_MS;
  const base = { dataDir: options.dataDir, file: options.file };
  const storeAt = () => ({ ...base, now: clock() });
  const settings = () => (typeof options.settings === 'function' ? options.settings() : readOperatorSettings({ settings: options.settings ? { operatorInternal: options.settings } : undefined }));
  const appendNotice = (notice) => appendOperatorOwnerNotice(notice, { ...base, deps: deps.appendNotice ? { appendNotice: deps.appendNotice, ...deps.chatDeps } : deps.chatDeps });
  let ticking = false;
  let timer = null;
  let unsubscribe = null;
  let wake = null;

  const readRun = (id) => {
    const db = openOperatorStore(base);
    try { return db.prepare('SELECT * FROM operator_runs WHERE id = ?').get(id) || null; } finally { db.close(); }
  };
  const updateRun = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const db = openOperatorStore(base);
    try { db.prepare(`UPDATE operator_runs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id); } finally { db.close(); }
  };
  const audit = (runId, action, outcome, reason) => {
    try { appendOperatorAudit({ runId, tool: 'operator_run', action, outcome, reason }, storeAt()); } catch (error) { logger.warn?.(`[operator-scheduler] audit failed: ${error?.message || error}`); }
  };

  /** Pending events of the whole queue, best first (priority, then oldest). */
  function readPending() {
    const db = openOperatorStore(base);
    try {
      const rows = /** @type {OperatorQueueRow[]} */ (db.prepare("SELECT * FROM operator_internal_queue WHERE state='pending' ORDER BY journal_epoch, event_rowid").all());
      return rows
        .map((row) => ({ ...row, priority: operatorEventPriority(String(row.kind)) }))
        .sort((a, b) => a.priority - b.priority);
    } finally { db.close(); }
  }

  function hydrateEvents(rows) {
    const db = openOperatorStore(base);
    try {
      return rows.map((row) => {
        const event = db.prepare('SELECT summary FROM operator_events WHERE id = ?').get(row.event_id);
        return { id: row.event_id, kind: row.kind, summary: event?.summary || '', createdAt: row.event_created_at, workspace: row.workspace };
      });
    } finally { db.close(); }
  }

  function readBriefingInputs(workspace, events) {
    const db = openOperatorStore(base);
    try {
      const previousRuns = /** @type {OperatorRunSummaryRow[]} */ (db.prepare("SELECT id, report_summary AS summary FROM operator_runs WHERE workspace = ? AND report_summary IS NOT NULL ORDER BY started_at DESC LIMIT 3").all(workspace));
      const proposals = /** @type {OperatorProposalRow[]} */ (db.prepare("SELECT id, title, body AS rationale FROM operator_proposals WHERE workspace = ? AND state = 'open' ORDER BY created_at DESC LIMIT 10").all(workspace));
      const ownerMessages = events.some((event) => event.kind === 'owner_message')
        ? /** @type {OperatorOwnerMessageRow[]} */ (db.prepare('SELECT id, direction, text FROM operator_owner_messages ORDER BY created_at DESC LIMIT 20').all().reverse()) : [];
      return { previousRuns, proposals, ownerMessages };
    } finally { db.close(); }
  }

  async function workspaceState(workspace) {
    if (typeof deps.readWorkspaceState === 'function') return String(await deps.readWorkspaceState(workspace) || '');
    try {
      const watcher = getWorkspaceWatcher(workspace, { dataDir: base.dataDir });
      if (!watcher) return 'No watcher row for this workspace.';
      return `Watcher mode: ${watcher.mode || 'unknown'}; paused: ${Boolean(watcher.paused)}; stop reason: ${watcher.stopReason || 'none'}.`;
    } catch { return ''; }
  }

  async function pickExecutor(kind, workspace) {
    if (typeof deps.pickExecutor === 'function') return deps.pickExecutor({ kind, workspace });
    try {
      const picked = (deps.pickModel || pickModelForPurpose)({
        purpose: OPERATOR_RUN_PICK_PURPOSE, role: 'plan', complexity: kind === 'triage' ? 'trivial' : 'standard',
        workspaceFolder: workspace, dataDir: base.dataDir, harnesses: [...OPERATOR_SAFE_HARNESSES],
        // `harnesses` only seeds the cold-start catalog; the hard filter is the exclude list.
        excludeHarnesses: deps.excludedHarnesses || operatorExcludedHarnesses(),
      });
      return picked?.ok && picked.pick ? { harness: String(picked.pick.harness || ''), model: String(picked.pick.model || '') } : null;
    } catch { return null; }
  }

  async function measureTokens(run) {
    if (!run.chat_id) return 0;
    try {
      if (typeof deps.measureTokens === 'function') return Number(await deps.measureTokens(run.chat_id)) || 0;
      const from = iso(Date.parse(String(run.started_at)) - 60_000);
      const events = readUsageEvents({ from, to: iso(clock()), dataDir: base.dataDir });
      return sumAttributedUsage(events, { delegationIds: new Set(), chatIds: new Set([String(run.chat_id)]) }).tokens;
    } catch { return 0; }
  }

  async function cancelRunChat(run) {
    if (!run.chat_id) return;
    try { await (deps.cancelRun || cancelChatRun)({ chatId: run.chat_id, reason: 'operator_run_ended' }); } catch (error) { logger.warn?.(`[operator-scheduler] cancel failed: ${error?.message || error}`); }
  }

  /**
   * End a run we own. Success acks its events; failure returns them once
   * (then parks them), counts toward the breaker per `operator-limits.js`, and
   * always writes the report / tool-call summary to the owner thread.
   */
  async function finishRun(run, result) {
    const tokens = Math.max(Number(run.tokens_used) || 0, await measureTokens(run));
    updateRun(run.id, { tokens_used: tokens });
    const opts = { ...storeAt(), ownerInstanceId: instanceId, runId: run.id };
    if (result.ok) {
      const eventIds = (() => { const db = openOperatorStore(base); try { return /** @type {{ event_id: string }[]} */ (db.prepare("SELECT event_id FROM operator_internal_queue WHERE state='claimed' AND claimed_by_run = ?").all(run.id)).map((r) => r.event_id); } finally { db.close(); } })();
      ackEvents(opts, { ...opts, eventIds });
      releaseRunSlot(opts, { ...opts, state: 'completed' });
    } else {
      if (result.cancel) await cancelRunChat(run);
      releaseRunSlot(opts, { ...opts, state: 'failed', failureReason: result.reason, requeueClaims: true });
    }
    audit(run.id, 'finish', result.ok ? 'allowed' : 'denied', result.ok ? 'done' : result.reason);
    const fresh = readRun(run.id) || run;
    const parts = [result.ok
      ? `Operator run ${String(run.id).slice(0, 8)} (${run.run_kind || 'run'}) finished: ${clip(fresh.report_summary, 1500) || 'no summary'}`
      : `Operator run ${String(run.id).slice(0, 8)} (${run.run_kind || 'run'}) failed: ${result.reason}.`];
    if (result.ok) {
      try {
        const proposals = JSON.parse(String(fresh.report_proposals || '[]'));
        if (proposals.length) parts.push(`Proposals: ${proposals.map((p) => clip(p.title, 120)).join('; ')}`);
      } catch { /* a malformed proposal list is shown without proposals */ }
    }
    parts.push(summarizeRunToolCalls(base, run.id));
    parts.push(`Tokens: ${tokens}.`);
    await appendNotice({ text: parts.join('\n'), kind: 'run_finished', runId: run.id, level: result.ok ? 'info' : 'warn' });
    const s = settings();
    const outcome = recordRunOutcome(base, { runId: run.id, ok: result.ok, reason: result.reason, threshold: s.circuitBreakerFailures, now: clock() });
    if (outcome.tripped) {
      const sent = await appendNotice({ text: `Operator paused after ${outcome.failures} failed runs in a row. Owner messages still run; clear the circuit breaker to resume event-triggered runs.`, kind: 'circuit_open', level: 'warn' });
      if (sent.ok) markBreakerNotified(base);
      try { deps.notify?.({ kind: 'operator_circuit_open', failures: outcome.failures }); } catch { /* best effort */ }
    }
    return { runId: run.id, ...result, tokens };
  }

  /** Interrupt a run we own (owner deleted its chat): events return once, the breaker is untouched. */
  async function finishInterrupted(run, reason) {
    const opts = { ...storeAt(), ownerInstanceId: instanceId, runId: run.id };
    releaseRunSlot(opts, { ...opts, state: 'interrupted', failureReason: reason });
    audit(run.id, 'finish', 'denied', reason);
    await appendNotice({ text: `Operator run ${String(run.id).slice(0, 8)} (${run.run_kind || 'run'}) was interrupted: ${reason}.`, kind: 'run_interrupted', runId: run.id, level: 'warn' });
    return { runId: run.id, ok: false, reason, interrupted: true };
  }

  async function supervise(run) {
    const s = settings();
    const now = clock();
    heartbeatRunSlot({ ...storeAt(), ownerInstanceId: instanceId, runId: run.id }, { runId: run.id, ownerInstanceId: instanceId });
    let fresh = readRun(run.id) || run;
    if (fresh.reported_at) return finishRun(fresh, { ok: true, reason: 'done' });
    // A run that never got its chat/deadline (start crashed) is bounded from started_at.
    const deadlineAt = fresh.deadline_at ? Date.parse(String(fresh.deadline_at)) : Date.parse(String(fresh.started_at)) + s.runDeadlineMs;
    if (now >= deadlineAt) return finishRun(fresh, { ok: false, reason: fresh.chat_id ? 'deadline' : 'start_failed', cancel: true });
    if (!fresh.chat_id) return null; // start still in progress
    const tokens = await measureTokens(fresh);
    if (tokens !== Number(fresh.tokens_used || 0)) { updateRun(run.id, { tokens_used: tokens }); fresh = { ...fresh, tokens_used: tokens }; }
    const cap = fresh.run_kind === 'triage' ? s.perRunTokens.triage : s.perRunTokens.diagnosis;
    if (tokens > cap) return finishRun(fresh, { ok: false, reason: 'token_cap', cancel: true });
    const live = await (deps.probeLiveness || probeChatRunLivenessAsync)({ chatId: fresh.chat_id });
    if (live.reason === 'chat_missing') return finishInterrupted(fresh, 'chat_deleted');
    if (now - Date.parse(String(fresh.started_at)) < idleGraceMs) return null;
    const idle = live.known && !live.busy;
    if (!idle) return null;
    // Re-read: the report may have landed between the first read and the probe.
    fresh = readRun(run.id) || fresh;
    if (fresh.reported_at) return finishRun(fresh, { ok: true, reason: 'done' });
    return finishRun(fresh, { ok: false, reason: 'missing_report' });
  }

  async function failEarly(runId, reason, claimed) {
    const opts = { ...storeAt(), ownerInstanceId: instanceId, runId };
    releaseRunSlot(opts, { ...opts, state: 'failed', failureReason: reason, requeueClaims: true });
    audit(runId, 'start', 'denied', reason);
    const s = settings();
    recordRunOutcome(base, { runId, ok: false, reason, threshold: s.circuitBreakerFailures, now: clock() });
    await appendNotice({ text: `Operator run ${runId.slice(0, 8)} could not start: ${reason}.`, kind: 'run_failed', runId, level: 'warn' });
    return { runId, ok: false, reason, events: claimed };
  }

  async function startNext() {
    /** @type {string} */
    let claimedRunId = '';
    try { return await startNextNow((id) => { claimedRunId = id; }); } catch (error) {
      logger.error?.(`[operator-scheduler] start failed: ${error?.message || error}`);
      // An exception after the slot was claimed must not leave a run that never ends.
      return claimedRunId ? failEarly(claimedRunId, 'start_failed', 0) : { error: String(error?.message || error) };
    }
  }

  async function startNextNow(onClaim) {
    const s = settings();
    const now = clock();
    const pending = readPending();
    if (!pending.length) return { skipped: 'idle' };
    const best = pending[0];
    const ready = best.priority <= 1 || now - Date.parse(String(best.enqueued_at)) >= s.coalesceMs;
    if (!ready) return { skipped: 'coalescing' };
    const breaker = readBreaker(base);
    if (breaker.paused && best.priority > 0) return { skipped: 'circuit_open' };
    if (readOwnerPause(base).paused && best.priority > 0) return { skipped: 'owner_paused' };
    const hourly = evaluateHourlyLimit(base, { now, workspace: best.workspace, runsPerHour: s.runsPerHour, runsPerHourPerWorkspace: s.runsPerHourPerWorkspace, bestPriority: best.priority });
    if (!hourly.allowed) return { skipped: hourly.reason };
    const daily = evaluateDailyBudget(readDailyTokens(base, now), s, best.priority);
    if (!daily.allowed) {
      await noticeOnce(`budget:${daily.reason}:${new Date(now).toDateString()}`, `Operator stopped for today: ${daily.reason}.`);
      return { skipped: daily.reason };
    }
    const claim = claimRunSlot(storeAt(), { ownerInstanceId: instanceId, workspace: best.workspace, triggerEventId: best.event_id, triggerKind: best.kind });
    if (!claim.ok) return { skipped: 'slot_busy' };
    const runId = claim.runId;
    onClaim(runId);
    const claimedRows = claimPendingEvents({ ...storeAt(), runId, ownerInstanceId: instanceId }, { runId, ownerInstanceId: instanceId, workspace: best.workspace, limit: MAX_EVENTS_PER_RUN });
    if (!claimedRows.length) {
      releaseRunSlot({ ...storeAt() }, { runId, ownerInstanceId: instanceId, state: 'completed' });
      return { skipped: 'no_events' };
    }
    const events = hydrateEvents(claimedRows);
    const kind = classifyRunKind(events, { triageOnly: daily.triageOnly });
    const executor = await pickExecutor(kind, best.workspace);
    if (!executor || !executor.harness) return failEarly(runId, 'no_model', events.length);
    if (!OPERATOR_SAFE_HARNESSES.includes(executor.harness)) return failEarly(runId, 'no_safe_harness', events.length);
    const owner = await ensureOperatorChat({ ...base, deps: deps.chatDeps });
    if (!owner.ok) return failEarly(runId, 'start_failed', events.length);
    const inputs = readBriefingInputs(best.workspace, events);
    let notes = [];
    try { notes = listOperatorNotes(best.workspace, base).slice(0, 20); } catch { /* notes are optional context */ }
    const briefing = buildOperatorBriefing({
      workspace: best.workspace, kind, events, workspaceState: await workspaceState(best.workspace), notes, ...inputs,
    });
    const chatId = randomUUID();
    let created;
    try {
      created = await (deps.addChat || addChatAsync)(randomUUID(), `[Operator run] ${runId.slice(0, 8)}`, null, best.workspace, executor.model || undefined, {
        id: chatId, agentTransport: executor.harness, sdkMode: 'plan', pickPurpose: OPERATOR_RUN_PICK_PURPOSE,
        operatorRunId: runId, operatorParentChatId: owner.chatId, isTemporary: true,
      });
      noteChatRowsForOperatorIndex(created);
    } catch { return failEarly(runId, 'start_failed', events.length); }
    const activeChatId = created?.id || chatId;
    updateRun(runId, {
      chat_id: activeChatId, run_kind: kind, harness: executor.harness, model: executor.model || null,
      deadline_at: iso(now + s.runDeadlineMs), untrusted_refs: JSON.stringify(briefing.untrustedRefs), tokens_used: 0,
    });
    audit(runId, 'start', 'allowed', kind);
    try {
      const started = await (deps.startChatRun || startChatRun)({
        chatId: activeChatId, prompt: briefing.text, mode: 'plan', requestId: runId, displayText: 'Operator run',
        origin: { kind: 'system', subtype: 'operator' },
      });
      if (started?.accepted === false) throw new Error('run_not_accepted');
    } catch {
      return finishRun({ ...readRun(runId), chat_id: activeChatId }, { ok: false, reason: 'start_failed', cancel: true });
    }
    return { started: true, runId, chatId: activeChatId, kind, events: events.length };
  }

  const noticed = new Set();
  async function noticeOnce(key, text) {
    if (noticed.has(key)) return;
    noticed.add(key);
    await appendNotice({ text, kind: 'budget', level: 'warn' });
  }

  function ownedRunning() {
    const db = openOperatorStore(base);
    try { return db.prepare("SELECT * FROM operator_runs WHERE state='running' AND owner_instance_id = ?").get(instanceId) || null; } finally { db.close(); }
  }

  async function tick() {
    if (ticking) return { skipped: 'busy' };
    const enabled = settings().enabled;
    ticking = true;
    try {
      if (!enabled) {
        // Disabled at runtime: no new work, but a live run of ours is still supervised (deadline, caps, report).
        const live = ownedRunning();
        return live ? ((await supervise(live)) || { skipped: 'running' }) : { skipped: 'disabled' };
      }
      try {
        const s = settings();
        ingestOperatorEvents({ ...storeAt(), maxPending: s.maxPending, coalesceWindowMs: s.coalesceMs, logger });
      } catch (error) { logger.warn?.(`[operator-scheduler] ingest failed: ${error?.message || error}`); }
      const db = openOperatorStore(base);
      let running;
      try { running = db.prepare("SELECT * FROM operator_runs WHERE state='running'").get(); } finally { db.close(); }
      if (running) {
        if (running.owner_instance_id !== instanceId) return { skipped: 'slot_busy' };
        return (await supervise(running)) || { skipped: 'running' };
      }
      return await startNext();
    } catch (error) {
      logger.error?.(`[operator-scheduler] tick failed: ${error?.message || error}`);
      return { error: String(error?.message || error) };
    } finally { ticking = false; }
  }

  return {
    instanceId,
    tick,
    /** Recover stale runs of an earlier process, then tick on a timer and on journal writes. */
    start() {
      if (timer) return;
      try { recoverInterruptedWork(storeAt()); } catch (error) { logger.warn?.(`[operator-scheduler] recovery failed: ${error?.message || error}`); }
      timer = setInterval(() => { void tick(); }, options.tickMs ?? OPERATOR_TICK_MS);
      timer.unref?.();
      unsubscribe = onOperatorEventRecorded(() => {
        if (wake) return;
        wake = setTimeout(() => { wake = null; void tick(); }, 250);
        wake.unref?.();
      });
      void tick();
    },
    /** Stop timers; a run of ours is returned to the queue as interrupted. */
    async stop() {
      if (timer) clearInterval(timer);
      if (wake) clearTimeout(wake);
      timer = null; wake = null;
      unsubscribe?.(); unsubscribe = null;
      const db = openOperatorStore(base);
      let running;
      try { running = db.prepare("SELECT * FROM operator_runs WHERE state='running' AND owner_instance_id = ?").get(instanceId); } finally { db.close(); }
      if (running) {
        await cancelRunChat(running);
        const opts = { ...storeAt(), ownerInstanceId: instanceId, runId: running.id };
        releaseRunSlot(opts, { ...opts, state: 'interrupted', failureReason: 'server_shutdown' });
      }
    },
  };
}
