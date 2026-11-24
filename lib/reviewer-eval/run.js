/**
 * Reviewer-eval run planning and execution. The model is started only through
 * the injected `client.startDelegation` (the existing delegation path, a
 * read-only code review); `dryRun` never calls it.
 */

import { scoreCase } from './score.js';

/**
 * @param {Record<string, any>} testCase
 * @returns {string}
 */
export function buildEvalTaskText(testCase) {
  return [
    'Code review of the change below (evaluation run; read-only, do not edit files).',
    'Report every defect you find with file:line in the findings block.',
    '',
    '```diff',
    String(testCase.diff || ''),
    '```',
  ].join('\n');
}

/**
 * @param {{ cases: Array<Record<string, any>>, harness: string, model: string }} input
 * @returns {Array<{ caseId: string, harness: string, model: string }>}
 */
export function planRuns({ cases, harness, model }) {
  return cases.filter((c) => c.accepted === true).map((c) => ({ caseId: c.id, harness, model }));
}

/** A refusal that must abort the whole run (not a per-case infra failure). */
export class EvalRefusal extends Error {}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/**
 * @param {any} err
 * @returns {boolean}
 */
function isOutOfScope(err) {
  return err?.code === 'OUT_OF_SCOPE' || err?.body?.code === 'OUT_OF_SCOPE' || err?.status === 403;
}

/**
 * @param {{
 *   cases: Array<Record<string, any>>, harness: string, model: string, dryRun?: boolean,
 *   client?: { startDelegation: Function, getDelegation: Function },
 *   chatId?: string, workspaceFolder?: string, pollMs?: number, timeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   prepareCheckout?: (testCase: Record<string, any>) => { folder: string, cleanup: () => void },
 * }} input
 * @returns {Promise<{ dryRun: boolean, plan: ReturnType<typeof planRuns>, results: Array<Record<string, any>> }>}
 */
export async function runEval(input) {
  const plan = planRuns(input);
  if (input.dryRun) return { dryRun: true, plan, results: [] };
  if (!input.client || !input.chatId) throw new Error('run needs a client and a parent chat id');
  const sleep = input.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const byId = new Map(input.cases.map((c) => [c.id, c]));
  const results = [];
  for (const step of plan) {
    const testCase = /** @type {Record<string, any>} */ (byId.get(step.caseId));
    const base = { caseId: step.caseId, harness: input.harness, model: input.model };
    /** @param {string} reason */
    const infra = (reason) => results.push({ ...base, delegationId: '', infra: { reason } });
    let checkout = null;
    try {
      if (input.prepareCheckout) {
        try {
          checkout = input.prepareCheckout(testCase);
        } catch (err) {
          infra(`checkout-failed: ${String(/** @type {any} */ (err)?.message || err).slice(0, 200)}`);
          continue;
        }
      }
      let started;
      try {
        started = await input.client.startDelegation({
          chatId: input.chatId,
          workspaceFolder: checkout?.folder || input.workspaceFolder,
          harness: input.harness,
          model: input.model,
          assignment: 'review',
          reviewSubject: 'code',
          taskText: buildEvalTaskText(testCase),
          idempotencyKey: `reviewer-eval-${step.caseId}-${input.harness}-${input.model}-${Date.now()}`,
          manualSource: 'operator',
        });
      } catch (err) {
        if (checkout && isOutOfScope(err)) {
          throw new EvalRefusal('The server refused the pre-fix checkout as a workspace for this chat (OUT_OF_SCOPE). Run the eval from a chat that belongs to a checkout of the pre-fix commit, or see docs/review-lessons.md.');
        }
        infra(`start-failed: ${String(/** @type {any} */ (err)?.message || err).slice(0, 200)}`);
        continue;
      }
      const id = started?.delegation?.id || started?.id;
      if (!id) {
        infra('start-failed: no delegation id');
        continue;
      }
      let row = null;
      const deadline = Date.now() + (input.timeoutMs ?? 1_800_000);
      while (Date.now() < deadline) {
        row = await input.client.getDelegation({ delegationId: id, workspaceFolder: checkout?.folder || input.workspaceFolder });
        if (row && TERMINAL.has(String(row.status))) break;
        row = null;
        await sleep(input.pollMs ?? 5000);
      }
      const report = String(row?.report || '').trim();
      if (!row) infra('timeout');
      else if (row.status !== 'completed') results.push({ ...base, delegationId: id, infra: { reason: String(row.status) } });
      else if (!report) results.push({ ...base, delegationId: id, infra: { reason: 'empty-report' } });
      else results.push({ ...base, delegationId: id, scores: scoreCase(/** @type {any} */ (testCase), { report }) });
    } finally {
      checkout?.cleanup();
    }
  }
  return { dryRun: false, plan, results };
}
