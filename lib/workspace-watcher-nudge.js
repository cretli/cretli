/**
 * Workspace Watcher autopilot nudges from todos, delegations, and chat presence.
 */

import { loadChats } from './persist/chats-persist.js';
import { isActiveDelegationStatus, normalizeDelegationStatus } from './delegation-status.js';
import { scheduleWorkspaceWatcherAutopilot } from './workspace-watcher-event-schedule.js';
import { normalizeDelegationWorkspaceKey } from './delegation-workspace-guard.js';

/**
 * @param {string[] | undefined} chatIds
 * @param {string} [dataDir]
 * @returns {void}
 */
export function scheduleWorkspaceWatcherAutopilotFromChatIds(chatIds, dataDir = '') {
  if (!Array.isArray(chatIds) || chatIds.length === 0) return;
  /** @type {Set<string>} */
  const folders = new Set();
  for (const raw of chatIds) {
    const chatId = String(raw ?? '').trim();
    if (!chatId) continue;
    const chat = loadChats().find((row) => row.id === chatId) || null;
    const folder = String(chat?.workspaceFolder ?? '').trim();
    if (folder) folders.add(folder);
  }
  for (const workspaceFolder of folders) {
    scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir });
  }
}

/**
 * @param {string} dataDir
 * @param {string} cwd
 * @param {object | null | undefined} previousDoc
 * @param {object} nextDoc
 * @returns {void}
 */
export function maybeScheduleWorkspaceWatcherAfterTodosSave(dataDir, cwd, previousDoc, nextDoc) {
  const workspaceFolder = String(cwd ?? '').trim();
  if (!workspaceFolder) return;
  const prevItems = Array.isArray(previousDoc?.items) ? previousDoc.items : [];
  const nextItems = Array.isArray(nextDoc?.items) ? nextDoc.items : [];
  if (prevItems.length === 0 && nextItems.length === 0) return;
  /** @type {Map<string, object>} */
  const prevById = new Map(prevItems.map((row) => [String(row?.id ?? ''), row]));
  let shouldNudge = prevItems.length !== nextItems.length;
  if (!shouldNudge) {
    for (const row of nextItems) {
      const id = String(row?.id ?? '');
      const prev = prevById.get(id);
      if (!prev) {
        shouldNudge = true;
        break;
      }
      if (String(prev.status ?? '') !== String(row.status ?? '')) {
        shouldNudge = true;
        break;
      }
      const prevApproved = String(prev.plan?.approvedAt ?? '').trim();
      const nextApproved = String(row.plan?.approvedAt ?? '').trim();
      if (prevApproved !== nextApproved) {
        shouldNudge = true;
        break;
      }
    }
  }
  if (!shouldNudge) return;
  scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir });
}

/**
 * @param {object | null | undefined} previous
 * @param {object | null | undefined} next
 * @param {string} [dataDir]
 * @returns {void}
 */
export function maybeScheduleWorkspaceWatcherAfterDelegationUpdate(previous, next, dataDir = '') {
  if (!next || typeof next !== 'object') return;
  const prevStatus = normalizeDelegationStatus(previous?.status);
  const nextStatus = normalizeDelegationStatus(next.status);
  const becameTerminal = isActiveDelegationStatus(prevStatus) && !isActiveDelegationStatus(nextStatus);
  if (!becameTerminal && prevStatus === nextStatus) return;
  const workspaceFolder = normalizeDelegationWorkspaceKey(next.workspaceFolder || next.workspaceKey);
  if (!workspaceFolder) return;
  scheduleWorkspaceWatcherAutopilot({ workspaceFolder, dataDir });
}
