/**
 * Rendered prompt previews for Settings. Each entry renders a real prompt
 * builder with a fixed sample input so the user sees the effect of block
 * overrides, together with its size against the length budget.
 */
import { buildWorkspaceWatcherCyclePromptPlan } from '../workspace-watcher-prompt.js';
import { buildTodoExecutionWorkflow } from '../todo-execution-prompt.js';
import { buildDelegationExecutorPrompt } from '../delegation-prompt.js';
import { buildBatchWrapperPrompt } from '../integrate-batch.js';

/** Soft length budget (characters) above which a rendered prompt is flagged. */
export const PROMPT_BUDGET_CHARS = 24000;

const SAMPLE_CYCLE = Object.freeze({
  workspaceFolder: '/my-app',
  watcher: { policy: {} },
  decision: {},
  todo: { id: '11111111-2222-3333-4444-555555555555', title: 'Sample task' },
  orchestrator: { harness: 'claude', model: 'sample-model', source: 'preview' },
  cycleId: 'preview-cycle',
});

/**
 * @param {number} [budget]
 * @returns {Array<{ id: string, text: string, chars: number, budget: number, overBudget: boolean }>}
 */
export function renderPromptPreviews(budget = PROMPT_BUDGET_CHARS) {
  const delegation = buildDelegationExecutorPrompt({ sourceKind: 'text', taskText: 'Sample task', executionMode: 'agent', assignment: 'implement' });
  const batch = { id: 'preview', epoch: 1, workspaceFolder: '/my-app', baseUrl: 'https://your-pc:3011', entries: [{ mode: 'verify', title: 'Sample', todoId: 'sample' }] };
  const rows = [
    ['watcher', buildWorkspaceWatcherCyclePromptPlan({ ...SAMPLE_CYCLE }).prompt],
    ['todoExecution', buildTodoExecutionWorkflow()],
    ['delegationExecutor', delegation.ok ? delegation.prompt : ''],
    ['bulkIntegrate', buildBatchWrapperPrompt(batch, 'preview-secret')],
  ];
  return rows.map(([id, text]) => ({ id, text, chars: text.length, budget, overBudget: text.length > budget }));
}
