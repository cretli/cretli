/**
 * Writers for the operator run audit (`operator_audit`) and the run's own
 * protocol records (journal notes, report). All writers throw on failure: the
 * gate treats a failed audit write as a denial (fail-closed).
 */

import { addOperatorNote } from '../persist/operator-journal-persist.js';
import { openOperatorStore, withImmediateTx } from './operator-internal-store.js';
import { redactOperatorAuditArgs } from './operator-tool-policy.js';

export const OPERATOR_REPORT_SUMMARY_MAX = 2000;
export const OPERATOR_REPORT_PROPOSALS_MAX = 5;
export const OPERATOR_NOTE_TEXT_MAX = 2000;

const validation = (message) => Object.assign(new Error(message), { code: 'VALIDATION_ERROR' });

/**
 * One audit row per gate decision.
 *
 * @param {{ runId?: string, tool: string, action?: string, outcome: 'allowed' | 'denied', args?: unknown, reason?: string }} entry
 * @param {Record<string, any>} [options] `{ dataDir?, file?, now? }`
 */
export function appendOperatorAudit(entry, options = {}) {
  const db = openOperatorStore(options);
  try {
    const detail = JSON.stringify({ reason: String(entry.reason || '').slice(0, 200), args: redactOperatorAuditArgs(entry.args) });
    db.prepare('INSERT INTO operator_audit(run_id, tool, action, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(entry.runId || ''), String(entry.tool || ''), String(entry.action || ''), entry.outcome, detail, new Date(options.now ?? Date.now()).toISOString());
  } finally {
    db.close();
  }
}

/**
 * Note of a run, stored in the existing operator journal notes with the run id
 * as the author session.
 *
 * @param {{ runId: string, workspaceFolder: string }} run
 * @param {Record<string, any>} input `{ kind, text, todo_id? }`
 * @param {Record<string, any>} [options]
 */
export function addOperatorRunNote(run, input, options = {}) {
  const text = String(input?.text ?? '').trim();
  if (!text || text.length > OPERATOR_NOTE_TEXT_MAX) throw validation(`text must be 1-${OPERATOR_NOTE_TEXT_MAX} characters`);
  const kind = String(input?.kind || 'in_progress');
  if (kind === 'temporary_setting') throw validation('temporary_setting notes are not available to a run');
  return addOperatorNote(
    { workspaceFolder: run.workspaceFolder, clientId: 'operator_run', clientName: 'operator', sessionId: run.runId },
    { kind, text, todoId: input?.todo_id },
    options,
  );
}

/**
 * Records the run report on `operator_runs` and marks it reported. It does not
 * end the run. A second report is rejected.
 *
 * @param {{ runId: string }} run
 * @param {Record<string, any>} input `{ summary, proposals? }`
 * @param {Record<string, any>} [options]
 */
export function recordOperatorRunReport(run, input, options = {}) {
  const summary = String(input?.summary ?? '').trim();
  if (!summary || summary.length > OPERATOR_REPORT_SUMMARY_MAX) throw validation(`summary must be 1-${OPERATOR_REPORT_SUMMARY_MAX} characters`);
  const rawProposals = input?.proposals ?? [];
  if (!Array.isArray(rawProposals) || rawProposals.length > OPERATOR_REPORT_PROPOSALS_MAX) {
    throw validation(`proposals must be an array of at most ${OPERATOR_REPORT_PROPOSALS_MAX} items`);
  }
  const proposals = rawProposals.map((item) => {
    const proposal = item && typeof item === 'object' ? /** @type {Record<string, any>} */ (item) : null;
    const title = String(proposal?.title ?? '').trim();
    const rationale = String(proposal?.rationale ?? '').trim();
    if (!title || title.length > 120) throw validation('proposal title must be 1-120 characters');
    if (!rationale || rationale.length > OPERATOR_REPORT_SUMMARY_MAX) throw validation(`proposal rationale must be 1-${OPERATOR_REPORT_SUMMARY_MAX} characters`);
    return { kind: String(proposal?.kind || 'other').slice(0, 40), todo_id: String(proposal?.todo_id || '').slice(0, 80), title, rationale };
  });
  const db = openOperatorStore(options);
  try {
    return withImmediateTx(db, () => {
      const row = db.prepare('SELECT state, reported_at FROM operator_runs WHERE id = ?').get(run.runId);
      if (!row || row.state !== 'running') throw Object.assign(new Error('operator run is not running'), { code: 'NOT_FOUND' });
      if (row.reported_at) throw Object.assign(new Error('this run already reported'), { code: 'CONFLICT' });
      const at = new Date(options.now ?? Date.now()).toISOString();
      db.prepare('UPDATE operator_runs SET reported_at = ?, report_summary = ?, report_proposals = ? WHERE id = ?')
        .run(at, summary, JSON.stringify(proposals), run.runId);
      return { runId: run.runId, reportedAt: at, proposals: proposals.length };
    });
  } finally {
    db.close();
  }
}
