import { existsSync, statSync, watch } from 'fs';
import path from 'path';

/** @type {Set<import('ws').WebSocket>} */
export const frontBuildClients = new Set();

/** @type {import('fs').FSWatcher|null} */
let frontBuildWatcher = null;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const frontBuildBroadcastTimers = new Map();

/**
 * @param {string} assetType
 * @param {string} file
 * @param {string} serverInstanceToken
 */
function broadcastFrontBuildAssetChange(assetType, file, serverInstanceToken) {
  const payload = JSON.stringify({
    type: 'buildAssetChanged',
    assetType,
    file: file || '',
    serverInstanceToken,
    at: Date.now(),
  });
  for (const client of frontBuildClients) {
    if (client.readyState === 1) client.send(payload);
  }
}

/**
 * @param {string} assetType
 * @param {string} file
 * @param {string} serverInstanceToken
 */
function queueFrontBuildAssetBroadcast(assetType, file, serverInstanceToken) {
  if (!assetType) return;
  if (frontBuildBroadcastTimers.has(assetType)) {
    clearTimeout(frontBuildBroadcastTimers.get(assetType));
  }
  const timer = setTimeout(() => {
    frontBuildBroadcastTimers.delete(assetType);
    broadcastFrontBuildAssetChange(assetType, file, serverInstanceToken);
  }, 250);
  frontBuildBroadcastTimers.set(assetType, timer);
}

/**
 * @param {string} projectRoot
 * @param {string} serverInstanceToken
 */
export function installFrontBuildWatcher(projectRoot, serverInstanceToken) {
  const distDir = path.join(projectRoot, 'public', 'dist', 'app');
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    console.warn('[front-hot] no dist directory to watch:', distDir);
    return;
  }
  try {
    frontBuildWatcher = watch(distDir, { persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      const file = String(filename);
      if (file.endsWith('.css')) {
        queueFrontBuildAssetBroadcast('css', file, serverInstanceToken);
        return;
      }
      if (file.endsWith('.bundle.js')) {
        queueFrontBuildAssetBroadcast('js', file, serverInstanceToken);
      }
    });
    frontBuildWatcher.on('error', (err) => {
      console.warn('[front-hot] watch error:', err?.message || err);
    });
    console.log('[front-hot] watching:', distDir);
  } catch (err) {
    console.warn('[front-hot] failed to start watch:', err?.message || err);
  }
}

/**
 * @param {import('ws').WebSocket} ws
 */
export function handleFrontBuildConnection(ws) {
  frontBuildClients.add(ws);
  ws.on('close', () => frontBuildClients.delete(ws));
}

/** @returns {import('fs').FSWatcher|null} */
export function getFrontBuildWatcher() {
  return frontBuildWatcher;
}
