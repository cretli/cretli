#!/usr/bin/env node
/**
 * Preview (default) or apply the Workspace Watcher restart-history repair.
 *
 *   node scripts/workspace-watcher-history-repair.js --restart-at <iso> [--restart-at <iso> ...] [--grace-minutes <n>] [--workspace <dir>] [--data-dir <dir>]
 *   node scripts/workspace-watcher-history-repair.js ... --apply --revision <n> --updated-at <iso> --preview-id <id>
 *
 * A cycle is a restart artefact only if it started before a --restart-at
 * instant and was closed at or after it, within the grace (default 30 min, max
 * 360). Without --apply nothing is written. Apply needs the CAS token printed by the
 * preview and aborts when the store changed since. Run it by hand, never from
 * the server. Exit codes: 0 ok, 1 refused/stale, 2 applied but a todo blocker
 * update hit a CAS miss (rerun preview + apply to finish it).
 */
import { applyWorkspaceWatcherHistoryRepair, previewWorkspaceWatcherHistoryRepair } from '../lib/workspace-watcher-history-repair.js';

const args = process.argv.slice(2);
/**
 * @param {string} name
 * @returns {string}
 */
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args[i + 1] ?? '') : '';
}
const restartAt = args.flatMap((a, i) => (a === '--restart-at' ? [String(args[i + 1] ?? '')] : []));
const graceMinutes = Number(arg('grace-minutes'));
const base = { dataDir: arg('data-dir') || undefined, restartAt, graceMs: Number.isFinite(graceMinutes) && graceMinutes > 0 ? graceMinutes * 60_000 : undefined, workspaceFolder: arg('workspace') || undefined };
if (!args.includes('--apply')) {
  console.log(JSON.stringify(previewWorkspaceWatcherHistoryRepair(base), null, 2));
} else {
  const result = applyWorkspaceWatcherHistoryRepair({
    ...base,
    apply: true,
    casToken: { revision: Number(arg('revision')), updatedAt: arg('updated-at') },
    previewId: arg('preview-id'),
    actor: arg('actor') || 'cli',
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
  // Exit 2: the row was repaired but a todo blocker update missed its CAS; rerun preview+apply.
  if (result.todoUpdates.some((u) => u.status === 'cas_miss')) process.exit(2);
}
