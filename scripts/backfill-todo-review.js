#!/usr/bin/env node
/**
 * Backfill the server-owned `todo.review` snapshot for leaves that predate the
 * review field (`docs/todo-review-contract.md` §11, §16).
 *
 * The decision is made by the production code path, not by a copy of it:
 * `lib/todo-review-backfill.js` recomputes each leaf with
 * `computeTodoReviewSnapshotForTodo` (`lib/todo-review-sync.js`) over jobs read
 * through `listDelegationsForWorkspace`, and writes through `writeTodoReview`
 * (workspace lock + `generation` + `decisionKey`). It never reads `data/` files
 * to decide anything, never touches `status`, the changelog or the sibling
 * order, and never bumps `item.updatedAt` (the agent CAS token).
 *
 * Honest-history rules it enforces:
 * - verdicts come from the durable `reportVerdict`, so a report that retention
 *   cut at 2000 characters still counts; a job with no durable verdict is
 *   `unknown`, never `passed`;
 * - attribution comes only from the record `leafId`, so an archived job whose
 *   attribution lived in `sourceText` is unattributable;
 * - a job without a declared subject is `other`, so it can never yield
 *   `code: passed`;
 * - a leaf with no attributable review is `none` only when the retained history
 *   is complete; with evidence of loss it is `unknown` / `history_truncated`;
 * - a stored subject that already carries evidence is never overwritten by a
 *   result computed from a poorer history.
 *
 * Usage:
 *   node scripts/backfill-todo-review.js --workspace DIR [--data-dir DIR]
 *     [--dry-run | --apply] [--checkpoint PATH] [--restart] [--json]
 *
 * `--dry-run` is the default and writes nothing at all, not even a checkpoint.
 * `--apply` exports a logical snapshot of the workspace todos (a JSON document
 * `{ kind, version, workspaceFolder, takenAt, document }`, independent of the
 * storage backend) to
 * `<data-dir>/backups/todo-review-backfill/<workspace-key>.<stamp>.json` before
 * its first write; that export is the rollback point.
 *
 * Rollback (`todo.review` is derived data, so it is re-derived, never restored
 * from a storage file):
 *   1. read `document.items[].review` in the snapshot for the pre-run values;
 *   2. restart the server — the boot repair (`lib/todo-review-sync-hooks.js`)
 *      re-derives the snapshots from the delegation records again.
 *
 * Processing is checkpointed: an interrupted `--apply` resumes with the leaves
 * it already committed, and a leaf that failed to write stays pending. A
 * completed pass removes the checkpoint. Re-running is always safe.
 */

import {
  formatTodoReviewBackfillReport,
  runTodoReviewBackfill,
} from '../lib/todo-review-backfill.js';
import { resolveDataPath } from '../lib/runtime-paths.js';

const USAGE = 'Usage: node scripts/backfill-todo-review.js --workspace DIR'
  + ' [--data-dir DIR] [--dry-run | --apply] [--checkpoint PATH] [--restart] [--json]\n';

/**
 * @param {string[]} argv
 * @returns {{ workspace: string, dataDir: string, apply: boolean, checkpoint: string, restart: boolean, json: boolean, help: boolean, unknown: string[] }}
 */
function parseArgs(argv) {
  const options = {
    workspace: '',
    dataDir: '',
    apply: false,
    checkpoint: '',
    restart: false,
    json: false,
    help: false,
    unknown: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--workspace' || arg === '-w') {
      index += 1;
      options.workspace = argv[index] || '';
    } else if (arg.startsWith('--workspace=')) {
      options.workspace = arg.slice('--workspace='.length);
    } else if (arg === '--data-dir') {
      index += 1;
      options.dataDir = argv[index] || '';
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length);
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--checkpoint') {
      index += 1;
      options.checkpoint = argv[index] || '';
    } else if (arg.startsWith('--checkpoint=')) {
      options.checkpoint = arg.slice('--checkpoint='.length);
    } else if (arg === '--restart') {
      options.restart = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      options.unknown.push(arg);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(`${USAGE}\n`
    + '\n'
    + 'Rebuild todo.review from retained delegation history for leaves that predate\n'
    + 'the field. Dry-run by default: prints the per-subject state matrix and what\n'
    + '--apply would write, and changes nothing.\n'
    + '\n'
    + '  --workspace DIR   logical workspace folder (required, never the runner cwd)\n'
    + '  --data-dir DIR    runtime data directory (default: the server data dir)\n'
    + '  --apply           write the snapshots; exports a logical todos snapshot first\n'
    + '  --checkpoint PATH resume file (default: <data-dir>/backfill/todo-review.checkpoint.json)\n'
    + '  --restart         ignore an existing checkpoint and scan every leaf again\n'
    + '  --json            machine-readable result instead of the report\n'
    + '\n'
    + 'Rollback: the logical snapshot in <data-dir>/backups/todo-review-backfill/\n'
    + 'lists the pre-run todo.review values; restart the server so the boot repair\n'
    + 're-derives the snapshots.\n');
  process.exit(0);
}

if (options.unknown.length > 0) {
  process.stderr.write(`backfill-todo-review: unknown argument ${options.unknown[0]}\n${USAGE}`);
  process.exit(2);
}

if (!options.workspace) {
  process.stderr.write(`backfill-todo-review: --workspace DIR is required\n${USAGE}`);
  process.exit(2);
}

let result;
try {
  result = await runTodoReviewBackfill({
    workspaceFolder: options.workspace,
    dataDir: options.dataDir || resolveDataPath(),
    apply: options.apply,
    checkpointPath: options.checkpoint || undefined,
    restart: options.restart,
  });
} catch (error) {
  process.stderr.write(`backfill-todo-review: ${error?.message || error}\n`);
  process.exit(2);
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(formatTodoReviewBackfillReport(result));
}

process.exit(result.summary?.failed > 0 ? 1 : 0);
