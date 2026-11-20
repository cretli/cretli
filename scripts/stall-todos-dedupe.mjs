#!/usr/bin/env node
/**
 * One-off migration: merge duplicate "Event-loop stall: ..." todos.
 *
 *   node scripts/stall-todos-dedupe.mjs --data-dir <dir> [--repo-root <dir>] [--apply]
 *
 * Dry-run is the default: the plan is printed and nothing is written. Nothing is
 * ever deleted: duplicates move to `deferred`, link to the primary todo through
 * `sourceTodoId` and carry a `stall-merged-into: <id>` body line (which also
 * makes the watchdog skip them). The primary todo absorbs the combined
 * occurrence count, max delay and last-seen time. Re-running is idempotent.
 * --data-dir is required on purpose so the script never touches live data by accident.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStallTitle, isMergedDuplicate, lastSeenOf } from '../lib/server-health/server-stall-watchdog.js';

const MERGEABLE = new Set(['idea', 'ready', 'deferred']);
const RANK = { doing: 0, ready: 1, idea: 2, deferred: 3 };

function numField(body, name) {
  return Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(body)?.[1]) || 0;
}

function maxMsOf(todo) {
  const body = String(todo.body || '');
  return Math.max(numField(body, 'stall-max-ms'), Number(/unresponsive for: (\d+) ms/.exec(body)?.[1]) || 0);
}

function setField(body, name, value) {
  const re = new RegExp(`^${name}: .*$`, 'm');
  return re.test(body) ? body.replace(re, () => `${name}: ${value}`) : `${body.replace(/\s+$/, '')}\n${name}: ${value}\n`;
}

/**
 * Pure planner. Groups open stall todos by title (function + file) and picks one
 * primary per group; `doing` > `ready` > `idea` > `deferred`, then the oldest.
 * @param {Array<any>} items
 */
export function planStallDedupe(items) {
  const groups = new Map();
  for (const todo of items) {
    if (!isStallTitle(todo.title) || isMergedDuplicate(todo)) continue;
    if (!MERGEABLE.has(todo.status) && todo.status !== 'doing') continue;
    if (!groups.has(todo.title)) groups.set(todo.title, []);
    groups.get(todo.title).push(todo);
  }
  const plan = [];
  for (const [title, rows] of groups) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => (RANK[a.status] - RANK[b.status])
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const [primary, ...rest] = rows;
    // A `doing` duplicate is in someone's hands: leave it alone.
    const duplicates = rest.filter((todo) => MERGEABLE.has(todo.status));
    if (!duplicates.length) continue;
    const seen = [primary, ...duplicates].map(lastSeenOf).filter((v) => v != null);
    plan.push({
      title,
      primaryId: primary.id,
      duplicateIds: duplicates.map((d) => d.id),
      occurrences: [primary, ...duplicates].reduce((sum, t) => sum + (numField(String(t.body || ''), 'stall-occurrences') || 1), 0),
      maxMs: Math.max(0, ...[primary, ...duplicates].map(maxMsOf)),
      lastSeen: seen.length ? new Date(Math.max(...seen)).toISOString() : null,
      primary,
      duplicates,
    });
  }
  return plan;
}

/** Human-readable summary without the todo rows. */
export function summarizePlan(plan, totalStallTodos) {
  return {
    stallTodos: totalStallTodos,
    groupsWithDuplicates: plan.length,
    duplicatesToDefer: plan.reduce((n, g) => n + g.duplicateIds.length, 0),
    groups: plan.map(({ title, primaryId, duplicateIds, occurrences, maxMs, lastSeen }) => ({
      title, primaryId, duplicateIds, occurrences, maxMs, lastSeen,
    })),
  };
}

/** Write the plan through an injected updateTodo. Duplicates first, so a crash never loses the link. */
export async function applyStallDedupe(plan, { dataDir, repoRoot, updateTodo }) {
  for (const group of plan) {
    for (const dup of group.duplicates) {
      await updateTodo(dataDir, repoRoot, dup.id, {
        body: `${String(dup.body || '').replace(/\s+$/, '')}\nstall-merged-into: ${group.primaryId}\n`,
        status: 'deferred',
        deferredReason: `Duplicate of stall todo ${group.primaryId} (merged by stall-todos-dedupe)`,
        sourceTodoId: group.primaryId,
        expectedUpdatedAt: dup.updatedAt,
        appendChangelog: { kind: 'note', text: `Merged into ${group.primaryId}; no deletion.` },
      });
    }
    let body = String(group.primary.body || '');
    body = setField(body, 'stall-occurrences', group.occurrences);
    body = setField(body, 'stall-max-ms', group.maxMs);
    if (group.lastSeen) body = setField(body, 'stall-last-seen', group.lastSeen);
    await updateTodo(dataDir, repoRoot, group.primaryId, {
      body,
      expectedUpdatedAt: group.primary.updatedAt,
      appendChangelog: { kind: 'note', text: `Absorbed ${group.duplicateIds.length} duplicate stall todos: ${group.duplicateIds.join(', ')}.` },
    });
  }
}

function parseArgs(argv) {
  const args = { apply: false, dataDir: '', repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--dry-run') args.apply = false;
    else if (argv[i] === '--data-dir') args.dataDir = path.resolve(argv[++i] || '');
    else if (argv[i] === '--repo-root') args.repoRoot = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.dataDir) throw new Error('--data-dir is required');
  return args;
}

async function main() {
  const { apply, dataDir, repoRoot } = parseArgs(process.argv.slice(2));
  const { listTodos, updateTodo } = await import('../lib/persist/todos-store.js');
  const { items } = await listTodos(dataDir, repoRoot);
  const plan = planStallDedupe(items);
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summarizePlan(plan, items.filter((t) => isStallTitle(t.title)).length) }, null, 2));
  if (!apply) {
    console.log('Dry-run: nothing written. Re-run with --apply to write.');
    return;
  }
  await applyStallDedupe(plan, { dataDir, repoRoot, updateTodo });
  console.log('Applied.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
