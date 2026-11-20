/**
 * Side-effecting half of the review gate for `done` writes that arrive over
 * REST (D1) or the in-process MCP client (D2). The pure decision lives in
 * `workspace-watcher-review-gate.js`; this module reads the stores, records the
 * audit trail and applies the marker rules of contract §4.1:
 *
 * - identity comes from the signed token only (`req.mcpIntegration` /
 *   `req.widgetAccess`), never from a request body;
 * - a browser session is never gated and is the only caller that clears a marker;
 * - an agent caller that moves a held leaf keeps marker and label.
 */

import { listTodos } from './persist/todos-store.js';
import {
  appendWorkspaceWatcherDecision,
  getWorkspaceWatcher,
  mutateWorkspaceWatcherRow,
} from './persist/workspace-watchers-persist.js';
import { loadDelegations } from './persist/delegations-persist.js';
import {
  applyReviewGateLabel,
  recordReviewGateWarning,
} from './workspace-watcher-cycle-close.js';
import {
  REVIEW_MISSING_REASON,
  guardCycleDoneWrite,
  isReviewMarkerHoldingDoing,
  resolveReviewGateMode,
} from './workspace-watcher-review-gate.js';

/**
 * Caller identity from an Express request: signed MCP token, widget bearer or a
 * browser session. `body.chatId` is data and is never consulted.
 *
 * @param {{ mcpIntegration?: { chatId?: string } | null, widgetAccess?: unknown } | null | undefined} req
 * @returns {{ kind: 'session'|'mcp'|'widget', chatId: string }}
 */
export function resolveReviewGateCallerFromRequest(req) {
  if (req && req.mcpIntegration) {
    return { kind: 'mcp', chatId: String(req.mcpIntegration.chatId || '').trim() };
  }
  if (req && req.widgetAccess) return { kind: 'widget', chatId: '' };
  return { kind: 'session', chatId: '' };
}

/**
 * Remove one marker (human action or a qualifying PASS).
 *
 * @param {{ dataDir?: string, workspaceFolder: string, todoId: string }} input
 * @returns {void}
 */
export function clearReviewGateMarker(input) {
  try {
    const row = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
    if (!row?.reviewWaits || !row.reviewWaits[input.todoId]) return;
    mutateWorkspaceWatcherRow(input.workspaceFolder, ({ row: current }) => {
      if (!current.reviewWaits || !current.reviewWaits[input.todoId]) return false;
      const next = { ...current.reviewWaits };
      delete next[input.todoId];
      return { reviewWaits: next };
    }, { dataDir: input.dataDir, createIfMissing: false });
  } catch {
    // Marker bookkeeping must never fail the user-visible write.
  }
}

/**
 * Re-apply the review-gate label after an agent moved a held leaf (a status
 * write clears `blockedReason`, but the marker still gates).
 *
 * @param {{ dataDir?: string, workspaceFolder: string, todoId: string }} input
 * @returns {Promise<boolean>}
 */
export async function reapplyReviewGateLabel(input) {
  try {
    const row = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
    const marker = row?.reviewWaits?.[input.todoId];
    if (!isReviewMarkerHoldingDoing(marker, row?.policy)) return false;
    return await applyReviewGateLabel({
      workspaceFolder: input.workspaceFolder,
      dataDir: input.dataDir,
      todoId: input.todoId,
      marker,
      policy: row.policy,
    });
  } catch {
    return false;
  }
}

/**
 * Judge one todo patch before `updateTodo`. Throws a `VALIDATION` error with
 * `reason: 'review_missing'` when `enforce` refuses a `done`. Returns a
 * callback to run after the write succeeded (marker clear / label re-apply).
 *
 * @param {{
 *   dataDir?: string,
 *   workspaceFolder: string,
 *   todoId: string,
 *   patch: Record<string, unknown>,
 *   caller: { kind: 'session'|'mcp'|'widget', chatId?: string },
 * }} input
 * @returns {Promise<{ afterWrite: () => Promise<void> | void, warned: boolean }>}
 */
export async function checkReviewGateForTodoWrite(input) {
  const noop = { afterWrite() {}, warned: false };
  let row = null;
  try {
    row = getWorkspaceWatcher(input.workspaceFolder, { dataDir: input.dataDir });
  } catch {
    return noop;
  }
  if (!row) return noop;
  const hasMarker = Boolean(row.reviewWaits && row.reviewWaits[input.todoId]);
  const mode = resolveReviewGateMode(row.policy);
  if (mode === 'off' && !hasMarker) return noop;
  let items = [];
  try {
    items = (await listTodos(input.dataDir, input.workspaceFolder))?.items || [];
  } catch {
    return noop;
  }
  const todo = items.find((entry) => String(entry?.id || '') === input.todoId) || null;
  if (!todo) return noop;
  let delegations = [];
  if (input.caller.kind !== 'session' && input.caller.chatId) {
    try { delegations = loadDelegations(input.dataDir ? { dataDir: input.dataDir } : {}); } catch { delegations = []; }
  }
  const decision = guardCycleDoneWrite({
    todo,
    patch: input.patch,
    caller: input.caller,
    row,
    policy: row.policy,
    items,
    delegations,
  });
  const at = new Date().toISOString();
  const logDecision = (kind) => {
    try {
      appendWorkspaceWatcherDecision(input.workspaceFolder, {
        at,
        kind,
        reason: `${REVIEW_MISSING_REASON}:${decision.callerClass}:${decision.gate?.reason || ''}`,
        nextTodoId: input.todoId,
      }, { dataDir: input.dataDir });
    } catch {
      // Audit only.
    }
  };
  if (!decision.allowed) {
    logDecision('review_gate_rejected');
    const error = new Error(
      'Workspace Watcher review gate: a done write needs a current passed code review with an implementer (review_missing).',
    );
    /** @type {any} */ (error).code = 'VALIDATION';
    /** @type {any} */ (error).reason = REVIEW_MISSING_REASON;
    throw error;
  }
  if (decision.warn) {
    logDecision('review_gate_warn');
    // The note bumps `updatedAt`, so it is written AFTER the caller's write:
    // warn must never change the outcome of the write it observes.
    return {
      warned: true,
      async afterWrite() {
        await recordReviewGateWarning({
          workspaceFolder: input.workspaceFolder,
          dataDir: input.dataDir,
          todoId: input.todoId,
          chatId: input.caller.chatId,
          state: decision.gate?.state,
        });
      },
    };
  }
  return {
    warned: false,
    async afterWrite() {
      if (decision.clearMarker) {
        clearReviewGateMarker({
          dataDir: input.dataDir,
          workspaceFolder: input.workspaceFolder,
          todoId: input.todoId,
        });
        return;
      }
      if (input.caller.kind !== 'session' && hasMarker) {
        await reapplyReviewGateLabel({
          dataDir: input.dataDir,
          workspaceFolder: input.workspaceFolder,
          todoId: input.todoId,
        });
      }
    },
  };
}
