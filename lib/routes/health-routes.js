import { getServerInstanceId } from '../sdk/sdk-instance-id.js';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.js';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.js';

/**
 * @typedef {Object} HealthRoutesContext
 * @property {string} serverInstanceToken
 * @property {number} serverStartedAt
 * @property {() => string} [getFrontAssetVersion]
 */

/**
 * @param {HealthRoutesContext} ctx
 * @returns {string}
 */
function readFrontAssetVersion(ctx) {
  if (typeof ctx.getFrontAssetVersion !== 'function') return '';
  try {
    const version = ctx.getFrontAssetVersion();
    if (typeof version === 'string') return version.trim();
    if (version == null) return '';
    return String(version);
  } catch {
    return '';
  }
}

/**
 * @param {import('express').Express} app
 * @param {HealthRoutesContext} ctx
 */
export function registerHealthRoutes(app, ctx) {
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      serverInstanceToken: ctx.serverInstanceToken,
      serverInstanceId: getServerInstanceId(),
      startedAt: ctx.serverStartedAt,
      frontAssetVersion: readFrontAssetVersion(ctx),
      sdkRoomBus: getSdkRoomBusMode(),
      sdkRoomRegistry: getSdkRoomRegistryMode(),
    });
  });
}
