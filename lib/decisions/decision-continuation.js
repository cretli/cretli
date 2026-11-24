/**
 * Durable continuation of a decided `needs_human` card (docs/decision-cards.md, "Continuation").
 *
 * The decision document is the source of truth: the answer, the scope it was given for and a
 * `continuation` record whose status moves saved -> applying -> waiting|applied|none|failed -> resumed.
 * `resumed` is written only when a Watcher cycle really starts for the todo and receives the answer.
 * Nothing here approves plans, reviews, integrations or permissions, and nothing bypasses pause, stop or
 * budgets: a resume only clears the todo's retry delay and nudges the existing scheduler.
 */
import { randomUUID } from 'node:crypto';
import { OTHER_ANSWER_ID, computeDecisionScopeVersion } from './decision-request.js';
import { annotateDecision, listDecisions, getDecision } from './decision-store.js';
import { getTodo, updateTodo } from '../persist/todos-store.js';
import { getWorkspaceWatcher, mutateWorkspaceWatcherRow } from '../persist/workspace-watchers-persist.js';
import { scheduleWorkspaceWatcherAutopilot } from '../workspace-watcher-event-schedule.js';

/** An `applying` claim older than this may be taken over (crash between claim and outcome). */
export const CONTINUATION_APPLY_LEASE_MS = 60 * 1000;

/** What choosing an option does to the todo; legacy cards (no explicit intent) only deliver the answer. */
export function optionIntent(card, optionId) {
  if (optionId === OTHER_ANSWER_ID) return card.relations?.structured ? 'resume' : 'deliver';
  const option = (card.options || []).find((entry) => entry.id === optionId);
  return ['resume', 'defer', 'none'].includes(option?.continuation) ? option.continuation : 'deliver';
}

/** Continuation record stored together with the `decided` transition. */
export function buildContinuation(card, optionId, text, now = new Date().toISOString()) {
  const option = (card.options || []).find((entry) => entry.id === optionId) || null;
  return {
    status: 'saved', intent: optionIntent(card, optionId), savedAt: now,
    todoIds: card.subject?.todoIds || [], scopeVersion: card.relations?.scopeVersion || '',
    answer: { optionId, label: option?.label || '', effect: option?.effect || '', text: String(text || '').trim().slice(0, 4000) },
  };
}

/** Pending or in-flight needs_human cards hold their todos back from the Watcher (only those todos). */
export async function listPendingDecisionTodoIds(dataDir, workspaceFolder) {
  const ids = new Set();
  for (const card of await listDecisions(dataDir, workspaceFolder)) {
    if (card.kind !== 'needs_human' || !['pending', 'deciding'].includes(card.status)) continue;
    for (const id of card.subject?.todoIds || []) ids.add(String(id));
  }
  return ids;
}

async function fail(dataDir, card, reason, token = '') {
  const at = new Date().toISOString();
  return annotateDecision(dataDir, card.id, { status: 'failed', error: reason, failedAt: at, claimToken: '' },
    { ...(token ? { expectToken: token } : {}), event: { key: `continuation:failed:${Date.now()}`, type: 'continuation_failed', at, snapshot: { reason } } });
}

/** True when a todo was parked as `idea` by the Watcher's needs_human escalation (it carries a blocked reason). */
const parkedByEscalation = (row) => row.status === 'idea' && Boolean(String(row.blockedReason || '').trim());

/**
 * Apply the stored continuation once. Safe to call repeatedly (HTTP retry, restart reconcile, human retry):
 * the `saved -> applying` claim is a compare-and-swap that stores a claim token, a lease takeover must match the
 * exact claim generation it saw, and every later write is fenced by the token, so a stale applier cannot
 * overwrite the outcome of the one that took over.
 */
export async function applyDecisionContinuation(dataDir, decisionId, { force = false } = {}) {
  let card = await getDecision(dataDir, decisionId);
  const cont = card?.continuation;
  if (!card || card.status !== 'decided' || !cont) return card;
  // A newer report superseded this card: its resume/defer belongs to an outdated proposal, so no side effects.
  if (card.supersededBy) return card;
  const stale = cont.status === 'applying' && Date.now() - Date.parse(cont.applyingAt || '') >= CONTINUATION_APPLY_LEASE_MS;
  const retryable = cont.status === 'saved' || stale || (force && cont.status === 'failed');
  if (!retryable) return card;
  const token = randomUUID();
  card = await annotateDecision(dataDir, card.id, { status: 'applying', applyingAt: new Date().toISOString(), claimToken: token, error: '' },
    { expectStatus: cont.status, ...(stale ? { expectApplyingAt: cont.applyingAt } : {}) });
  if (!card) return getDecision(dataDir, decisionId); // lost the claim to a concurrent caller
  const { workspaceFolder } = card;
  const todoIds = cont.todoIds || [];
  const finish = async (patch, type, snapshot, key = `continuation:${type}`) => {
    const at = new Date().toISOString();
    const next = await annotateDecision(dataDir, card.id, { ...patch, claimToken: '' }, { expectToken: token, event: { key, type, at, snapshot } });
    return next || getDecision(dataDir, decisionId); // fenced out: another applier owns the outcome now
  };
  try {
    if (cont.intent === 'deliver' && todoIds.length) {
      // Answer-only: no resume, no scheduler nudge. The answer stays loadable (`waiting`) until each todo's
      // next cycle really starts with it in its prompt.
      return await finish({ status: 'waiting', waitingSince: new Date().toISOString() }, 'continuation_waiting', { todoIds, intent: 'deliver' }, 'continuation:waiting');
    }
    if (cont.intent === 'none' || cont.intent === 'deliver' || !todoIds.length) {
      return await finish({ status: cont.intent === 'deliver' ? 'applied' : 'none', appliedAt: new Date().toISOString() }, 'continuation_settled', { intent: cont.intent }, 'continuation:settled');
    }
    const scopeNow = await computeDecisionScopeVersion(dataDir, workspaceFolder, todoIds);
    if (cont.scopeVersion && scopeNow !== cont.scopeVersion) return await fail(dataDir, card, 'scope_changed', token);
    const rows = await Promise.all(todoIds.map((id) => getTodo(dataDir, workspaceFolder, id).catch(() => null)));
    if (rows.some((row) => !row || row.status === 'done')) return await fail(dataDir, card, 'todo_gone_or_done', token);
    if (cont.intent === 'defer') {
      for (const row of rows) {
        if (row.status === 'deferred') continue;
        if (!['ready', 'idea'].includes(row.status)) return await fail(dataDir, card, 'todo_not_deferrable', token);
        await updateTodo(dataDir, workspaceFolder, row.id, { status: 'deferred', deferredReason: 'Deferred by decision', expectedUpdatedAt: row.updatedAt });
      }
      return await finish({ status: 'applied', appliedAt: new Date().toISOString() }, 'continuation_settled', { intent: 'defer', todoIds }, 'continuation:settled');
    }
    // resume: a needs_human escalation parked the todo as `idea`; make exactly that todo eligible again (CAS on
    // its revision). Plan approval, review and permissions are untouched: the scheduler still gates the start.
    for (const row of rows) {
      if (!parkedByEscalation(row)) continue;
      await updateTodo(dataDir, workspaceFolder, row.id, {
        status: 'ready', strictStatus: true, blockedReason: null, expectedUpdatedAt: row.updatedAt,
        appendChangelog: { kind: 'note', text: `Resumed by human decision ${card.id}.` },
      });
    }
    // Then release the retry delay of exactly these todos and let the scheduler decide when to start.
    mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
      const blockedBackoff = { ...(row.blockedBackoff || {}) };
      const failures = { ...(row.failures || {}) };
      for (const id of todoIds) { delete blockedBackoff[id]; delete failures[id]; }
      return { blockedBackoff, failures };
    }, { dataDir, createIfMissing: false });
    const waiting = await finish({ status: 'waiting', waitingSince: new Date().toISOString() }, 'continuation_waiting', { todoIds }, 'continuation:waiting');
    scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir });
    return waiting;
  } catch (error) {
    return fail(dataDir, card, String(error?.message || error).slice(0, 300), token);
  }
}

/** Re-apply every stored, not yet applied continuation of a workspace (restart / partial write recovery). */
export async function reconcileDecisionContinuations(dataDir, workspaceFolder) {
  for (const card of await listDecisions(dataDir, workspaceFolder)) {
    const status = card.continuation?.status;
    if (card.status === 'decided' && !card.supersededBy && (status === 'saved' || status === 'applying')) {
      await applyDecisionContinuation(dataDir, card.id).catch((error) => console.error('[decisions] continuation failed:', error));
    }
  }
}

/** Decided answers a cycle for `todoId` must receive: resume or answer-only intent, not yet delivered to this todo. */
export async function loadContinuationContext(dataDir, workspaceFolder, todoId) {
  const candidates = (await listDecisions(dataDir, workspaceFolder)).filter((card) => card.kind === 'needs_human'
    && card.status === 'decided' && !card.supersededBy && ['resume', 'deliver'].includes(card.continuation?.intent) && card.continuation.status === 'waiting'
    && (card.continuation.todoIds || []).includes(todoId) && !(card.continuation.resumedTodoIds || []).includes(todoId));
  const cards = [];
  for (const card of candidates) {
    // The answer was given for one scope; once plan or body changed it is no longer authoritative.
    const scopeVersion = card.continuation.scopeVersion;
    if (scopeVersion && await computeDecisionScopeVersion(dataDir, workspaceFolder, card.continuation.todoIds || []) !== scopeVersion) {
      await fail(dataDir, card, 'scope_changed').catch(() => {});
      continue;
    }
    cards.push(card);
  }
  const lines = cards.flatMap((card) => {
    const a = card.continuation.answer || {};
    return [
      `Human decision ${card.id} (already resolved; do not ask this question again): ${card.question || card.title}`,
      `  Chosen: ${a.label || a.optionId}${a.effect ? ` — ${a.effect}` : ''}`,
      ...(a.text ? [`  Human instruction: ${a.text}`] : []),
      '  This decision covers only this todo and its scope at the time of the answer; it does not approve plans, reviews, integration or permissions.',
    ];
  });
  return { decisionIds: cards.map((card) => card.id), lines };
}

/**
 * Record that the cycle prompt of `todoId` could not carry these answers. The continuation stays `waiting`
 * (the answer is neither dropped nor failed for sibling todos): every todo of the card keeps receiving it on
 * its next cycle, and the per-todo error is visible in `continuationState.deliveryErrors`.
 */
export async function recordContinuationDeliveryError(dataDir, decisionIds, { todoId, reason }) {
  const at = new Date().toISOString();
  for (const id of decisionIds || []) {
    await annotateDecision(dataDir, id, undefined,
      { deliveryError: { todoId, reason, at }, event: { key: `continuation:delivery_error:${todoId}:${Date.now()}`, type: 'continuation_delivery_error', at, snapshot: { todoId, reason } } })
      .catch(() => {});
  }
}

/**
 * Durable decision -> delegation link: an idempotent event on the card (key per delegation id), so the history
 * of a decision shows which delegations carried its answer. Safe to repeat.
 */
export async function linkDecisionDelegation(dataDir, decisionId, { delegationId, todoId = '', role = '' }) {
  if (!decisionId || !delegationId) return null;
  const at = new Date().toISOString();
  return annotateDecision(dataDir, decisionId, undefined,
    { linkDelegation: { delegationId: String(delegationId), todoId, role },
      event: { key: `delegation:${delegationId}`, type: 'delegation_linked', at, snapshot: { delegationId: String(delegationId), todoId, role } } });
}

/**
 * Record that a cycle really started for `todoId` with these answers in its prompt. Tracked per todo: the
 * continuation becomes `resumed` only once every todo of the card got its context.
 */
export async function markContinuationsResumed(dataDir, decisionIds, { cycleId, chatId, todoId }) {
  const at = new Date().toISOString();
  for (const id of decisionIds) {
    await annotateDecision(dataDir, id, undefined,
      { resumeTodo: { todoId, cycleId, chatId, at }, event: { key: `continuation:resumed:${todoId}`, type: 'continuation_resumed', at, snapshot: { todoId, cycleId, chatId } } });
  }
}

/** Why a waiting continuation has not started yet, from the live Watcher row (never a promise of a start). */
function waitingReason(dataDir, workspaceFolder) {
  try {
    const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
    if (!row || row.mode !== 'autopilot') return 'watcher_not_autopilot';
    if (row.paused) return 'watcher_paused';
    if (row.stopReason) return 'watcher_stopped';
  } catch { /* fall through */ }
  return 'waiting_for_scheduler';
}

/**
 * API read model: safe names (never private paths), the full question, effects and the real continuation
 * state, plus provenance (legacy cards read as `unknown`) and todo references that may no longer exist.
 */
export async function presentDecision(dataDir, card) {
  const todoIds = card.relations?.todoIds || card.subject?.todoIds || (card.subject?.todoId ? [card.subject.todoId] : []);
  const todos = await Promise.all(todoIds.map(async (id) => {
    const row = await getTodo(dataDir, card.workspaceFolder, id).catch(() => null);
    return { id, title: row ? String(row.title || '') : '', missing: !row };
  }));
  const cont = card.continuation || null;
  let scopeChanged = false;
  if (card.relations?.scopeVersion && todoIds.length) {
    scopeChanged = (await computeDecisionScopeVersion(dataDir, card.workspaceFolder, todoIds)) !== card.relations.scopeVersion;
  }
  const projectName = String(card.workspaceFolder || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
  return {
    ...card,
    projectName, todos, question: card.question || card.title,
    origin: card.origin || { schemaVersion: 1, kind: 'unknown', legacy: true },
    scopeChanged, legacy: !card.relations?.structured && card.kind === 'needs_human',
    continuationState: cont ? {
      ...cont, ...(cont.status === 'waiting' ? { waitingFor: cont.intent === 'deliver' ? 'next_cycle' : waitingReason(dataDir, card.workspaceFolder) } : {}),
      retryable: ['failed', 'saved', 'applying'].includes(cont.status),
    } : null,
  };
}
