import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDecision, getDecision } from './decision-store.js';

export const DECISION_WAIT_MAX_MS = 24_000;
export const OTHER_ANSWER_ID = '__other__';
export const FALLBACK_OPTIONS = [
  { id: 'reply', label: 'Odpowiedz w czacie', effect: 'Przekaż odpowiedź do czatu źródłowego' },
  { id: 'defer', label: 'Odłóż', effect: 'Przekaż do czatu decyzję o odłożeniu pracy' },
];
export const DECISION_PROMPT_RULE = 'Never end with an open question. Prepare 2–4 options (label and effect), indicate a recommendation, and justify it in one sentence.';

/** Producer metadata cannot lower the registry classification. */
export function normalizeDecisionOptions(input) {
  const options = Array.isArray(input.options) ? input.options.map((o, i) => ({
    id: typeof o?.id === 'string' ? o.id.trim() : `option_${i + 1}`,
    label: typeof o?.label === 'string' ? o.label.trim() : '',
    effect: typeof o?.effect === 'string' ? o.effect.trim() : '',
    ...(o?.risk === 'high' ? { risk: 'high' } : {}),
    // Explicit producer intent; never inferred from label/effect text.
    ...(['resume', 'defer', 'none'].includes(o?.continuation) ? { continuation: o.continuation } : {}),
  })) : [];
  const valid = options.length >= 2 && options.length <= 4
    && options.every((o) => o.id && o.id !== OTHER_ANSWER_ID && o.label && o.effect)
    && new Set(options.map((o) => o.id)).size === options.length
    && options.some((o) => o.id === input.recommended)
    && typeof input.why === 'string' && Boolean(input.why.trim());
  const extras = {
    ...(typeof input.blockerKey === 'string' && input.blockerKey.trim() ? { blockerKey: input.blockerKey.trim().slice(0, 200) } : {}),
    ...(typeof input.question === 'string' && input.question.trim() ? { question: input.question.trim().slice(0, 1000) } : {}),
  };
  return valid ? { options, recommended: input.recommended, why: input.why.trim(), violation: false, ...extras }
    : { ...extras, options: FALLBACK_OPTIONS, recommended: 'reply', why: 'Potrzebna jest odpowiedź człowieka.', violation: true };
}

/**
 * Creation and scoped reading only; resolution has no agent-facing operation.
 * @param {string} dataDir
 * @param {Record<string, any>} input
 * @param {{signal?: AbortSignal}} [options]
 */
export async function requestDecision(dataDir, input, { signal } = {}) {
  let card;
  if (input.decisionId) {
    card = await getDecision(dataDir, input.decisionId);
    if (!card || card.workspaceFolder !== input.workspaceFolder || card.subject.chatId !== input.chatId) {
      throw Object.assign(new Error('Decision outside calling chat'), { code: 'OUT_OF_SCOPE' });
    }
  } else {
    if (input.kind === 'operator_proposal') {
      throw Object.assign(new Error('Use operator_propose to create an operator proposal'), { code: 'OUT_OF_SCOPE' });
    }
    if (input.kind === 'doc_proposal') {
      throw Object.assign(new Error('Use doc_propose_* to create a Docs proposal'), { code: 'OUT_OF_SCOPE' });
    }
    if (!input.chatId || !input.idempotencyKey || !input.title) {
      throw Object.assign(new Error('chatId, title and idempotencyKey required'), { code: 'VALIDATION_ERROR' });
    }
    const normalized = normalizeDecisionOptions(input);
    if (normalized.violation) throw Object.assign(new Error('Provide 2–4 options, recommended option id and why'), { code: 'VALIDATION_ERROR' });
    card = await createDecision(dataDir, {
      ...input, ...normalized, kind: input.kind || 'question',
      subject: { chatId: input.chatId, updatedAt: input.idempotencyKey },
      dedupeKey: `request:${input.workspaceFolder}:${input.chatId}:${input.idempotencyKey}`,
      producer: input.chatId,
    });
  }
  const waitMs = Math.min(DECISION_WAIT_MAX_MS, Math.max(0, Number(input.waitMs) || 0));
  const deadline = Date.now() + waitMs;
  while (['pending', 'deciding'].includes(card.status) && Date.now() < deadline && !signal?.aborted) {
    try { await delay(Math.min(200, deadline - Date.now()), undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; break; }
    card = await getDecision(dataDir, card.id);
  }
  return { ok: true, decision: card, pending: ['pending', 'deciding'].includes(card.status) };
}

/** Version of the scope a question was raised for: the plan revision of each related todo. */
export async function computeDecisionScopeVersion(dataDir, workspaceFolder, todoIds) {
  const ids = [...new Set((todoIds || []).map(String))].sort();
  const parts = [];
  // Lazy: the todo stack is not loaded with every importer of the request helpers.
  const { getTodo } = await import('../persist/todos-store.js');
  for (const id of ids) {
    const row = await getTodo(dataDir, workspaceFolder, id).catch(() => null);
    // Plan revision plus a hash of the todo text: an edited body changes what the answer was given for.
    const text = row ? createHash('sha1').update(`${row.title || ''}\u0000${row.body || row.description || ''}`).digest('hex').slice(0, 12) : '';
    parts.push(row ? `${id}:${row.plan?.markdownUpdatedAt || row.plan?.updatedAt || '0'}:${text}` : `${id}:missing`);
  }
  return parts.join('|') || 'none';
}

/** Relation types a decision may reference; anything else is refused instead of stored untyped. */
export const DECISION_REF_TYPES = Object.freeze(['todo', 'chat', 'cycle', 'delegation', 'scout_finding', 'patch', 'material', 'git_commit']);

/**
 * Validate typed source references. Entries need a known `type` and a non-empty string `id`; duplicates collapse.
 * @param {unknown} refs
 * @returns {{ type: string, id: string }[]}
 */
export function normalizeDecisionRefs(refs) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) throw Object.assign(new Error('relations.refs must be an array'), { code: 'VALIDATION' });
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const type = typeof ref?.type === 'string' ? ref.type : '';
    const id = typeof ref?.id === 'string' ? ref.id.trim() : '';
    if (!DECISION_REF_TYPES.includes(type) || !id || id.length > 512) throw Object.assign(new Error('Invalid decision relation reference'), { code: 'VALIDATION' });
    if (seen.has(`${type}\u0000${id}`)) continue;
    seen.add(`${type}\u0000${id}`);
    out.push({ type, id });
  }
  return out;
}

/** Identity of what a card proposes: changed question, options or effects make a new proposal version. */
export function computeProposalHash(normalized) {
  const body = JSON.stringify({
    q: normalized.question || '',
    o: (normalized.options || []).map((o) => [o.id, o.label, o.effect, o.continuation || '']),
  });
  return createHash('sha1').update(body).digest('hex').slice(0, 12);
}

export async function createWatcherHumanDecision(dataDir, workspaceFolder, report) {
  const normalized = normalizeDecisionOptions(report);
  const todoIds = [...new Set((report.todoIds || []).map(String))].sort();
  const blockerKey = normalized.blockerKey || '';
  const scopeVersion = await computeDecisionScopeVersion(dataDir, workspaceFolder, todoIds);
  // A stable blocker key makes the question independent of the cycle: the same blocker on the same todos
  // reuses one card until the scope changes. Reports without a key keep the legacy per-cycle card.
  const dedupeKey = blockerKey ? `watcher:${workspaceFolder}:${todoIds.join(',')}:${blockerKey}` : `watcher:${workspaceFolder}:${report.cycleId}`;
  const proposalHash = computeProposalHash(normalized);
  const refs = normalizeDecisionRefs([
    ...todoIds.map((id) => ({ type: 'todo', id })),
    ...(report.chatId ? [{ type: 'chat', id: String(report.chatId) }] : []),
    ...(report.cycleId ? [{ type: 'cycle', id: String(report.cycleId) }] : []),
    ...(Array.isArray(report.sources) ? report.sources : []),
  ]);
  const card = await createDecision(dataDir, {
    ...normalized, kind: 'needs_human', workspaceFolder,
    // The proposal hash is part of the revision: a changed question/options supersedes the earlier card.
    subject: { chatId: report.chatId, updatedAt: blockerKey ? `scope:${scopeVersion}:${proposalHash}` : report.reportId, todoIds },
    title: normalized.question || 'Watcher needs your decision', summary: report.message,
    dedupeKey, producer: report.chatId,
    origin: { schemaVersion: 1, kind: 'watcher_report', cycleId: report.cycleId || '', chatId: report.chatId || '', reportId: report.reportId || '' },
    relations: {
      schemaVersion: 2, todoIds, chatId: report.chatId || '', cycleId: report.cycleId || '', scopeVersion, proposalHash,
      structured: Boolean(blockerKey), refs,
      journeyId: `journey:${createHash('sha1').update(`${workspaceFolder}\u0000${todoIds.join(',')}\u0000${blockerKey || report.cycleId || ''}`).digest('hex').slice(0, 16)}`,
    },
  });
  return { decision: card, ...(normalized.violation || report.violation ? {
    warning: 'needs_human requires 2–4 options, recommended and why; fallback options used.',
  } : {}) };
}
