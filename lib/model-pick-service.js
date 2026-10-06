/**
 * One automatic model-selection entry point for every feature that has to
 * choose a harness/model on its own (delegation `model_pick`, Workspace
 * Watcher orchestrator, Scout, future features).
 *
 * A feature names itself with a `purpose`; chats it creates are tagged with
 * `pickPurpose: <purpose>` (see `addChat` extras). Those chats count as role
 * usage next to delegation jobs, so the rotation / least-used balance applies
 * and the same top-ranked model is not picked forever.
 */

import { loadChats } from './persist/chats-persist.js';
import { buildModelPickHistory, ROLE_USAGE_WINDOW_MS } from './model-pick-history.js';
import { selectModelPick } from './model-role-profiles.js';
import { persistModelPickProposal } from './model-pick-decisions.js';

/**
 * Tagged chats of one purpose inside the usage window, as role usage rows.
 *
 * @param {string} purpose
 * @param {{ chats?: object[], now?: number }} [input]
 * @returns {{ harness: string, model: string, createdAt: string }[]}
 */
export function listPurposeUses(purpose, input = {}) {
  const wanted = String(purpose || '').trim();
  if (!wanted) return [];
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  let chats = input.chats;
  if (!Array.isArray(chats)) {
    try {
      chats = loadChats();
    } catch {
      chats = [];
    }
  }
  const out = [];
  for (const chat of chats) {
    if (String(chat?.pickPurpose || '') !== wanted) continue;
    const at = Date.parse(String(chat?.createdAt || ''));
    if (!Number.isFinite(at) || at < now - ROLE_USAGE_WINDOW_MS) continue;
    out.push({
      harness: String(chat?.agentTransport || '').trim(),
      model: String(chat?.model || '').trim(),
      createdAt: String(chat.createdAt),
    });
  }
  return out;
}

/**
 * `selectModelPick` plus usage history (delegations + chats of `purpose`).
 * Accepts every `selectModelPick` input; `history` overrides the built one.
 *
 * @param {object} input
 * @param {string} [input.purpose]
 * @param {string} [input.chatId]
 * @param {typeof selectModelPick} [input.selectModelPick]
 * @returns {ReturnType<typeof selectModelPick>}
 */
export function pickModelForPurpose(input = {}) {
  const { purpose, chatId, selectModelPick: picker, ...rest } = input;
  const select = typeof picker === 'function' ? picker : selectModelPick;
  const history = rest.history || buildModelPickHistory({
    role: rest.role,
    chatId,
    harnesses: rest.harnesses,
    extraUses: listPurposeUses(purpose, { now: rest.now }),
  });
  return select({ ...rest, history });
}

/**
 * Run {@link pickModelForPurpose} and persist a bounded proposal when the pick succeeds.
 *
 * @param {object} input
 * @returns {ReturnType<typeof pickModelForPurpose> & { pickId?: string, pickExpiresAt?: string, policyVersion?: string }}
 */
export function pickAndPersistModelForPurpose(input = {}) {
  const picked = pickModelForPurpose(input);
  if (!picked.ok) return picked;
  const persisted = persistModelPickProposal({
    chatId: input.chatId,
    workspaceFolder: input.workspaceFolder,
    purpose: input.purpose,
    role: input.role,
    pickResult: picked,
    now: input.now,
    file: input.file,
  });
  return {
    ...picked,
    pickId: persisted.pickId,
    pickExpiresAt: persisted.expiresAt,
    policyVersion: persisted.policyVersion,
  };
}
