/**
 * Strict reviewer pair, scoped to one orchestrator (parent) chat.
 *
 * The first two distinct reviewers an orchestrator starts become its pair and
 * stay it until the orchestrator is done. A member whose last review subchat
 * ended in an error (`failed` / `interrupted`) is dropped lazily on the next
 * read, so the following pick chooses a replacement. Verdict FAIL is a
 * completed review and never evicts a member.
 *
 * A caller may also pass a configuration predicate (`isMemberStartable`): a
 * member that can no longer be started (model removed from the enabled
 * favorites, harness disabled or without a delegation adapter) is dropped on
 * read the same way, unless it still has a non-terminal review of this
 * controller and subject. Transient states (quota, lockouts, provider errors)
 * are never part of that predicate. Without the predicate only the error
 * eviction applies.
 *
 * Pairs are partitioned by review subject (`plan` / `code`) inside one
 * controller entry: `subjects.<subject>.members`. The pre-partition `members`
 * array is never rewritten (rollback); it stays the pair of the legacy
 * `other` subject and is the source of a one-time, lazy per-subject migration
 * (see `readReviewerPairMembers`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { delegationController } from '../delegation-control.js';
import { writeJsonAtomic } from './atomic-write.js';
import { resolveDataPath } from '../runtime-paths.js';
import { sameCanonicalBaseModel } from '../model-identity.js';
import { isActiveDelegationStatus } from '../delegation-status.js';

const FILE = 'reviewer-pairs.json';
const MAX_ENTRIES = 500;

/**
 * @param {any} value
 * @returns {string}
 */
function text(value) {
  return String(value ?? '').trim();
}

/**
 * @param {{ harness: string, model: string }} a
 * @param {{ harness: string, model: string }} b
 * @returns {boolean}
 */
function sameMember(a, b) {
  const harnessA = text(a.harness).toLowerCase();
  const harnessB = text(b.harness).toLowerCase();
  return harnessA === harnessB && sameCanonicalBaseModel(harnessA, a.model, b.model);
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
 * @param {{ items: Record<string, Record<string, any>> }} doc
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
 * @param {any} subject
 * @returns {'plan' | 'code' | ''} '' = the legacy (unpartitioned) pair
 */
function partitionOf(subject) {
  const value = text(subject).toLowerCase();
  return value === 'plan' || value === 'code' ? value : '';
}

/**
 * True when the member's newest review of this parent (and subject, when
 * given) ended in an error.
 *
 * @param {{ harness: string, model: string }} member
 * @param {string} parentChatId
 * @param {Record<string, any>[]} delegations
 * @param {string} subject
 * @returns {boolean}
 */
function hasFailedSubchat(member, parentChatId, delegations, subject) {
  const stamp = (row) => Date.parse(row?.queuedAt || row?.createdAt || '') || 0;
  const rows = memberReviewRows(member, parentChatId, delegations, subject)
    .sort((a, b) => stamp(b) - stamp(a));
  const status = text(rows[0]?.status);
  return status === 'failed' || status === 'interrupted';
}

/**
 * Review rows of this member for this parent (and subject, when given).
 *
 * @param {{ harness: string, model: string }} member
 * @param {string} parentChatId
 * @param {Record<string, any>[]} delegations
 * @param {string} subject
 * @returns {Record<string, any>[]}
 */
function memberReviewRows(member, parentChatId, delegations, subject) {
  return delegations.filter((row) => text(row?.assignment).toLowerCase() === 'review'
    && delegationController(row) === parentChatId
    && (!subject || text(row.reviewSubject).toLowerCase() === subject)
    && sameMember({ harness: text(row.executor?.transport), model: text(row.executor?.model) }, member));
}

/**
 * True when the configuration predicate says the member can no longer be
 * started and nothing protects it: it is not the member the current start just
 * added (`keepMember`) and it has no non-terminal review of this parent and
 * subject (a round in flight is never re-shaped).
 *
 * @param {{ harness: string, model: string }} member
 * @param {string} parentChatId
 * @param {Record<string, any>[]} delegations
 * @param {string} subject
 * @param {{ isMemberStartable?: (member: { harness: string, model: string }) => boolean, keepMember?: { harness: string, model: string } | null }} options
 * @returns {boolean}
 */
function isUnstartableMember(member, parentChatId, delegations, subject, options) {
  if (typeof options.isMemberStartable !== 'function') return false;
  if (options.keepMember && sameMember(options.keepMember, member)) return false;
  let startable = true;
  try {
    startable = options.isMemberStartable(member) !== false;
  } catch {
    // An unreadable configuration never evicts a member.
    startable = true;
  }
  if (startable) return false;
  return !memberReviewRows(member, parentChatId, delegations, subject)
    .some((row) => isActiveDelegationStatus(row?.status));
}

/**
 * Deterministic per-subject migration of a legacy mixed pair: the original
 * members (original order) that actually reviewed this subject for this
 * controller, at most two. Rows with an absent or unknown subject never count.
 *
 * @param {Array<{ harness: string, model: string }>} legacy
 * @param {string} parentChatId
 * @param {Record<string, any>[]} delegations
 * @param {string} subject
 * @returns {Array<{ harness: string, model: string }>}
 */
export function migrateLegacyPairForSubject(legacy, parentChatId, delegations, subject) {
  return legacy
    .filter((member) => delegations.some((row) => text(row?.assignment).toLowerCase() === 'review'
      && delegationController(row) === parentChatId
      && text(row.reviewSubject).toLowerCase() === subject
      && sameMember({ harness: text(row.executor?.transport), model: text(row.executor?.model) }, member)))
    .slice(0, 2);
}

/**
 * Pair members of one orchestrator for one review subject (`plan` / `code`;
 * anything else reads the legacy pair). With `delegations`, members whose
 * newest review errored are evicted (and the eviction is persisted); a
 * subject seen for the first time is migrated from the legacy pair. With
 * `options.isMemberStartable`, a member that can no longer be started is
 * evicted the same way (see `isUnstartableMember`); `options.keepMember` is
 * exempt from that check.
 *
 * @param {any} parentChatId
 * @param {Record<string, any>[]} [delegations]
 * @param {any} [subject]
 * @param {{ isMemberStartable?: (member: { harness: string, model: string }) => boolean, keepMember?: { harness: string, model: string } | null }} [options]
 * @returns {Array<{ harness: string, model: string }>}
 */
export function readReviewerPairMembers(parentChatId, delegations, subject, options = {}) {
  const id = text(parentChatId);
  if (!id) return [];
  const part = partitionOf(subject);
  const doc = load();
  const entry = doc.items[id] || {};
  const legacy = Array.isArray(entry.members) ? entry.members : [];
  let members = legacy;
  let migrated = false;
  if (part) {
    const stored = entry.subjects?.[part]?.members;
    if (Array.isArray(stored)) members = stored;
    else if (Array.isArray(delegations) && legacy.length > 0) {
      members = migrateLegacyPairForSubject(legacy, id, delegations, part);
      migrated = true;
    } else members = [];
  }
  if (!Array.isArray(delegations) || members.length === 0) {
    if (migrated) writeSubjectMembers(doc, id, part, members);
    return members;
  }
  const kept = members.filter((m) => !hasFailedSubchat(m, id, delegations, part)
    && !isUnstartableMember(m, id, delegations, part, options || {}));
  if (kept.length !== members.length || migrated) {
    if (part) writeSubjectMembers(doc, id, part, kept);
    else {
      doc.items[id] = { ...entry, members: kept, updatedAt: new Date().toISOString() };
      save(doc);
    }
  }
  return kept;
}

/**
 * @param {{ items: Record<string, any> }} doc
 * @param {string} id
 * @param {'plan' | 'code'} part
 * @param {Array<{ harness: string, model: string }>} members
 * @returns {void}
 */
function writeSubjectMembers(doc, id, part, members) {
  const entry = doc.items[id] || {};
  doc.items[id] = {
    ...entry,
    members: Array.isArray(entry.members) ? entry.members : [],
    subjects: { ...(entry.subjects || {}), [part]: { members } },
    updatedAt: new Date().toISOString(),
  };
  save(doc);
}

/**
 * Remember a reviewer as pair member of a subject (no-op for a duplicate or a
 * full pair).
 *
 * @param {any} parentChatId
 * @param {{ harness: string, model: string }} member
 * @param {any} [subject]
 * @returns {boolean} true when the pair changed
 */
export function addReviewerPairMember(parentChatId, member, subject) {
  const id = text(parentChatId);
  if (!id || !text(member?.harness) || !text(member?.model)) return false;
  const part = partitionOf(subject);
  const doc = load();
  const entry = doc.items[id] || {};
  const members = part
    ? (Array.isArray(entry.subjects?.[part]?.members) ? entry.subjects[part].members : [])
    : (Array.isArray(entry.members) ? entry.members : []);
  if (members.length >= 2 || members.some((m) => sameMember(m, member))) return false;
  const next = [...members, { harness: text(member.harness), model: text(member.model) }];
  if (part) writeSubjectMembers(doc, id, part, next);
  else {
    doc.items[id] = { ...entry, members: next, updatedAt: new Date().toISOString() };
    save(doc);
  }
  return true;
}

/**
 * Remove a reviewer from a subject's pair. Used to roll back the learning write
 * when the delegation record is never created, so a refused start leaves no
 * orphan pair member behind.
 *
 * @param {any} parentChatId
 * @param {{ harness: string, model: string }} member
 * @param {any} [subject]
 * @returns {boolean} true when the pair changed
 */
export function removeReviewerPairMember(parentChatId, member, subject) {
  const id = text(parentChatId);
  if (!id || !text(member?.harness) || !text(member?.model)) return false;
  const part = partitionOf(subject);
  const doc = load();
  const entry = doc.items[id] || {};
  const members = part
    ? (Array.isArray(entry.subjects?.[part]?.members) ? entry.subjects[part].members : [])
    : (Array.isArray(entry.members) ? entry.members : []);
  const next = members.filter((m) => !sameMember(m, member));
  if (next.length === members.length) return false;
  if (part) writeSubjectMembers(doc, id, part, next);
  else {
    doc.items[id] = { ...entry, members: next, updatedAt: new Date().toISOString() };
    save(doc);
  }
  return true;
}
