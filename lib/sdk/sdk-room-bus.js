/**
 * Optional Redis pub-sub bus for SDK room events across Node instances.
 * Falls back to local-only mode when CRETLI_REDIS_URL is unset or redis is unavailable.
 */

import { getServerInstanceId } from './sdk-instance-id.js';
import { readEnvAlias } from '../env-alias.js';
import { initSdkRoomRegistry } from './sdk-room-registry.js';

export { getServerInstanceId } from './sdk-instance-id.js';

const REDIS_CHANNEL_PREFIX = 'cretli:sdk-room:';

let redisPublisher = null;
let redisSubscriber = null;
let initialized = false;

/** @type {(sessionKey: string, payload: Record<string, unknown>) => void | null} */
let remoteEventHandler = null;

/**
 * @param {string} sessionKey
 * @returns {string}
 */
function channelForSession(sessionKey) {
  return `${REDIS_CHANNEL_PREFIX}${sessionKey}`;
}

/**
 * @param {string} sessionKey
 * @param {string} rawMessage
 */
function handleRedisMessage(sessionKey, rawMessage) {
  if (!sessionKey || !rawMessage) return;
  let parsed = null;
  try {
    parsed = JSON.parse(rawMessage);
  } catch (err) {
    console.warn('[sdk-room-bus] failed to parse Redis message:', err?.message || err);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  if (parsed.originInstanceId === getServerInstanceId()) return;
  const payload =
    parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
  if (!payload) return;
  if (typeof remoteEventHandler === 'function') {
    remoteEventHandler(sessionKey, payload);
  }
}

/**
 * @param {{ onRemoteEvent?: (sessionKey: string, payload: Record<string, unknown>) => void }} [options]
 * @returns {Promise<{ mode: 'local' | 'redis', error?: string }>}
 */
export async function initSdkRoomBus(options = {}) {
  if (initialized) {
    return { mode: redisPublisher ? 'redis' : 'local' };
  }
  initialized = true;
  getServerInstanceId();
  remoteEventHandler =
    typeof options.onRemoteEvent === 'function' ? options.onRemoteEvent : null;

  const redisUrl = readEnvAlias({
    current: 'CRETLI_REDIS_URL',
    legacy: 'CURSOR_REMOTE_REDIS_URL',
  }).trim();
  if (!redisUrl) {
    return { mode: 'local' };
  }

  try {
    const redisModule = await import('redis');
    const createClient = redisModule.createClient || redisModule.default?.createClient;
    if (typeof createClient !== 'function') {
      throw new Error('redis package does not export createClient');
    }
    redisPublisher = createClient({ url: redisUrl });
    redisSubscriber = redisPublisher.duplicate();
    redisPublisher.on('error', (err) => {
      console.warn('[sdk-room-bus] publisher error:', err?.message || err);
    });
    redisSubscriber.on('error', (err) => {
      console.warn('[sdk-room-bus] subscriber error:', err?.message || err);
    });
    await redisPublisher.connect();
    await redisSubscriber.connect();
    initSdkRoomRegistry(redisPublisher);
    await redisSubscriber.pSubscribe(`${REDIS_CHANNEL_PREFIX}*`, (message, channel) => {
      const prefix = REDIS_CHANNEL_PREFIX;
      const sessionKey =
        typeof channel === 'string' && channel.startsWith(prefix)
          ? channel.slice(prefix.length)
          : '';
      handleRedisMessage(sessionKey, message);
    });
    console.log('[sdk-room-bus] Redis pub-sub enabled');
    return { mode: 'redis' };
  } catch (err) {
    redisPublisher = null;
    redisSubscriber = null;
    const message = err?.message || String(err);
    console.warn('[sdk-room-bus] Redis unavailable, using local-only mode:', message);
    return { mode: 'local', error: message };
  }
}

/**
 * @param {string} sessionKey
 * @param {Record<string, unknown>} payload
 */
export function publishSdkRoomEvent(sessionKey, payload) {
  if (!sessionKey || !payload || typeof payload !== 'object') return;
  if (!redisPublisher || redisPublisher.isOpen !== true) return;
  const message = JSON.stringify({
    originInstanceId: getServerInstanceId(),
    payload,
    at: Date.now(),
  });
  void redisPublisher.publish(channelForSession(sessionKey), message).catch((err) => {
    console.warn('[sdk-room-bus] publish failed:', err?.message || err);
  });
}

/**
 * @returns {Promise<void>}
 */
export async function shutdownSdkRoomBus() {
  const closeClient = async (client) => {
    if (!client) return;
    try {
      if (client.isOpen) {
        await client.quit();
      }
    } catch {
      try {
        client.disconnect();
      } catch {
        // ignore shutdown errors
      }
    }
  };
  await closeClient(redisSubscriber);
  await closeClient(redisPublisher);
  redisSubscriber = null;
  redisPublisher = null;
  initialized = false;
}

/**
 * @returns {'local' | 'redis'}
 */
export function getSdkRoomBusMode() {
  return redisPublisher ? 'redis' : 'local';
}
