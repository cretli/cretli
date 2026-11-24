/**
 * Workspace Watcher — deterministic triage queue (no LLM).
 *
 * Detects todos/trees that look stuck and keeps them as a durable queue of
 * triage candidates on the watcher row (`triageQueue`, versioned format). The
 * queue is information only: nothing here starts an agent, claims a todo or
 * changes todo state, and the autopilot tick never reads it. Modes `off` and
 * `observe` are unaffected.
 *
 * Every candidate carries evidence and an age. Entries are deduplicated by
 * (todo, signal, todo revision): when the todo revision changes the old entry
 * is dropped and, if the signal still holds, a fresh entry starts with a new
 * `firstSeenAt`. An entry also disappears as soon as its signal clears.
 * Thresholds live in `policy.triage` (see `normalizeTriageThresholds`).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachTodoIntegrationReadModels } from './todo-integration-read.js';
import {
  TRIAGE_MAX_BASE_PROBES,
  TRIAGE_QUEUE_MAX_ENTRIES,
  TRIAGE_QUEUE_VERSION,
  normalizeTriageQueue,
  normalizeTriageThresholds,
} from './workspace-watcher-triage-config.js';
import { collectWorktreeExecutionDiffAsync, runGitAsync } from './worktree/git-worktree.ts';
import {
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
} from './persist/workspace-watchers-persist.js';

/** @typedef {import('./workspace-watcher-triage-config.js').TriageEntry} TriageEntry */

/** @param {unknown} v */
const text = (v) => String(v ?? '').trim();
/** @param {unknown} v */
const ms = (v) => { const t = Date.parse(text(v)); return Number.isFinite(t) ? t : NaN; };

/**
 * Candidate before it gets a `firstSeenAt`.
 * @param {string} todoId @param {string} signal @param {string} revision @param {string} since @param {Record<string, any>} evidence
 */
function candidate(todoId, signal, revision, since, evidence) {
  return { key: `${todoId}|${signal}|${revision}`, todoId, signal, revision, since, evidence };
}

/**
 * Compute the currently firing signals. Pure: all inputs are passed in.
 *
 * @param {{
 *   items: Record<string, any>[],
 *   now?: number,
 *   thresholds?: unknown,
 *   reports?: Record<string, any>[],
 *   baseProbes?: Record<string, { behind?: number|null, applies?: boolean|null, head?: string }>,
 *   worktreeRecords?: Record<string, any>[],
 * }} input
 */
export function computeTriageSignals(input) {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const th = normalizeTriageThresholds(input.thresholds);
  const items = attachTodoIntegrationReadModels(Array.isArray(input.items) ? input.items : []);
  const byId = new Map(items.map((item) => [text(item.id), item]));
  /** @type {Map<string, Record<string, any>[]>} */
  const children = new Map();
  for (const item of items) {
    const parent = text(item.parentId);
    if (!parent) continue;
    children.set(parent, [...(children.get(parent) || []), item]);
  }
  /** Subtree nodes (including the root), cycle-safe. @param {Record<string, any>} root */
  const subtree = (root) => {
    const seen = new Set();
    const out = [];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const id = text(node?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(node);
      stack.push(...(children.get(id) || []));
    }
    return out;
  };
  const leavesOf = (/** @type {Record<string, any>} */ root) => subtree(root).filter((n) => !(children.get(text(n.id)) || []).length);
  const maxUpdated = (/** @type {Record<string, any>[]} */ nodes) => nodes.reduce((best, n) => {
    const t = ms(n.updatedAt);
    return Number.isFinite(t) && t > best.t ? { t, at: text(n.updatedAt) } : best;
  }, { t: -Infinity, at: '' });
  const ancestorApproved = (/** @type {Record<string, any>} */ item) => {
    const seen = new Set();
    for (let node = item; node && !seen.has(text(node.id)); node = byId.get(text(node.parentId))) {
      seen.add(text(node.id));
      if (text(node.plan?.approvedAt)) return true;
    }
    return false;
  };
  const out = [];
  const older = (/** @type {string} */ at, /** @type {number} */ threshold) => {
    const t = ms(at);
    return Number.isFinite(t) && now - t > threshold;
  };

  for (const item of items) {
    const id = text(item.id);
    if (!id) continue;
    const status = text(item.status);
    const revision = text(item.updatedAt);
    const kids = children.get(id) || [];
    const isLeaf = kids.length === 0;

    // 1. A `doing` tree whose newest node update is older than the threshold.
    if (status === 'doing' && !isLeaf && !byId.has(text(item.parentId))) {
      const latest = maxUpdated(subtree(item));
      if (latest.at && older(latest.at, th.staleDoingTreeMs)) {
        // The revision is the root's own; descendant activity is evidence only.
        out.push(candidate(id, 'stale_doing_tree', revision, latest.at, { lastActivityAt: latest.at, nodes: subtree(item).length }));
      }
    }

    // 2a. Every leaf is done but the (shared-worktree) tree root is not integrated.
    const worktreeRoot = text(item.executionMode) === 'worktree'
      || (input.worktreeRecords || []).some((r) => text(r.todoId) === id);
    // A `done` root that was never integrated still counts: only integration evidence clears it.
    if (!isLeaf && worktreeRoot && item.integrationSummary?.state !== 'integrated') {
      const leaves = leavesOf(item);
      if (leaves.length && leaves.every((l) => text(l.status) === 'done')) {
        const latest = maxUpdated(leaves);
        if (latest.at && older(latest.at, th.doneUnintegratedMs)) {
          out.push(candidate(id, 'tree_done_unintegrated', revision, latest.at, { leaves: leaves.length, integration: item.integrationSummary?.state || 'unconfirmed', lastLeafDoneAt: latest.at }));
        }
      }
    }
    // 2b. A done leaf that went through integration but is still unconfirmed.
    if (isLeaf && status === 'done' && (item.integration || text(item.executionMode) === 'worktree')
      && item.integrationSummary?.state !== 'integrated' && item.integrationSummary?.detail !== 'no_code_changes'
      && older(revision, th.doneUnintegratedMs)) {
      out.push(candidate(id, 'leaf_done_unconfirmed', revision, revision, { integration: item.integrationSummary?.state || 'unconfirmed', detail: item.integrationSummary?.detail || '' }));
    }

    // 4. Plan draft without a review / passed plan review without approval.
    const plan = item.plan && typeof item.plan === 'object' ? item.plan : null;
    if (plan && text(plan.markdown) && status !== 'done' && !ancestorApproved(item)) {
      const reviewState = text(item.review?.plan?.state) || 'none';
      if (reviewState === 'none') {
        const since = text(plan.markdownUpdatedAt) || text(plan.updatedAt);
        if (older(since, th.planUnreviewedMs)) out.push(candidate(id, 'plan_draft_unreviewed', revision, since, { planUpdatedAt: since }));
      } else if (reviewState === 'passed') {
        const since = text(item.review?.plan?.updatedAt) || text(plan.updatedAt);
        if (older(since, th.planUnapprovedMs)) out.push(candidate(id, 'plan_review_unapproved', revision, since, { reviewPassedAt: since }));
      }
    }

    // 6b. Worktree-backed leaf waiting for a human to integrate it.
    if (isLeaf && text(item.integration?.state) === 'ready' && older(revision, th.integrationReadyMs)) {
      out.push(candidate(id, 'integration_ready_idle', revision, revision, { lastActionAt: revision }));
    }
  }

  // 6a. Leaves parked by a blocked cycle report (needs_human / needs_rescope).
  const reports = Array.isArray(input.reports) ? input.reports : [];
  const latestByTodo = new Map();
  for (const report of reports) {
    for (const todoId of Array.isArray(report?.todoIds) ? report.todoIds : []) {
      const prev = latestByTodo.get(todoId);
      if (!prev || ms(report.at) >= ms(prev.at)) latestByTodo.set(todoId, report);
    }
  }
  for (const [todoId, report] of latestByTodo) {
    const code = text(report.reasonCode);
    const item = byId.get(todoId);
    if (!item || !['needs_human', 'needs_rescope'].includes(code) || text(report.outcome) !== 'blocked') continue;
    // A resolved leaf loses `blockedReason` (any status change clears it).
    if (text(item.status) === 'done' || !text(item.blockedReason)) continue;
    if (older(report.at, th.needsHumanMs)) {
      out.push(candidate(todoId, code === 'needs_human' ? 'leaf_needs_human' : 'leaf_needs_rescope', text(item.updatedAt), text(report.at),
        { reportedAt: text(report.at), reason: text(item.blockedReason).slice(0, 200) }));
    }
  }

  // 3. Worktree base behind HEAD by more than K commits, or patch no longer applies.
  for (const record of input.worktreeRecords || []) {
    const todoId = text(record.todoId);
    const item = byId.get(todoId);
    const probe = input.baseProbes?.[todoId];
    if (!item || !probe || ['done'].includes(text(item.status))) continue;
    const revision = text(item.updatedAt);
    const since = text(record.updatedAt) || text(record.createdAt) || revision;
    if (Number.isFinite(probe.behind) && /** @type {number} */ (probe.behind) > th.baseBehindCommits) {
      out.push(candidate(todoId, 'worktree_base_behind', revision, since, { behind: probe.behind, threshold: th.baseBehindCommits, baseCommit: text(record.baseCommit), head: probe.head || '' }));
    }
    if (probe.applies === false) {
      out.push(candidate(todoId, 'worktree_patch_conflict', revision, since, { baseCommit: text(record.baseCommit), head: probe.head || '' }));
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Merge freshly computed candidates into the stored queue. An entry that is
 * still present keeps its `firstSeenAt`; absent entries are dropped; a changed
 * revision is a different key, so it starts over.
 *
 * @param {unknown} previous stored `triageQueue`
 * @param {ReturnType<typeof computeTriageSignals>} candidates
 * @param {number} now
 * @returns {{ v: number, entries: TriageEntry[], updatedAt: string }}
 */
export function reconcileTriageQueue(previous, candidates, now = Date.now()) {
  const known = new Map(normalizeTriageQueue(previous).entries.map((e) => [e.key, e]));
  const at = new Date(now).toISOString();
  const entries = candidates.slice(0, TRIAGE_QUEUE_MAX_ENTRIES).map((c) => ({
    ...c, firstSeenAt: known.get(c.key)?.firstSeenAt || at,
  }));
  return { v: TRIAGE_QUEUE_VERSION, entries, updatedAt: at };
}

/**
 * Probe one tree worktree against the repository HEAD without writing to the
 * repo: commit distance via `rev-list`, patch applicability via
 * `apply --cached --check` on a throw-away index file in the OS temp dir.
 *
 * @param {Record<string, any>} record worktree registry record
 * @returns {Promise<{ behind: number|null, applies: boolean|null, head: string }>}
 */
export async function probeWorktreeBase(record) {
  const cwd = text(record.repoRoot);
  const base = text(record.baseCommit);
  const result = { behind: null, applies: null, head: '' };
  if (!cwd || !base) return result;
  const run = (args, options = {}) => runGitAsync(args, cwd, { allowFailure: true, ...options });
  const head = await run(['rev-parse', 'HEAD']);
  if (head.status !== 0) return result;
  result.head = head.stdout.trim();
  const count = await run(['rev-list', '--count', `${base}..HEAD`]);
  if (count.status === 0) result.behind = Number.parseInt(count.stdout.trim(), 10);
  // The real worktree change set (committed + uncommitted + untracked), exactly
  // what integration would apply, not just the branch tip.
  let diff;
  try {
    diff = await collectWorktreeExecutionDiffAsync({ worktreePath: text(record.worktreePath), baseCommit: base });
  } catch {
    return result; // worktree gone or unreadable: unknown, not a signal
  }
  if (!diff.patch.trim()) { result.applies = true; return result; }
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'cretli-triage-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    const read = await run(['read-tree', 'HEAD'], { env });
    if (read.status !== 0) return result;
    const check = await run(['apply', '--cached', '--check', '-'], { env, input: diff.patch });
    result.applies = check.status === 0;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return result;
}

/**
 * Recompute the queue for one workspace and persist it on the watcher row
 * (only when a row exists and the queue changed). Never starts agents.
 *
 * @param {string} workspaceFolder
 * @param {{ dataDir?: string, now?: number, items: Record<string, any>[], worktreeRecords?: Record<string, any>[], probe?: typeof probeWorktreeBase }} options
 * @returns {Promise<{ v: number, entries: TriageEntry[], updatedAt: string }>}
 */
export async function refreshTriageQueue(workspaceFolder, options) {
  const { dataDir, now = Date.now(), items } = options;
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  const probe = options.probe || probeWorktreeBase;
  const open = new Set(items.filter((i) => text(i.status) !== 'done').map((i) => text(i.id)));
  // All live records feed the tree signals (a done, unintegrated root keeps its record);
  // only open todos are probed with Git.
  const records = (options.worktreeRecords || []).filter((r) => !text(r.cleanedAt) && !text(r.releasedAt));
  const probed = records.filter((r) => open.has(text(r.todoId))).slice(0, TRIAGE_MAX_BASE_PROBES);
  /** @type {Record<string, any>} */
  const baseProbes = {};
  for (const record of probed) {
    try { baseProbes[text(record.todoId)] = await probe(record); } catch { /* probe failure = unknown, no signal */ }
  }
  const candidates = computeTriageSignals({
    items, now, thresholds: row?.policy?.triage, reports: row?.reports, baseProbes, worktreeRecords: records,
  });
  const next = reconcileTriageQueue(row?.triageQueue, candidates, now);
  if (!row) return next;
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    const merged = reconcileTriageQueue(current.triageQueue, candidates, now);
    const same = JSON.stringify(merged.entries) === JSON.stringify(normalizeTriageQueue(current.triageQueue).entries);
    return same ? false : { triageQueue: merged };
  }, { dataDir, createIfMissing: false });
  return result.ok && result.row ? normalizeTriageQueue(result.row.triageQueue) : next;
}
