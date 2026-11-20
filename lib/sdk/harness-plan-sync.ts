/**
 * Capture Plan-mode Markdown from harness WS events and persist like Cursor SDK.
 */

import { randomUUID } from 'crypto';
import { pickRicherPlanMarkdown } from '../chat-plan-persist.js';
import { syncTodoAfterSdkRunFinished } from '../todo-plan-sync.js';
import { resetSdkRunToolActivity } from './sdk-run-tool-activity.ts';
import {
  extractPlanTextFromSdkEvent,
  noteRoomRunAssistantStreamEvent,
  resetRoomRunAssistantStreamCapture,
} from './sdk-plan-text.ts';

/**
 * @param {unknown} deps
 * @returns {string}
 */
export function readTodoSyncDataDir(deps: unknown): string {
  const record = deps as { todoSyncDataDir?: unknown } | null | undefined;
  return String(record?.todoSyncDataDir || '').trim();
}

/**
 * @param {any} room
 * @param {unknown} dataDirOrDeps
 * @returns {void}
 */
export function bindHarnessPlanSync(room: any, dataDirOrDeps: unknown): void {
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
export function resetHarnessPlanCapture(room: any): void {
  if (!room) return;
  resetRoomRunAssistantStreamCapture(room);
  room._currentRunPlanMarkdown = '';
  room._planCaptureTurnId = '';
  resetSdkRunToolActivity(room);
}

/**
 * @param {any} room
 * @param {unknown} event
 * @returns {void}
 */
export function captureHarnessPlanFromSdkEvent(room: any, event: unknown): void {
  if (!room || !event || typeof event !== 'object') return;
  const planText = extractPlanTextFromSdkEvent(event);
  if (planText) {
    room._currentRunPlanMarkdown = pickRicherPlanMarkdown(room._currentRunPlanMarkdown, planText);
  }
  noteRoomRunAssistantStreamEvent(room, event);
}

/**
 * @param {any} room
 * @param {unknown} payload
 * @returns {Promise<void> | void} the (never rejecting) todo-plan sync of a finished run; callers on the hot path ignore it
 */
export function noteHarnessWsPayloadForPlanSync(room: any, payload: unknown): Promise<void> | void {
  if (!room || !payload || typeof payload !== 'object') return;
  const record = payload as Record<string, unknown>;
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
  // Asynchronous (waits for the room's history commit); a failure never breaks the run.
  return Promise.resolve()
    .then(() => syncTodoAfterSdkRunFinished({
      dataDir,
      chatId: room.chatId,
      status: typeof record.status === 'string' ? record.status : '',
      sdkMode: room.sdkMode,
      room,
    }))
    .then(() => undefined, () => undefined);
}
