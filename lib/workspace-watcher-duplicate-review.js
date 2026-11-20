/**
 * Workspace Watcher — opt-in duplicate review of open todos.
 *
 * Deterministic and LLM-free. When `policy.duplicateReview` is on, each pass
 * groups open todos that share an exact normalized title or the same
 * `stall-signature:` marker and records one pending proposal per group. The
 * Watcher never closes, defers or deletes anything on its own: a human accepts
 * (the duplicates are moved to `deferred`, never deleted) or dismisses.
 */

import { createHash, randomUUID } from 'node:crypto';
import { listTodos, updateTodo } from './persist/todos-store.js';
import {
  appendWorkspaceWatcherDecision,
  getWorkspaceWatcher,
  loadWorkspaceWatchers,
  mutateWorkspaceWatcherRow,
} from './persist/workspace-watchers-persist.js';
import { appendWorkspaceWatcherNotice } from './workspace-watcher-pinned-chat.js';
import { broadcastWorkspaceWatcherChanged } from './workspace-watcher-live.js';

const OPEN_STATUSES = new Set(['idea', 'ready', 'doing', 'deferred']);
/** Only these may be proposed for deferral; `doing` work and parked todos are never touched. */
const DEFERRABLE_STATUSES = new Set(['idea', 'ready']);
const SIGNATURE_RE = /^stall-signature: (.+)$/m;
const MAX_NEW_PROPOSALS_PER_PASS = 20;

/** @param {unknown} title */
function normalizeTitle(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Exact-duplicate groups among open todos: same normalized title, or same
 * stall signature. A todo may appear in both a title and a signature group.
 *
 * @param {Record<string, any>[]} items
 * @returns {Array<{ key: string, kind: 'title'|'signature', label: string, keepId: string, duplicateIds: string[] }>}
 */
export function findDuplicateGroups(items) {
  /** @type {Map<string, { kind: 'title'|'signature', label: string, members: Record<string, any>[] }>} */
  const buckets = new Map();
  const add = (bucketKey, kind, label, item) => {
    const bucket = buckets.get(bucketKey) || { kind, label, members: [] };
    bucket.members.push(item);
    buckets.set(bucketKey, bucket);
  };
  const parentIds = new Set((Array.isArray(items) ? items : []).map((item) => item?.parentId).filter(Boolean));
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || !OPEN_STATUSES.has(item.status)) continue;
    const title = normalizeTitle(item.title);
    if (title) add(`title:${title}`, 'title', String(item.title).trim(), item);
    const signature = SIGNATURE_RE.exec(String(item.body || ''))?.[1]?.trim();
    if (signature) add(`signature:${signature}`, 'signature', signature, item);
  }
  const groups = [];
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.members.length < 2) continue;
    // Keep the todo that is already in motion or parked, else the oldest one.
    const rank = (item) => (item.status === 'doing' ? 0 : item.status === 'deferred' ? 1 : item.status === 'ready' ? 2 : 3);
    // At equal rank a leaf is kept over a container: the container can never be proposed, so a
    // timestamp tie must not turn the leaf into a proposed duplicate of it.
    const containerRank = (item) => (parentIds.has(item.id) ? 1 : 0);
    const sorted = [...bucket.members].sort((a, b) => rank(a) - rank(b) || containerRank(a) - containerRank(b)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
    const keep = sorted[0];
    const duplicateIds = sorted.slice(1)
      // A container is never proposed: deferring it would cascade to descendants nobody reviewed.
      .filter((item) => DEFERRABLE_STATUSES.has(item.status) && !parentIds.has(item.id)).map((item) => item.id).sort();
    if (!duplicateIds.length) continue;
    const key = createHash('sha256').update(`${bucketKey}\0${keep.id}\0${duplicateIds.join(',')}`).digest('hex').slice(0, 32);
    groups.push({ key, kind: bucket.kind, label: bucket.label, keepId: keep.id, duplicateIds });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * One review pass for a workspace. No-op unless `policy.duplicateReview` is on.
 *
 * @param {string} workspaceFolder
 * @param {{ dataDir?: string, now?: number, notify?: Function }} [options]
 * @returns {Promise<{ proposed: Array<Record<string, any>>, skipped?: string }>}
 */
export async function reviewDuplicateTodos(workspaceFolder, options = {}) {
  const { dataDir, now = Date.now(), notify = appendWorkspaceWatcherNotice } = options;
  const row = getWorkspaceWatcher(workspaceFolder, { dataDir });
  if (!row || row.mode === 'off' || row.paused) return { proposed: [], skipped: 'inactive' };
  if (row.policy?.duplicateReview !== true) return { proposed: [], skipped: 'disabled' };
  const known = new Set((row.duplicateProposals || []).map((entry) => entry.key));
  const groups = findDuplicateGroups((await listTodos(dataDir, workspaceFolder)).items)
    .filter((group) => !known.has(group.key)).slice(0, MAX_NEW_PROPOSALS_PER_PASS);
  if (!groups.length) return { proposed: [] };
  const at = new Date(now).toISOString();
  const created = groups.map((group) => ({ id: randomUUID(), status: 'pending', at, ...group }));
  const result = mutateWorkspaceWatcherRow(workspaceFolder, ({ row: current }) => {
    if (current.policy?.duplicateReview !== true) return false;
    const have = new Set(current.duplicateProposals.map((entry) => entry.key));
    const fresh = created.filter((entry) => !have.has(entry.key));
    return fresh.length ? { duplicateProposals: [...current.duplicateProposals, ...fresh] } : false;
  }, { dataDir, createIfMissing: false });
  if (!result.ok) return { proposed: [] };
  const stored = new Set((result.row?.duplicateProposals || []).map((entry) => entry.id));
  const proposed = created.filter((entry) => stored.has(entry.id));
  for (const proposal of proposed) {
    // The decision-log line is what "Why?" renders.
    appendWorkspaceWatcherDecision(workspaceFolder, {
      at, kind: 'duplicate_proposal', shouldNotify: true, nextTodoId: proposal.keepId,
      reason: `duplicate_review: ${proposal.duplicateIds.length} open todo(s) duplicate ${proposal.kind} "${proposal.label.slice(0, 120)}" of ${proposal.keepId}; awaiting human decision`,
    }, { dataDir });
    void notify({
      workspaceFolder, dataDir, action: 'duplicate_review', level: 'info', todoId: proposal.keepId, at,
      text: `${proposal.duplicateIds.length} open todo(s) look like exact duplicates of ${proposal.keepId.slice(0, 8)} (${proposal.kind}: ${proposal.label.slice(0, 80)}). Defer or dismiss in the Todo panel.`,
    });
  }
  if (proposed.length) broadcastWorkspaceWatcherChanged({ workspaceFolder });
  return { proposed };
}

/** Runtime-worker entry: one pass per watcher row, errors isolated per workspace. */
/** @param {{ dataDir?: string, now?: number, deps?: { notify?: Function } }} [options] */
export async function runDuplicateReviewPass({ dataDir, now = Date.now(), deps = {} } = {}) {
  const result = { proposed: 0, errors: [] };
  for (const watcher of loadWorkspaceWatchers({ dataDir })) {
    if (watcher.policy?.duplicateReview !== true) continue;
    try {
      result.proposed += (await reviewDuplicateTodos(watcher.workspaceFolder, { dataDir, now, notify: deps.notify })).proposed.length;
    } catch (failure) {
      result.errors.push({ workspaceFolder: watcher.workspaceFolder, error: String(failure?.message || failure) });
    }
  }
  return result;
}

/** @param {string} workspaceFolder @param {{ dataDir?: string }} [options] */
export function listDuplicateProposals(workspaceFolder, options = {}) {
  return getWorkspaceWatcher(workspaceFolder, options)?.duplicateProposals || [];
}

/** In-process single flight per proposal; the cross-process guard is the `applying` claim below. */
const decisionsInFlight = new Map();

/**
 * Human decision. `defer` moves the still-idea/ready duplicates to `deferred`
 * (reversible, nothing is deleted); `dismiss` only records the verdict so the
 * same group is not proposed again.
 *
 * Effects are claimed first (`pending` -> `applying`) under the watcher row
 * lock, so a concurrent dismiss/defer cannot also act. The basis is revalidated
 * against live todos before any change; a stale proposal is marked `stale` and
 * changes nothing. A partially applied defer stays `applying` and can be
 * resumed by calling `defer` again (already-deferred todos are skipped).
 *
 * @param {string} workspaceFolder
 * @param {string} proposalId
 * @param {'defer'|'dismiss'} decision
 * @param {{ dataDir?: string }} [options]
 */
export async function decideDuplicateProposal(workspaceFolder, proposalId, decision, options = {}) {
  if (!['defer', 'dismiss'].includes(decision)) throw Object.assign(new Error('Invalid decision'), { code: 'VALIDATION' });
  const flightKey = `${options.dataDir || ''}\0${workspaceFolder}\0${proposalId}\0${decision}`;
  const running = decisionsInFlight.get(flightKey);
  if (running) return running;
  const flight = decideOnce(workspaceFolder, proposalId, decision, options)
    .finally(() => { decisionsInFlight.delete(flightKey); });
  decisionsInFlight.set(flightKey, flight);
  return flight;
}

async function decideOnce(workspaceFolder, proposalId, decision, options) {
  const { dataDir } = options;
  const at = () => new Date().toISOString();
  const patchProposal = (patch, allowed) => mutateWorkspaceWatcherRow(workspaceFolder, ({ row }) => {
    const current = row.duplicateProposals.find((entry) => entry.id === proposalId);
    if (!current || !allowed.includes(current.status)) return false;
    return { duplicateProposals: row.duplicateProposals.map((entry) => (entry.id === proposalId ? { ...entry, ...patch } : entry)) };
  }, { dataDir, createIfMissing: false });
  const audit = (kind, proposal, reason) => appendWorkspaceWatcherDecision(workspaceFolder, {
    at: at(), kind, shouldNotify: false, nextTodoId: proposal.keepId, reason: `duplicate_review: ${reason}`,
  }, { dataDir });
  const skipped = { ok: false, reason: 'skipped', proposal: null };

  if (decision === 'dismiss') {
    const claimed = patchProposal({ status: 'dismissed', decidedAt: at(), deferredIds: [] }, ['pending']);
    if (!claimed.ok) return skipped;
    const proposal = claimed.row.duplicateProposals.find((entry) => entry.id === proposalId);
    audit('duplicate_decision', proposal, `operator dismissed proposal ${proposalId.slice(0, 8)} (0 todo(s) deferred)`);
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    return { ok: true, proposal, deferred: [] };
  }

  // Claim before any side effect; `applying` may be re-entered to resume a partial defer.
  const claimed = patchProposal({ status: 'applying' }, ['pending', 'applying']);
  if (!claimed.ok) return skipped;
  const proposal = claimed.row.duplicateProposals.find((entry) => entry.id === proposalId);
  const items = (await listTodos(dataDir, workspaceFolder)).items;
  const alreadyDeferred = new Set(proposal.deferredIds || []);
  // Revalidate the basis per todo (not by group key: a resumed partial defer changes the ranking).
  const matchesBasis = (item) => (proposal.kind === 'title'
    ? normalizeTitle(item.title) === normalizeTitle(proposal.label)
    : SIGNATURE_RE.exec(String(item.body || ''))?.[1]?.trim() === proposal.label);
  const keeper = items.find((item) => item.id === proposal.keepId);
  const keeperValid = Boolean(keeper && OPEN_STATUSES.has(keeper.status) && matchesBasis(keeper));
  const parentIds = new Set(items.map((item) => item.parentId).filter(Boolean));
  const owed = keeperValid
    ? proposal.duplicateIds.filter((id) => {
      const item = items.find((entry) => entry.id === id);
      return !alreadyDeferred.has(id) && item && DEFERRABLE_STATUSES.has(item.status) && matchesBasis(item) && !parentIds.has(id);
    })
    : [];
  if (!owed.length && alreadyDeferred.size === 0) {
    patchProposal({ status: 'stale', decidedAt: at(), deferredIds: [] }, ['applying']);
    audit('duplicate_decision', proposal, `proposal ${proposalId.slice(0, 8)} is stale (basis changed); nothing deferred`);
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    return { ok: false, reason: 'stale', proposal: null, deferred: [] };
  }
  const deferred = [...alreadyDeferred];
  try {
    for (const id of owed) {
      const todo = items.find((item) => item.id === id);
      if (!todo || !DEFERRABLE_STATUSES.has(todo.status)) continue;
      await updateTodo(dataDir, workspaceFolder, id, {
        status: 'deferred',
        deferredReason: `Exact duplicate of ${proposal.keepId} (approved by operator)`,
        expectedUpdatedAt: todo.updatedAt,
        appendChangelog: { kind: 'note', text: `Deferred as duplicate of ${proposal.keepId} after human approval of proposal ${proposal.id}.` },
      });
      deferred.push(id);
      patchProposal({ deferredIds: [...deferred] }, ['applying']);
    }
  } catch (failure) {
    audit('duplicate_decision', proposal, `defer of proposal ${proposalId.slice(0, 8)} failed after ${deferred.length} todo(s): ${String(failure?.message || failure).slice(0, 160)}; resume by deciding again`);
    broadcastWorkspaceWatcherChanged({ workspaceFolder });
    return { ok: false, reason: 'partial', proposal: null, deferred };
  }
  const done = patchProposal({ status: 'deferred', decidedAt: at(), deferredIds: deferred }, ['applying']);
  audit('duplicate_decision', proposal, `operator deferred proposal ${proposalId.slice(0, 8)} (${deferred.length} todo(s) deferred)`);
  broadcastWorkspaceWatcherChanged({ workspaceFolder });
  return { ok: true, proposal: done.row?.duplicateProposals.find((entry) => entry.id === proposalId) || null, deferred };
}
