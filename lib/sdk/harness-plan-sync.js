/**
 * Capture Plan-mode Markdown from harness WS events and persist like Cursor SDK.
 */

import { randomUUID } from 'crypto';
import { extractAssistantPlainText } from '../context-compression.js';
import { pickRicherPlanMarkdown } from '../chat-plan-persist.js';
import { syncTodoAfterSdkRunFinished } from '../todo-plan-sync.js';
import {
  accumulateStreamText,
  extractPlanTextFromSdkEvent,
} from './sdk-plan-text.js';

/**
 * @param {unknown} deps
 * @returns {string}
 */
export function readTodoSyncDataDir(deps) {
  return String(deps?.todoSyncDataDir || '').trim();
}

/**
 * @param {any} room
 * @param {unknown} dataDirOrDeps
 * @returns {void}
 */
export function bindHarnessPlanSync(room, dataDirOrDeps) {
  if (!room) return;
  if (dataDirOrDeps && typeof dataDirOrDeps === 'object') {
    const fromDeps = readTodoSyncDataDir(dataDirOrDeps);
    if (fromDeps) room._todoSyncDataDir = fromDeps;
    return;
  }
  const dataDir = String(dataDirOrDeps || '').trim();
  if (dataDir) room._todoSyncDataDir = dataDir;
}

/**
 * @param {any} room
 * @returns {void}
 */
export function resetHarnessPlanCapture(room) {
  if (!room) return;
  room._currentRunAssistantText = '';
  room._currentRunPlanMarkdown = '';
  room._planCaptureTurnId = '';
}

/**
 * @param {any} room
 * @param {unknown} event
 * @returns {void}
 */
export function captureHarnessPlanFromSdkEvent(room, event) {
  if (!room || !event || typeof event !== 'object') return;
  const planText = extractPlanTextFromSdkEvent(event);
  if (planText) {
    room._currentRunPlanMarkdown = pickRicherPlanMarkdown(room._currentRunPlanMarkdown, planText);
  }
  const assistantText = extractAssistantPlainText(event).trim();
  if (!assistantText) return;
  room._currentRunAssistantText = accumulateStreamText(
    room._currentRunAssistantText,
    assistantText
  );
}

/**
 * @param {any} room
 * @param {unknown} payload
 * @returns {void}
 */
export function noteHarnessWsPayloadForPlanSync(room, payload) {
  if (!room || !payload || typeof payload !== 'object') return;
  const record = /** @type {Record<string, unknown>} */ (payload);
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'sdkPromptStarted') {
    resetHarnessPlanCapture(room);
    const runId = typeof record.runId === 'string' ? record.runId.trim() : '';
    room._planCaptureTurnId = runId || randomUUID();
    return;
  }
  if (type === 'sdkEvent') {
    captureHarnessPlanFromSdkEvent(room, record.event);
    return;
  }
  if (type !== 'sdkRunFinished') return;
  const dataDir = String(room._todoSyncDataDir || '').trim();
  if (!dataDir) return;
  try {
    syncTodoAfterSdkRunFinished({
      dataDir,
      chatId: room.chatId,
      status: typeof record.status === 'string' ? record.status : '',
      sdkMode: room.sdkMode,
      room,
    });
  } catch {
    // persist never breaks the run
  }
}
