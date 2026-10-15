/**
 * Strict reviewer pair, scoped to one orchestrator (parent) chat.
 *
 * The first two distinct reviewers an orchestrator starts become its pair and
 * stay it until the orchestrator is done. A member whose last review subchat
 * ended in an error (`failed` / `interrupted`) is dropped lazily on the next
 * read, so the following pick chooses a replacement. Verdict FAIL is a
 * completed review and never evicts a member.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';

const FILE = 'reviewer-pairs.json';
const MAX_ENTRIES = 500;

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {unknown} model
 * @returns {string}
 */
function baseId(model) {
  return text(model).split('::')[0].toLowerCase();
}

/**
 * @param {{ harness: string, model: string }} a
 * @param {{ harness: string, model: string }} b
 * @returns {boolean}
 */
function sameMember(a, b) {
  return text(a.harness).toLowerCase() === text(b.harness).toLowerCase() && baseId(a.model) === baseId(b.model);
}

/**
 * @returns {{ items: Record<string, { members: Array<{ harness: string, model: string }>, updatedAt: string }> }}
 */
function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(resolveDataPath(), FILE), 'utf8'));
    if (parsed && typeof parsed.items === 'object' && parsed.items) return { items: parsed.items };
  } catch {
    // Missing or unreadable: no pairs yet.
  }
  return { items: {} };
}

/**
 * @param {{ items: Record<string, object> }} doc
 * @returns {void}
 */
function save(doc) {
  const keys = Object.keys(doc.items);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => String(doc.items[a]?.updatedAt || '').localeCompare(String(doc.items[b]?.updatedAt || '')));
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete doc.items[key];
  }
  writeJsonAtomic(path.join(resolveDataPath(), FILE), doc);
}

/**
 * True when the member's newest review of this parent ended in an error.
 *
 * @param {{ harness: string, model: string }} member
 * @param {string} parentChatId
 * @param {object[]} delegations
 * @returns {boolean}
 */
function hasFailedSubchat(member, parentChatId, delegations) {
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const rows = delegations
    .filter((row) => text(row?.assignment).toLowerCase() === 'review'
      && (text(row.controllerChatId) || text(row.parentChatId)) === parentChatId
      && sameMember({ harness: text(row.executor?.transport), model: text(row.executor?.model) }, member))
    .sort((a, b) => stamp(b) - stamp(a));
  const status = text(rows[0]?.status);
  return status === 'failed' || status === 'interrupted';
}

/**
 * Pair members of one orchestrator. With `delegations`, members whose newest
 * review errored are evicted (and the eviction is persisted).
 *
 * @param {unknown} parentChatId
 * @param {object[]} [delegations]
 * @returns {Array<{ harness: string, model: string }>}
 */
export function readReviewerPairMembers(parentChatId, delegations) {
  const id = text(parentChatId);
  if (!id) return [];
  const doc = load();
  const members = Array.isArray(doc.items[id]?.members) ? doc.items[id].members : [];
  if (!Array.isArray(delegations) || members.length === 0) return members;
  const kept = members.filter((m) => !hasFailedSubchat(m, id, delegations));
  if (kept.length !== members.length) {
    doc.items[id] = { members: kept, updatedAt: new Date().toISOString() };
    save(doc);
  }
  return kept;
}

/**
 * Remember a reviewer as pair member (no-op for a duplicate or a full pair).
 *
 * @param {unknown} parentChatId
 * @param {{ harness: string, model: string }} member
 * @returns {boolean} true when the pair changed
 */
export function addReviewerPairMember(parentChatId, member) {
  const id = text(parentChatId);
  if (!id || !text(member?.harness) || !text(member?.model)) return false;
  const doc = load();
  const members = Array.isArray(doc.items[id]?.members) ? doc.items[id].members : [];
  if (members.length >= 2 || members.some((m) => sameMember(m, member))) return false;
  doc.items[id] = {
    members: [...members, { harness: text(member.harness), model: text(member.model) }],
    updatedAt: new Date().toISOString(),
  };
  save(doc);
  return true;
}
