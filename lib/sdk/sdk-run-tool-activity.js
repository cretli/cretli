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
 * @returns {Map<string, { activityKey: string, activityArg: string } | null>}
 */
function openToolActivities(room) {
  if (!(room._openSdkToolActivities instanceof Map)) room._openSdkToolActivities = new Map();
  return room._openSdkToolActivities;
}

/**
 * Last still-open tool that maps to a sidebar activity. Unknown tools stay null
 * so the chip falls back to the generic working icon.
 *
 * @param {Map<string, { activityKey: string, activityArg: string } | null>} activities
 * @returns {{ activityKey: string, activityArg: string } | null}
 */
function latestOpenActivity(activities) {
  let latest = null;
  for (const activity of activities.values()) {
    if (activity?.activityKey) latest = activity;
  }
  return latest;
}

/**
 * @param {any} room
 * @param {{ activityKey: string, activityArg?: string } | null} activity
 * @returns {void}
 */
function publishPresenceActivity(room, activity) {
  if (!room?.chatId) return;
  const key = typeof activity?.activityKey === 'string' ? activity.activityKey : '';
  const arg = typeof activity?.activityArg === 'string' ? activity.activityArg : '';
  if (room._presenceActivityKey === key && room._presenceActivityArg === arg) return;
  room._presenceActivityKey = key;
  room._presenceActivityArg = arg;
  if (!key) clearChatPresenceActivity(room.chatId);
  else setChatPresenceActivity(room.chatId, { activityKey: key, activityArg: arg });
  markAgentPresenceDirty([room.chatId]);
}

/**
 * @param {any} room
 */
export function resetSdkRunToolActivity(room) {
  if (!room || typeof room !== 'object') return;
  room._openSdkToolCallIds = new Set();
  room._openSdkToolActivities = new Map();
  // A fresh run restarts the completed-tool-call tally used for delegation
  // metrics (`lib/delegation-metrics.js`); the open set is the idle guard, this
  // counter counts every `tool_result` seen since the run began.
  room._toolCallsTotal = 0;
  publishPresenceActivity(room, null);
}

/**
 * @param {any} room
 * @param {unknown} event
 */
export function noteSdkRunToolActivity(room, event) {
  if (!room || typeof room !== 'object' || !event || typeof event !== 'object') return;
  const rec = /** @type {Record<string, unknown>} */ (event);
  const type = String(rec.type || '').toLowerCase();
  if (!(room._openSdkToolCallIds instanceof Set)) room._openSdkToolCallIds = new Set();
  if (type === 'thinking') {
    if (room._openSdkToolCallIds.size > 0) return;
    publishPresenceActivity(room, { activityKey: 'thinking', activityArg: '' });
    return;
  }
  if (type !== 'tool_call' && type !== 'tool_use' && type !== 'tool_result') return;
  if (type === 'tool_result') {
    room._toolCallsTotal = (Number.isFinite(room._toolCallsTotal) ? room._toolCallsTotal : 0) + 1;
  }
  const id = readToolActivityId(rec);
  if (!id) return;
  const activities = openToolActivities(room);
  if (isOpenToolEvent(rec, type)) {
    room._openSdkToolCallIds.add(id);
    activities.delete(id);
    activities.set(id, parseToolPresenceActivity(rec));
    publishPresenceActivity(room, latestOpenActivity(activities));
    return;
  }
  room._openSdkToolCallIds.delete(id);
  activities.delete(id);
  publishPresenceActivity(room, latestOpenActivity(activities));
}

/**
 * @param {any} room
 * @returns {boolean}
 */
export function hasOpenSdkRunTools(room) {
  const ids = room?._openSdkToolCallIds;
  return ids instanceof Set && ids.size > 0;
}
