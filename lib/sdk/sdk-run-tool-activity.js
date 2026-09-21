/**
 * Track in-flight native tool_call events on a harness room so idle watchdogs
 * do not cancel a run that is still executing tools.
 */

import { parseToolPresenceActivity } from '../agent-presence-activity.js';
import {
  clearChatPresenceActivity,
  markAgentPresenceDirty,
  setChatPresenceActivity,
} from '../agent-presence-hooks.js';

const OPEN_TOOL_STATUSES = new Set(['running', 'pending', 'in_progress', 'started']);

/**
 * @param {unknown} event
 * @returns {string}
 */
function readToolActivityId(event) {
  if (!event || typeof event !== 'object') return '';
  const rec = /** @type {Record<string, unknown>} */ (event);
  const keys = ['call_id', 'callId', 'requestId', 'toolCallId', 'id'];
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  return name ? `name:${name}` : '';
}

/**
 * @param {Record<string, unknown>} rec
 * @param {string} type
 * @returns {boolean}
 */
function isOpenToolEvent(rec, type) {
  if (type === 'tool_result') return false;
  const status = String(rec.status || '').toLowerCase();
  if (!status) return type === 'tool_call' || type === 'tool_use';
  return OPEN_TOOL_STATUSES.has(status);
}

/**
 * @param {any} room
 */
export function resetSdkRunToolActivity(room) {
  if (!room || typeof room !== 'object') return;
  room._openSdkToolCallIds = new Set();
  if (room.chatId) {
    clearChatPresenceActivity(room.chatId);
    markAgentPresenceDirty([room.chatId]);
  }
}

/**
 * @param {any} room
 * @param {unknown} event
 */
export function noteSdkRunToolActivity(room, event) {
  if (!room || typeof room !== 'object' || !event || typeof event !== 'object') return;
  const rec = /** @type {Record<string, unknown>} */ (event);
  const type = String(rec.type || '').toLowerCase();
  if (type !== 'tool_call' && type !== 'tool_use' && type !== 'tool_result') return;
  if (!(room._openSdkToolCallIds instanceof Set)) room._openSdkToolCallIds = new Set();
  const id = readToolActivityId(rec);
  if (!id) return;
  if (isOpenToolEvent(rec, type)) {
    room._openSdkToolCallIds.add(id);
    const activity = parseToolPresenceActivity(rec);
    if (activity && room.chatId) {
      setChatPresenceActivity(room.chatId, activity);
      markAgentPresenceDirty([room.chatId]);
    }
    return;
  }
  room._openSdkToolCallIds.delete(id);
  if (room.chatId && room._openSdkToolCallIds.size === 0) {
    clearChatPresenceActivity(room.chatId);
    markAgentPresenceDirty([room.chatId]);
  }
}

/**
 * @param {any} room
 * @returns {boolean}
 */
export function hasOpenSdkRunTools(room) {
  const ids = room?._openSdkToolCallIds;
  return ids instanceof Set && ids.size > 0;
}
