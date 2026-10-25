/**
 * In-memory cross-instance diagnostic command queue.
 */

import { isValidClientInstanceId, normalizeClientInstanceIdForFile } from './client-instance-registry.js';

export const CLIENT_INSTANCE_COMMAND_TYPES = Object.freeze([
  'flushLogs',
  'consoleReport',
  'uiSnapshot',
  'ping',
]);

const COMMAND_TTL_MS = 60000;
const MAX_PENDING_PER_TARGET = 10;
const MAX_RESULTS_PER_INSTANCE = 20;

/** @type {Map<string, ClientInstanceCommandRecord[]>} */
const pendingByTarget = new Map();

/** @type {Map<string, ClientInstanceCommandRecord[]>} */
const resultsByInstance = new Map();

/** @type {Map<string, ClientInstanceCommandRecord>} */
const inFlightById = new Map();

/**
 * @typedef {Object} ClientInstanceCommandRecord
 * @property {string} id
 * @property {string} targetId
 * @property {string} fromInstanceId
 * @property {string} type
 * @property {Record<string, unknown>|null} payload
 * @property {number} createdAt
 * @property {'pending' | 'completed' | 'expired'} status
 * @property {number|null} completedAt
 * @property {Record<string, unknown>|null} result
 */

/**
 * @param {string} raw
 * @returns {string}
 */
function sanitizeId(raw) {
  return normalizeClientInstanceIdForFile(raw);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeCommandType(value) {
  const type = String(value || '').trim();
  if (CLIENT_INSTANCE_COMMAND_TYPES.includes(type)) return type;
  return '';
}

/**
 * @returns {string}
 */
function createCommandId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {number} [now]
 */
export function pruneExpiredClientInstanceCommands(now = Date.now()) {
  for (const [targetId, queue] of pendingByTarget.entries()) {
    const next = queue.filter((command) => now - command.createdAt <= COMMAND_TTL_MS);
    if (next.length) pendingByTarget.set(targetId, next);
    else pendingByTarget.delete(targetId);
  }
  for (const [commandId, command] of inFlightById.entries()) {
    if (now - command.createdAt > COMMAND_TTL_MS) inFlightById.delete(commandId);
  }
}

/**
 * @param {string} targetId
 * @param {string} fromInstanceId
 * @param {string} type
 * @param {Record<string, unknown>|null} [payload]
 * @param {number} [now]
 * @returns {ClientInstanceCommandRecord|null}
 */
export function enqueueClientInstanceCommand(
  targetId,
  fromInstanceId,
  type,
  payload = null,
  now = Date.now()
) {
  pruneExpiredClientInstanceCommands(now);
  const target = sanitizeId(targetId);
  const from = sanitizeId(fromInstanceId);
  const normalizedType = normalizeCommandType(type);
  if (!isValidClientInstanceId(target) || !isValidClientInstanceId(from) || !normalizedType) return null;
  const queue = pendingByTarget.get(target) || [];
  if (queue.length >= MAX_PENDING_PER_TARGET) return null;
  /** @type {ClientInstanceCommandRecord} */
  const command = {
    id: createCommandId(),
    targetId: target,
    fromInstanceId: from,
    type: normalizedType,
    payload: payload && typeof payload === 'object' ? payload : null,
    createdAt: now,
    status: 'pending',
    completedAt: null,
    result: null,
  };
  queue.push(command);
  pendingByTarget.set(target, queue);
  return command;
}

/**
 * @param {string} targetId
 * @param {number} [now]
 * @returns {ClientInstanceCommandRecord[]}
 */
export function dequeueClientInstanceCommands(targetId, now = Date.now()) {
  pruneExpiredClientInstanceCommands(now);
  const target = sanitizeId(targetId);
  if (!isValidClientInstanceId(target)) return [];
  const queue = pendingByTarget.get(target) || [];
  if (!queue.length) return [];
  pendingByTarget.delete(target);
  const delivered = queue.map((command) => ({ ...command }));
  for (const command of delivered) {
    inFlightById.set(command.id, { ...command, status: 'pending' });
  }
  return delivered;
}

/**
 * @param {string} commandId
 * @param {Record<string, unknown>|null} result
 * @param {number} [now]
 * @returns {ClientInstanceCommandRecord|null}
 */
export function completeClientInstanceCommand(commandId, result = null, now = Date.now()) {
  const id = String(commandId || '').trim();
  if (!id) return null;
  const inFlight = inFlightById.get(id);
  if (inFlight) {
    inFlightById.delete(id);
    /** @type {ClientInstanceCommandRecord} */
    const completed = {
      ...inFlight,
      status: 'completed',
      completedAt: now,
      result: result && typeof result === 'object' ? result : null,
    };
    pushCommandResult(completed);
    return completed;
  }
  for (const [targetId, queue] of pendingByTarget.entries()) {
    const index = queue.findIndex((command) => command.id === id);
    if (index === -1) continue;
    const [command] = queue.splice(index, 1);
    if (!queue.length) pendingByTarget.delete(targetId);
    else pendingByTarget.set(targetId, queue);
    /** @type {ClientInstanceCommandRecord} */
    const completed = {
      ...command,
      status: 'completed',
      completedAt: now,
      result: result && typeof result === 'object' ? result : null,
    };
    pushCommandResult(completed);
    return completed;
  }
  return null;
}

/**
 * @param {ClientInstanceCommandRecord} command
 */
function pushCommandResult(command) {
  const targetId = sanitizeId(command.targetId);
  if (!targetId) return;
  const existing = resultsByInstance.get(targetId) || [];
  existing.unshift({
    id: command.id,
    type: command.type,
    fromInstanceId: command.fromInstanceId,
    createdAt: command.createdAt,
    completedAt: command.completedAt,
    status: command.status,
    result: command.result,
  });
  resultsByInstance.set(targetId, existing.slice(0, MAX_RESULTS_PER_INSTANCE));
}

/**
 * @param {string} targetId
 * @param {number} [limit]
 * @returns {Array<Record<string, unknown>>}
 */
export function listClientInstanceCommandResults(targetId, limit = 10) {
  const target = sanitizeId(targetId);
  if (!isValidClientInstanceId(target)) return [];
  const rows = resultsByInstance.get(target) || [];
  const safeLimit = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), MAX_RESULTS_PER_INSTANCE) : 10;
  return rows.slice(0, safeLimit);
}

/**
 * @param {string} commandId
 * @returns {ClientInstanceCommandRecord|null}
 */
export function getClientInstanceCommand(commandId) {
  const id = String(commandId || '').trim();
  if (!id) return null;
  const inFlight = inFlightById.get(id);
  if (inFlight) return { ...inFlight };
  for (const queue of pendingByTarget.values()) {
    const found = queue.find((command) => command.id === id);
    if (found) return { ...found };
  }
  for (const rows of resultsByInstance.values()) {
    const found = rows.find((command) => command.id === id);
    if (found) {
      return {
        id: found.id,
        targetId: '',
        fromInstanceId: found.fromInstanceId,
        type: found.type,
        payload: null,
        createdAt: found.createdAt,
        status: 'completed',
        completedAt: found.completedAt,
        result: found.result,
      };
    }
  }
  return null;
}

/**
 * Resets command stores (tests only).
 */
export function resetClientInstanceCommandsForTests() {
  pendingByTarget.clear();
  resultsByInstance.clear();
  inFlightById.clear();
}
