/**
 * `operator_proposal` decision cards: typed, server-side adapters for proposals an operator (agent, MCP bearer)
 * puts in front of the owner. The operator may only CREATE the card (`createOperatorProposalCard`); resolution
 * goes through the human-only route `POST /api/decisions/:id`, which claims the card and calls
 * `executeOperatorProposal` via the kind registry in decision-adapters.js. No LLM is involved after creation.
 */
import { createHash } from 'node:crypto';
import { getTodo, updateTodo } from '../persist/todos-store.js';
import { addOperatorNote } from '../persist/operator-journal-persist.js';
import { acceptWorkspaceWatcherScopeRequest } from '../workspace-watcher-cycle-close.js';
import { createDecision } from './decision-store.js';

export const OPERATOR_PROPOSAL_KIND = 'operator_proposal';
/** Actions with a typed adapter. Everything else is refused, at creation and again at execution. */
export const OPERATOR_PROPOSAL_ACTIONS = Object.freeze(['extend_scope', 'defer_todo', 'mark_ready_for_integration']);
/** Human-only matters have their own cards (plan_approval, integration, policy_upgrade); they are never proposals. */
export const OPERATOR_PROPOSAL_HUMAN_ONLY_ACTIONS = Object.freeze([
  'approve_plan', 'plan_approval', 'confirm_integration', 'integration', 'policy_upgrade', 'doc_proposal',
]);
const REASON_MAX = 1000;
const FILES_MAX = 50;

const invalid = (message) => Object.assign(new Error(message), { code: 'VALIDATION' });
const options = [
  { id: 'approve', label: 'Approve proposal', effect: 'Apply the proposed change to the todo' },
  { id: 'reject', label: 'Reject proposal', effect: 'Discard the proposal; the todo stays unchanged' },
];

/** Validates and normalizes action params; throws VALIDATION for an unsupported action or bad params. */
export function validateOperatorProposal(action, params = {}) {
  if (OPERATOR_PROPOSAL_HUMAN_ONLY_ACTIONS.includes(action) || !OPERATOR_PROPOSAL_ACTIONS.includes(action)) {
    throw invalid(`Unsupported proposal action: ${String(action)}`);
  }
  const reason = String(params?.reason ?? '').trim().slice(0, REASON_MAX);
  if (action === 'extend_scope') {
    // Omitted files means "the whole open request"; a present value must be a non-empty array of strings.
    if (params?.files == null) return { files: null, reason };
    if (!Array.isArray(params.files) || !params.files.length || params.files.some((file) => typeof file !== 'string' || !file.trim())) {
      throw invalid('files must be a non-empty array of strings');
    }
    const files = params.files.map((file) => file.trim());
    if (files.length > FILES_MAX || files.some((file) => file.length > 300)) throw invalid('files: too many or too long');
    return { files, reason };
  }
  if (action === 'defer_todo') {
    const until = String(params?.until ?? '').trim();
    if (until && !Number.isFinite(Date.parse(until))) throw invalid('until must be an ISO date');
    if (!reason) throw invalid('reason required');
    return { until, reason };
  }
  return { reason };
}

/** Agent-facing creation. Same todo revision + action + params yields one card (dedupeKey). */
export async function createOperatorProposalCard(dataDir, { workspaceFolder, todoId, action, params, title, summary, producer = 'operator' }) {
  const clean = validateOperatorProposal(action, params);
  const todo = await getTodo(dataDir, workspaceFolder, todoId);
  if (!todo) throw invalid('Todo not found');
  const hash = createHash('sha256').update(JSON.stringify([action, clean])).digest('hex').slice(0, 16);
  return createDecision(dataDir, {
    kind: OPERATOR_PROPOSAL_KIND, workspaceFolder, producer, options, recommended: 'approve',
    why: 'Proposed by the operator; applying it is your decision.', allowOther: false, onTimeout: 'nothing',
    subject: { todoId: todo.id, updatedAt: todo.updatedAt, action, params: clean },
    title: String(title || `Operator proposal: ${action} — ${todo.title}`).slice(0, 300),
    summary: String(summary || clean.reason || '').slice(0, 2000),
    evidence: [{ action, params: clean }],
    dedupeKey: `operator_proposal:${workspaceFolder}:${todo.id}:${hash}`,
    harnessChatId: todo.orchestratorChatId || todo.chatId || '',
  });
}

function journal(card, text, dataDir) {
  try {
    addOperatorNote({ workspaceFolder: card.workspaceFolder, clientId: 'decision_card', clientName: 'decision card', sessionId: card.id },
      { kind: 'decision', text: text.slice(0, 2000), todoId: card.subject.todoId }, { dataDir });
  } catch (error) { console.error('[decisions] operator journal write failed:', error?.message || error); }
}

/** Effect of a human decision on an operator_proposal card; compare-and-swap on the todo revision. */
export async function executeOperatorProposal(card, optionId, dataDir) {
  const { todoId, updatedAt, action } = card.subject;
  if (!['approve', 'reject'].includes(optionId)) return { ok: false, reason: 'unknown_option' };
  let params;
  // Unsupported or malformed proposals are terminal: stale, no effect.
  try { params = validateOperatorProposal(action, card.subject.params); } catch { return { ok: false, reason: 'stale' }; }
  const todo = await getTodo(dataDir, card.workspaceFolder, todoId);
  if (!todo || todo.updatedAt !== updatedAt) return { ok: false, reason: 'stale' };
  if (optionId === 'reject') {
    journal(card, `Operator proposal rejected: ${action} on todo ${todoId}${params.reason ? ` (${params.reason})` : ''}`, dataDir);
    return { ok: true, response: { text: '', action, applied: false } };
  }
  const note = (text) => ({ kind: 'note', text: text.slice(0, 1000) });
  try {
    if (action === 'extend_scope') {
      const result = await acceptWorkspaceWatcherScopeRequest({
        dataDir, workspaceFolder: card.workspaceFolder, todoId, files: params.files ?? undefined,
        expectedUpdatedAt: updatedAt, actor: 'owner via operator proposal card',
      });
      if (!result.ok) return { ok: false, reason: 'stale' };
    } else if (action === 'defer_todo') {
      await updateTodo(dataDir, card.workspaceFolder, todoId, {
        status: 'deferred', deferredReason: params.reason, ...(params.until ? { deferredUntil: params.until } : {}),
        expectedUpdatedAt: updatedAt, appendChangelog: note(`Deferred by owner (operator proposal): ${params.reason}`),
      });
    } else {
      // Marks the matter only; integration confirmation stays a human-only integration card.
      await updateTodo(dataDir, card.workspaceFolder, todoId, {
        expectedUpdatedAt: updatedAt, appendChangelog: note(`Marked ready for integration by owner (operator proposal)${params.reason ? `: ${params.reason}` : ''}`),
      });
    }
  } catch (error) {
    if (error?.code === 'CONFLICT') return { ok: false, reason: 'stale' };
    throw error;
  }
  journal(card, `Operator proposal applied: ${action} on todo ${todoId}${params.reason ? ` (${params.reason})` : ''}`, dataDir);
  return { ok: true, response: { text: '', action, applied: true } };
}
