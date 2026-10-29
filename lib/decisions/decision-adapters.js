import { listTodos, getTodo, updateTodo } from '../persist/todos-store.js';
import { summarizeTodoIntegration } from '../todo-integration-read.js';
import { approveTodoPlanFromDecision } from './todo-plan-approval.js';
import {
  confirmWorkspaceTodoIntegration, markTodoIntegrationNoCode, rejectWorkspaceTodoIntegration,
} from '../workspace-watcher-integration.js';
import { createDecision, changeDecision, listDecisions, listPendingDecisions } from './decision-store.js';

const planOptions = [
  { id: 'approve', label: 'Approve plan', effect: 'Approve this plan for execution' },
  { id: 'reject', label: 'Reject plan', effect: 'Request a revised plan' },
];
const integrationOptions = [
  { id: 'confirm', label: 'Confirm integration', effect: 'Attest to the verified code change' },
  { id: 'reject', label: 'Reject integration', effect: 'Return this todo for a retry' },
  { id: 'no_code', label: 'No code changes', effect: 'Confirm that no code change is needed' },
];
function eligible(row, kind) {
  if (!row) return false;
  if (kind === 'plan_approval') return Boolean(row.plan?.markdown && !row.plan?.approvedAt);
  if (kind === 'integration') return summarizeTodoIntegration(row).state === 'awaiting';
  return true;
}
export async function syncDecisionCards(dataDir, workspaceFolder) {
  const todos = (await listTodos(dataDir, workspaceFolder)).items;
  const byId = new Map(todos.map((row) => [row.id, row]));
  for (const card of (await listPendingDecisions(dataDir, workspaceFolder)).items) {
    if (!card.subject.todoId) continue;
    const row = byId.get(card.subject.todoId);
    if (!row || row.updatedAt !== card.subject.updatedAt || !eligible(row, card.kind)) {
      await changeDecision(dataDir, card.id, card.revision, 'stale');
    }
  }
  // A `deciding` card is never reset here: its owner may be another request or process mid-effect.
  // Only the explicit, human-only reopen route (lib/routes/decisions-routes.js) releases a stranded claim.
  const priorDecisions = await listDecisions(dataDir, workspaceFolder);
  for (const row of todos) {
    const common = {
      subject: { todoId: row.id, updatedAt: row.updatedAt }, workspaceFolder,
      summary: String(row.title || ''), evidence: [], producer: 'todo-adapter', onTimeout: 'nothing',
    };
    const planRevision = row.plan?.markdownUpdatedAt || row.plan?.updatedAt;
    const planRejected = priorDecisions.some((card) => card.kind === 'plan_approval'
      && card.subject.todoId === row.id && card.subject.planRevision === planRevision
      && card.status === 'decided' && card.optionId === 'reject');
    if (eligible(row, 'plan_approval') && !planRejected) await createDecision(dataDir, {
      ...common, subject: { ...common.subject, planRevision }, kind: 'plan_approval', title: `Approve plan: ${row.title}`,
      dedupeKey: `plan:${workspaceFolder}:${row.id}`, options: planOptions, recommended: 'approve',
    });
    if (eligible(row, 'integration')) await createDecision(dataDir, {
      ...common, kind: 'integration', title: `Integrate: ${row.title}`,
      dedupeKey: `integration:${workspaceFolder}:${row.id}`, options: integrationOptions, recommended: 'confirm',
      evidence: [summarizeTodoIntegration(row)],
    });
  }
  return listPendingDecisions(dataDir, workspaceFolder);
}
export async function executeDecision(card, optionId, dataDir, reason = '') {
  const { workspaceFolder, subject } = card;
  const row = await getTodo(dataDir, workspaceFolder, subject.todoId);
  if (!row || row.updatedAt !== subject.updatedAt || !eligible(row, card.kind)) return { ok: false, reason: 'stale' };
  if (card.kind === 'plan_approval') {
    if (optionId === 'approve') {
      await approveTodoPlanFromDecision({ dataDir, workspaceFolder, todo: row });
    } else if (optionId === 'reject') {
      await updateTodo(dataDir, workspaceFolder, row.id, {
        appendChangelog: { kind: 'note', text: String(reason || 'Plan rejected; revision requested.').slice(0, 1000) },
        expectedUpdatedAt: subject.updatedAt,
      });
    }
    return { ok: true };
  }
  if (card.kind === 'integration') {
    const input = { dataDir, workspaceFolder, todoId: row.id, expectedUpdatedAt: subject.updatedAt };
    if (optionId === 'confirm') return confirmWorkspaceTodoIntegration(/** @type {any} */ ({ ...input, humanAttested: true, proof: { simple: true } }));
    if (optionId === 'no_code') return markTodoIntegrationNoCode({ ...input, humanAttested: true, reason: 'No code changes required.' });
    if (optionId === 'reject') return rejectWorkspaceTodoIntegration({ ...input, reason: 'Integration rejected by the operator.' });
  }
  return { ok: false, reason: 'unsupported_kind' };
}
