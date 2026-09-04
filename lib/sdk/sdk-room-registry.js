import { readEnvAlias } from '../env-alias.js';
/**
 * Redis-backed SDK room owner registry (sessionKey → instanceId).
 * Used with sticky sessions so only the owner runs the Agent; other instances
 * serve lightweight remote stubs fed by pub-sub.
 */

import { getServerInstanceId } from './sdk-instance-id.js';

const REDIS_OWNER_KEY_PREFIX = 'cretli:sdk-room-owner:';
const DEFAULT_OWNER_TTL_SEC = 120;

/** @type {import('redis').RedisClientType | null} */
let redisKvClient = null;
let registryMode = 'local';

/**
 * @returns {number}
 */
export function resolveSdkRoomOwnerTtlSec() {
  const raw = readEnvAlias({ current: 'CRETLI_SDK_ROOM_OWNER_TTL_SEC', legacy: 'CURSOR_REMOTE_SDK_ROOM_OWNER_TTL_SEC' });
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 30) {
    return Math.floor(parsed);
  }
  return DEFAULT_OWNER_TTL_SEC;
}

/**
 * @param {string} sessionKey
 * @returns {string}
 */
function ownerKeyForSession(sessionKey) {
  return `${REDIS_OWNER_KEY_PREFIX}${sessionKey}`;
}

/**
 * @param {import('redis').RedisClientType} client
 */
export function initSdkRoomRegistry(client) {
  redisKvClient = client && client.isOpen === true ? client : null;
  registryMode = redisKvClient ? 'redis' : 'local';
}

/**
 * @returns {'local' | 'redis'}
 */
export function getSdkRoomRegistryMode() {
  return registryMode;
}

/**
 * @param {unknown} raw
 * @returns {{
 *   instanceId: string,
 *   eventStreamId?: string,
 *   eventSeq?: number,
 *   busy?: boolean,
 *   updatedAt?: number,
 * } | null}
 */
export function parseSdkRoomOwnerRecord(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const instanceId =
    typeof parsed.instanceId === 'string' && parsed.instanceId.trim()
      ? parsed.instanceId.trim()
      : '';
  if (!instanceId) return null;
  const eventStreamId =
    typeof parsed.eventStreamId === 'string' && parsed.eventStreamId.trim()
      ? parsed.eventStreamId.trim()
      : undefined;
  const eventSeq = Number(parsed.eventSeq);
  const updatedAt = Number(parsed.updatedAt);
  return {
    instanceId,
    eventStreamId,
    eventSeq: Number.isSafeInteger(eventSeq) && eventSeq >= 0 ? eventSeq : undefined,
    busy: parsed.busy === true,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
  };
}

/**
 * @param {string} sessionKey
 * @returns {Promise<ReturnType<typeof parseSdkRoomOwnerRecord>>}
 */
export async function lookupSdkRoomOwner(sessionKey) {
  if (!sessionKey || !redisKvClient) return null;
  try {
    const raw = await redisKvClient.get(ownerKeyForSession(sessionKey));
    return parseSdkRoomOwnerRecord(raw);
  } catch (err) {
    console.warn('[sdk-room-registry] lookup failed:', err?.message || err);
    return null;
  }
}

/**
 * @param {any} room
 * @returns {Record<string, unknown>}
 */
export function buildSdkRoomOwnerMeta(room) {
  const eventStreamId =
    typeof room?.eventStreamId === 'string' && room.eventStreamId.trim()
      ? room.eventStreamId.trim()
      : '';
  const eventSeq = Number.isFinite(room?.eventSeq) ? Number(room.eventSeq) : 0;
  return {
    instanceId: getServerInstanceId(),
    eventStreamId: eventStreamId || undefined,
    eventSeq: Number.isSafeInteger(eventSeq) && eventSeq >= 0 ? eventSeq : 0,
    busy: !!room?.busy,
    updatedAt: Date.now(),
  };
}

/**
 * @param {string} sessionKey
 * @param {Record<string, unknown>} [meta]
 * @returns {Promise<boolean>}
 */
export async function registerSdkRoomOwner(sessionKey, meta = {}) {
  if (!sessionKey || !redisKvClient) return true;
  const payload = {
    ...meta,
    instanceId: getServerInstanceId(),
    updatedAt: Date.now(),
  };
  const value = JSON.stringify(payload);
  const ttlSec = resolveSdkRoomOwnerTtlSec();
  const key = ownerKeyForSession(sessionKey);
  try {
    const created = await redisKvClient.set(key, value, { EX: ttlSec, NX: true });
    if (created === 'OK') return true;
    const current = await lookupSdkRoomOwner(sessionKey);
    if (current?.instanceId !== getServerInstanceId()) return false;
    await redisKvClient.set(key, value, { EX: ttlSec });
    return true;
  } catch (err) {
    console.warn('[sdk-room-registry] register failed:', err?.message || err);
    return false;
  }
}

/**
 * @param {string} sessionKey
 * @param {Record<string, unknown>} [meta]
 * @returns {Promise<boolean>}
 */
export async function refreshSdkRoomOwner(sessionKey, meta = {}) {
  if (!sessionKey || !redisKvClient) return true;
  const current = await lookupSdkRoomOwner(sessionKey);
  if (current?.instanceId && current.instanceId !== getServerInstanceId()) {
    return false;
  }
  const payload = {
    ...(current || {}),
    ...meta,
    instanceId: getServerInstanceId(),
    updatedAt: Date.now(),
  };
  const value = JSON.stringify(payload);
  const ttlSec = resolveSdkRoomOwnerTtlSec();
  try {
    await redisKvClient.set(ownerKeyForSession(sessionKey), value, { EX: ttlSec });
    return true;
  } catch (err) {
    console.warn('[sdk-room-registry] refresh failed:', err?.message || err);
    return false;
  }
}

/**
 * @param {string} sessionKey
 * @returns {Promise<void>}
 */
export async function unregisterSdkRoomOwner(sessionKey) {
  if (!sessionKey || !redisKvClient) return;
  try {
    const current = await lookupSdkRoomOwner(sessionKey);
    if (current?.instanceId !== getServerInstanceId()) return;
    await redisKvClient.del(ownerKeyForSession(sessionKey));
  } catch (err) {
    console.warn('[sdk-room-registry] unregister failed:', err?.message || err);
  }
}

/**
 * @param {string} sessionKey
 * @returns {Promise<boolean>}
 */
export async function isLocalSdkRoomOwner(sessionKey) {
  if (!sessionKey) return true;
  if (!redisKvClient) return true;
  const owner = await lookupSdkRoomOwner(sessionKey);
  if (!owner?.instanceId) return true;
  return owner.instanceId === getServerInstanceId();
}
