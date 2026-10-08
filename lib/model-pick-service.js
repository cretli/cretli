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
import { loadDelegations } from './persist/delegations-persist.js';
import { loadModelPickExploreAttempts } from './persist/model-pick-explore-persist.js';
import {
  buildExploreAttemptMarker,
  countAutoExecutedWorkload,
  loadModelPickExploreConfig,
} from './model-pick-explore.js';

/**
 * @param {string} line
 */
function logWouldExplore(line) {
  // Same test suppression as the delegation log: unit tests capture the line
  // through `exploreLog`, the server prints it.
  if (process.env.CRETLI_TEST_DATA_DIR) return;
  console.info('[model-pick]', line);
}

/**
 * Durable inputs the exploration policy needs: the attempts already made (for
 * the deterministic order, the caps, and the pair cooldown) and the executed
 * automatic workload (the only denominator that earns explore credits).
 *
 * Both stores are optional: an unreadable store yields an empty ledger, which
 * simply leaves the budget at zero instead of inventing chances.
 *
 * @param {{ now?: number, workspaceFolder?: string, file?: string, exploreFile?: string, delegations?: object[] }} [input]
 * @returns {{ attempts: object[], autoExecuted: number, workspaceKey: string }}
 */
export function buildModelPickExploreLedger(input = {}) {
  const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
  let attempts = [];
  try {
    attempts = loadModelPickExploreAttempts({ file: input.exploreFile });
  } catch {
    attempts = [];
  }
  let delegations = input.delegations;
  if (!Array.isArray(delegations)) {
    try {
      delegations = loadDelegations();
    } catch {
      delegations = [];
    }
  }
  const windowMs = loadModelPickExploreConfig().windowMs;
  return {
    attempts,
    autoExecuted: countAutoExecutedWorkload(delegations, { now, windowMs }),
    workspaceKey: String(input.workspaceFolder || '').trim(),
  };
}

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
 * `selectModelPick` plus usage history (delegations + chats of `purpose`) plus
 * the durable out-of-band exploration ledger. Accepts every `selectModelPick`
 * input; `history` overrides the built one.
 *
 * Exploration is the picker's own decision, not a feature of one caller: this
 * entry point is what `model_pick`, the Watcher orchestrator and the Scout all
 * use, so all three read the same explore policy and the same budget.
 * `explore: false` turns the assessment off for a call.
 *
 * @param {object} input
 * @param {string} [input.purpose]
 * @param {string} [input.chatId]
 * @param {typeof selectModelPick} [input.selectModelPick]
 * @returns {ReturnType<typeof selectModelPick>}
 */
export function pickModelForPurpose(input = {}) {
  const {
    purpose,
    chatId,
    selectModelPick: picker,
    exploreLedger,
    exploreConfig,
    exploreLog,
    ...rest
  } = input;
  const select = typeof picker === 'function' ? picker : selectModelPick;
  const history = rest.history || buildModelPickHistory({
    role: rest.role,
    chatId,
    harnesses: rest.harnesses,
    extraUses: listPurposeUses(purpose, { now: rest.now }),
  });
  const exploration = rest.explore === false
    ? {}
    : {
      exploreConfig: exploreConfig ?? loadModelPickExploreConfig(),
      exploreLedger: exploreLedger ?? buildModelPickExploreLedger({
        now: rest.now,
        workspaceFolder: rest.workspaceFolder,
        exploreFile: rest.exploreFile,
        delegations: rest.delegations,
      }),
      exploreContext: rest.exploreContext,
      exploreMetering: rest.exploreMetering,
      exploreLog: typeof exploreLog === 'function' ? exploreLog : logWouldExplore,
    };
  return select({ ...rest, history, ...exploration });
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
    // The pair an exploration chose, so a start can bind its durable attempt to
    // this proposal. Dry-run records the candidate only: no start, no attempt,
    // no budget consumed.
    explore: buildExploreAttemptMarker(picked.explore, input.role),
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
