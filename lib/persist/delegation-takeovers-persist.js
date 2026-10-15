/** Durable, untrimmed orchestration takeover journal. */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { ensureDelegationOwnerLock } from '../delegation-owner-lock.js';

export function loadDelegationTakeovers() {
  const file = resolveDataPath('delegation-takeovers.json');
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.v !== 1 || !Array.isArray(doc.items)) throw new Error('Invalid takeover journal');
  return doc.items;
}

export function saveDelegationTakeover(record) {
  ensureDelegationOwnerLock();
  const items = loadDelegationTakeovers();
  const index = items.findIndex((row) => row.id === record.id);
  if (index < 0) items.push(record);
  else items[index] = record;
  const file = resolveDataPath('delegation-takeovers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, { v: 1, items });
  return record;
}

/** Recipients are equivalent only along recorded transfers for this job. */
export function recipientsEquivalent(delegationId, left, right) {
  if (left === right) return true;
  const edges = loadDelegationTakeovers().filter((row) => row.delegationIds.includes(delegationId));
  const reachable = new Set([left]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of edges) {
      if (!reachable.has(row.from) && !reachable.has(row.to)) continue;
      for (const id of [row.from, row.to]) {
        if (reachable.has(id)) continue;
        reachable.add(id);
        changed = true;
      }
    }
  }
  return reachable.has(right);
}

/** Block steering while a durable transfer is incomplete, including after crashes. */
export function assertNoTakeoverInProgress({ delegationId, chatId, leafId } = {}) {
  const pending = loadDelegationTakeovers().find((row) => row.phase !== 'done'
    && ((delegationId && row.delegationIds.includes(delegationId))
      || (chatId && [row.from, row.to].includes(chatId) && (!leafId || row.leafIds.includes(leafId)))));
  if (!pending) return;
  const error = new Error('Orchestration takeover is in progress.');
  error.code = 'takeover_in_progress';
  error.status = 409;
  throw error;
}

/** Return the service conflict shape while preserving throwing guards for internal writers. */
export function takeoverInProgressResult(input) {
  try {
    assertNoTakeoverInProgress(input);
    return null;
  } catch (error) {
    if (error.code !== 'takeover_in_progress') throw error;
    return { ok: false, status: 409, code: error.code, error: error.message };
  }
}

/** An old controller cannot recreate a transferred leaf workflow. */
export function assertTakeoverWorkflowOwner(chatId, leafId) {
  assertNoTakeoverInProgress({ chatId, leafId });
  if (!leafId) return;
  const latest = loadDelegationTakeovers().findLast((row) => row.phase === 'done'
    && row.leafIds.includes(leafId) && [row.from, row.to].includes(chatId));
  if (!latest || latest.to === chatId) return;
  const error = new Error('Leaf workflow belongs to the takeover controller.');
  error.code = 'takeover_workflow_owner';
  error.status = 409;
  throw error;
}
