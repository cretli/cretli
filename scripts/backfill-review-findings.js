#!/usr/bin/env node
/**
 * Seed the review-findings ledger from historical code-review reports.
 *
 * Reads credible terminal code reviews of one workspace from the delegation
 * store, parses their findings and records them with `source: backfill`
 * (always `confidence: low`, so each counts half in lesson distillation).
 *
 * Usage:
 *   node scripts/backfill-review-findings.js --workspace DIR [--apply] [--json]
 *
 * Dry-run is the default and writes nothing. `--apply` is idempotent: a
 * delegation the ledger already knows (live or backfilled) is skipped, so a
 * second run adds nothing and never rewrites live records.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listDelegationsForWorkspace } from '../lib/persist/delegations-persist.js';
import {
  closeReviewFindingsCycle,
  getReviewFindingsLedger,
  recordReviewFindings,
} from '../lib/persist/review-findings-ledger-persist.js';
import { parseReviewFindings } from '../lib/review-findings-parse.js';
import { isCredibleCodeReviewTerminal, resolveEffectiveCodeReviewReportVerdict } from '../lib/delegation-code-review-phase.js';
import { readDelegationWorkflowLeafIdFromRow } from '../lib/delegation-workflow-leaf.js';

const USAGE = 'Usage: node scripts/backfill-review-findings.js --workspace DIR [--apply] [--json]\n';

/** @param {object} row @returns {number} */
function finishedMs(row) {
  const at = Date.parse(String(row?.finishedAt || row?.updatedAt || row?.createdAt || ''));
  return Number.isFinite(at) ? at : 0;
}

/**
 * @param {{ workspaceFolder: string, apply?: boolean }} input
 * @returns {{ apply: boolean, leaves: number, reviews: number, recorded: number, skipped: number, findings: number }}
 */
export function runReviewFindingsBackfill(input) {
  const workspaceFolder = path.resolve(String(input?.workspaceFolder || ''));
  const apply = input?.apply === true;
  const reviews = listDelegationsForWorkspace(workspaceFolder)
    .filter((row) => String(row.assignment || '').trim() === 'review'
      && String(row.reviewSubject || '').trim() === 'code'
      && isCredibleCodeReviewTerminal(row)
      && readDelegationWorkflowLeafIdFromRow(row))
    .sort((a, b) => finishedMs(a) - finishedMs(b));
  const report = { apply, leaves: 0, reviews: reviews.length, recorded: 0, skipped: 0, findings: 0 };
  const leaves = new Map();
  for (const row of reviews) {
    const leafId = readDelegationWorkflowLeafIdFromRow(row).toLowerCase();
    leaves.set(leafId, [...(leaves.get(leafId) || []), row]);
  }
  report.leaves = leaves.size;
  for (const [leafId, rows] of leaves) {
    for (const row of rows) {
      const known = getReviewFindingsLedger(workspaceFolder, leafId)?.delegations?.[row.id];
      const parsed = parseReviewFindings(row.report);
      if (known || !parsed.findings.length) {
        report.skipped += 1;
        continue;
      }
      report.recorded += 1;
      report.findings += parsed.findings.length;
      if (!apply) continue;
      recordReviewFindings({
        workspaceFolder,
        leafId,
        delegationId: row.id,
        attemptId: row.attemptId,
        mode: row.reviewMode,
        findings: parsed.findings,
        source: 'backfill',
      });
    }
    // A leaf whose latest review passed is finished history: close its cycle (idempotent per round id).
    const last = rows[rows.length - 1];
    const ledger = apply ? getReviewFindingsLedger(workspaceFolder, leafId) : null;
    if (ledger && ledger.lastClosedRoundId !== last.id && ledger.delegations?.[last.id]
      && String(resolveEffectiveCodeReviewReportVerdict(last)).toUpperCase() === 'PASS') {
      closeReviewFindingsCycle({ workspaceFolder, leafId, roundId: last.id, memberIds: rows.map((row) => row.id) });
    }
  }
  return report;
}

/** @param {string[]} argv @returns {{ workspace: string, apply: boolean, json: boolean, help: boolean }} */
function parseArgs(argv) {
  const options = { workspace: '', apply: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' || arg === '-w') options.workspace = argv[++i] || '';
    else if (arg.startsWith('--workspace=')) options.workspace = arg.slice('--workspace='.length);
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else options.help = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.workspace) {
    process.stderr.write(USAGE);
    process.exit(options.help && options.workspace ? 2 : 1);
  }
  const report = runReviewFindingsBackfill({ workspaceFolder: options.workspace, apply: options.apply });
  process.stdout.write(options.json
    ? `${JSON.stringify(report)}\n`
    : `${report.apply ? 'Applied' : 'Dry run'}: ${report.reviews} reviews in ${report.leaves} leaves, `
      + `${report.recorded} to record (${report.findings} findings), ${report.skipped} skipped.\n`);
}
