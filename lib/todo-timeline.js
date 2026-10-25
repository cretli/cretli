import { randomUUID } from 'node:crypto';

const ACTIVITY_KINDS = new Set(['plan_saved', 'plan_approved', 'approval_removed', 'status_changed', 'integration_changed']);
const isTimestamp = (/** @type {any} */ value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Normalize the server-owned audit metadata without retaining reports or plan bodies. */
export function normalizeTodoActivity(/** @type {any} */ value) {
  if (!Array.isArray(value)) return [];
  return value.filter((row) => row && ACTIVITY_KINDS.has(row.kind) && isTimestamp(row.at)).map((row) => ({
    id: String(row.id || ''), at: row.at, kind: row.kind,
    from: String(row.from || ''), to: String(row.to || ''), chatId: String(row.chatId || ''),
  }));
}

/** Record actual transitions, leaving no-op updates and chat-link bookkeeping silent. */
export function recordTodoActivity(/** @type {any} */ previous, /** @type {any} */ next) {
  const activity = normalizeTodoActivity(previous.activity);
  const add = (/** @type {any} */ kind, from = '', to = '', at = next.updatedAt, chatId = '') => {
    activity.push({ id: randomUUID(), at, kind, from, to, chatId });
  };
  if (previous.status !== next.status) add('status_changed', previous.status, next.status);
  if (String(previous.plan?.markdown || '') !== String(next.plan?.markdown || '')) {
    add('plan_saved', '', '', next.plan?.markdownUpdatedAt || next.plan?.updatedAt || next.updatedAt, next.plan?.sourceChatId);
  }
  if (previous.plan?.approvedAt !== next.plan?.approvedAt) {
    if (next.plan?.approvedAt) add('plan_approved', '', '', next.plan.approvedAt);
    else if (previous.plan?.approvedAt) add('approval_removed');
  }
  if (String(previous.integration?.state || '') !== String(next.integration?.state || '')) {
    add('integration_changed', previous.integration?.state, next.integration?.state);
  }
  return activity;
}

function resolvePhase(/** @type {any} */ row) {
  if (row.workRole) return row.workRole;
  if (row.assignment === 'review') return row.reviewSubject === 'plan' ? 'review_plan' : 'review_code';
  return row.executionMode === 'plan' ? 'plan' : 'implement';
}

/** Chronological read model for one TODO, including superseded reviews and archived retry attempts. */
export function buildTodoTimeline(/** @type {any} */ item, /** @type {any} */ delegations = []) {
  /** @type {any[]} */
  const entries = [];
  const add = (/** @type {any} */ kind, /** @type {any} */ at, details = {}) => {
    if (isTimestamp(at)) entries.push({ kind, at, ...details });
  };
  add('created', item.createdAt, { chatId: item.createdByChatId || '' });
  for (const row of normalizeTodoActivity(item.activity)) add(row.kind, row.at, row);
  // Legacy TODOs have no audit trail: show only milestones with a recorded date.
  add('plan_saved', item.plan?.markdownUpdatedAt || item.plan?.updatedAt, { chatId: item.plan?.sourceChatId || '' });
  add('plan_approved', item.plan?.approvedAt);
  add('integration_applied', item.integration?.appliedAt);
  add('integration_confirmed', item.integration?.evidence?.confirmedAt);
  const rounds = new Map();
  const rows = delegations.filter((/** @type {any} */ row) => row.leafId === item.id
    || (Array.isArray(row.attempts) && row.attempts.some((/** @type {any} */ attempt) => attempt.leafId === item.id)))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => String(a.queuedAt || a.startedAt || '').localeCompare(String(b.queuedAt || b.startedAt || '')));
  for (const row of rows) {
    const phase = resolvePhase(row);
    const roundKey = phase === 'review_plan' ? row.planReviewerSessionId || row.todoPlanRevisionKey : '';
    if (roundKey && !rounds.has(roundKey)) rounds.set(roundKey, rounds.size + 1);
    const attempts = [...(Array.isArray(row.attempts) ? row.attempts : []), row];
    const seenAttempts = new Set();
    for (const attempt of attempts) {
      if ((attempt.leafId || row.leafId) !== item.id) continue;
      const attemptId = String(attempt.attemptId || row.attemptId || '');
      if (seenAttempts.has(attemptId)) continue;
      seenAttempts.add(attemptId);
      const details = {
        delegationId: row.id, attemptId, phase, round: rounds.get(roundKey) || null,
        chatId: attempt.childChatId || row.childChatId || '',
        model: attempt.executor?.model || row.executor?.model || '',
        harness: attempt.executor?.transport || attempt.executor?.harness || row.executor?.transport || row.executor?.harness || '',
      };
      add('delegation_queued', attempt.queuedAt || (attempt === row ? row.createdAt : ''), details);
      add('delegation_started', attempt.startedAt || attempt.runningAt, {
        ...details, ...(!attempt.finishedAt ? { status: attempt.status || '' } : {}),
      });
      add('delegation_finished', attempt.finishedAt, {
        ...details, status: attempt.status || '', verdict: attempt.reportVerdict || '',
        reason: String(attempt.error || attempt.interruptCode || '').slice(0, 1000),
      });
      const verify = attempt.verifyResult;
      add('delegation_verified', verify?.recordedAt, {
        ...details, status: verify?.status || '', verdict: verify?.verdict || '',
      });
    }
  }
  for (const [index, note] of (item.changelog || []).entries()) {
    add('note', note.at, { id: `note:${index}`, phase: note.kind, text: note.text, chatId: note.chatId || '' });
  }
  const unique = new Map();
  for (const entry of entries) {
    const key = entry.kind === 'note' ? entry.id
      : [entry.kind, entry.at, entry.delegationId || '', entry.attemptId || ''].join(':');
    if (!unique.has(key)) unique.set(key, { ...entry, id: entry.id || key });
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
