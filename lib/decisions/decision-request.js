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
  })) : [];
  const valid = options.length >= 2 && options.length <= 4
    && options.every((o) => o.id && o.id !== OTHER_ANSWER_ID && o.label && o.effect)
    && new Set(options.map((o) => o.id)).size === options.length
    && options.some((o) => o.id === input.recommended)
    && typeof input.why === 'string' && Boolean(input.why.trim());
  return valid ? { options, recommended: input.recommended, why: input.why.trim(), violation: false }
    : { options: FALLBACK_OPTIONS, recommended: 'reply', why: 'Potrzebna jest odpowiedź człowieka.', violation: true };
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

export async function createWatcherHumanDecision(dataDir, workspaceFolder, report) {
  const normalized = normalizeDecisionOptions(report);
  const card = await createDecision(dataDir, {
    ...normalized, kind: 'needs_human', workspaceFolder,
    subject: { chatId: report.chatId, updatedAt: report.reportId, todoIds: report.todoIds },
    title: 'Watcher needs your decision', summary: report.message,
    dedupeKey: `watcher:${workspaceFolder}:${report.cycleId}`, producer: report.chatId,
  });
  return { decision: card, ...(normalized.violation || report.violation ? {
    warning: 'needs_human requires 2–4 options, recommended and why; fallback options used.',
  } : {}) };
}
