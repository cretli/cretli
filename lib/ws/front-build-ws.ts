import { existsSync, statSync, watch } from 'fs';
import path from 'path';
import type { FSWatcher } from 'fs';
import type { WebSocket } from 'ws';

export const frontBuildClients = new Set<WebSocket>();

let frontBuildWatcher: FSWatcher | null = null;

const frontBuildBroadcastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function broadcastFrontBuildAssetChange(assetType: string, file: string, serverInstanceToken: string): void {
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

function queueFrontBuildAssetBroadcast(assetType: string, file: string, serverInstanceToken: string): void {
  if (!assetType) return;
  if (frontBuildBroadcastTimers.has(assetType)) {
    clearTimeout(frontBuildBroadcastTimers.get(assetType)!);
  }
  const timer = setTimeout(() => {
    frontBuildBroadcastTimers.delete(assetType);
    broadcastFrontBuildAssetChange(assetType, file, serverInstanceToken);
  }, 250);
  frontBuildBroadcastTimers.set(assetType, timer);
}

export function installFrontBuildWatcher(projectRoot: string, serverInstanceToken: string): void {
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
    frontBuildWatcher.on('error', (err: unknown) => {
      console.warn('[front-hot] watch error:', (err as Error | null)?.message || err);
    });
    console.log('[front-hot] watching:', distDir);
  } catch (err) {
    console.warn('[front-hot] failed to start watch:', (err as Error | null)?.message || err);
  }
}

export function handleFrontBuildConnection(ws: WebSocket): void {
  frontBuildClients.add(ws);
  ws.on('close', () => frontBuildClients.delete(ws));
}

export function getFrontBuildWatcher(): FSWatcher | null {
  return frontBuildWatcher;
}
