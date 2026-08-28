import { getServerInstanceId } from '../sdk/sdk-instance-id.js';
import { getSdkRoomBusMode } from '../sdk/sdk-room-bus.js';
import { getSdkRoomRegistryMode } from '../sdk/sdk-room-registry.js';

/**
 * @typedef {Object} HealthRoutesContext
 * @property {string} serverInstanceToken
 * @property {number} serverStartedAt
 */

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
      sdkRoomBus: getSdkRoomBusMode(),
      sdkRoomRegistry: getSdkRoomRegistryMode(),
    });
  });
}
