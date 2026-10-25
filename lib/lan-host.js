/**
 * LAN hostname for the in-app link/QR (env → settings → first IPv4).
 */

import os from 'os';
import { readEnvAlias } from './env-alias.js';
import { loadSettings } from './persist/settings.js';

/**
 * @returns {string | null}
 */
export function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return null;
}

/**
 * Order: env → data/config.json → detected IP.
 * On WSL detection is 172.x — set config or LAN_HOST.
 *
 * @returns {string | null}
 */
export function getLanHost() {
  const env = process.env.LAN_HOST || readEnvAlias({
    current: 'CRETLI_LAN_HOST',
    legacy: 'CURSOR_REMOTE_LAN_HOST',
  });
  if (env && env.trim()) return env.trim();
  const settings = loadSettings();
  if (settings.lanHost && settings.lanHost.trim()) return settings.lanHost.trim();
  return getLocalIP();
}
