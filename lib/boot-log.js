/**
 * Startup console lines after HTTP listen.
 */

import { existsSync } from 'fs';
import path from 'path';
import { hasOpenCodeCredentials } from './opencode/opencode-api-key.js';
import { resolveDataPath } from './runtime-paths.js';
import { isAuthConfigured, isLanExposed } from './auth.js';
import { getLanHost } from './lan-host.js';
import { getSdkRoomRegistryMode } from './sdk/sdk-room-registry.js';

/**
 * @param {{
 *   protocol: string,
 *   port: number,
 *   bindHost: string,
 *   useHttps: boolean,
 *   projectRoot: string,
 *   frontHmrEnabled: boolean,
 *   seededRevisionCount: number,
 *   sdkRoomTransport?: { mode?: string } | null,
 *   clientDebugLogPath: string,
 *   agentCallbackToken: string,
 *   getCurrentWorkspace: () => { folders?: Array<{ name: string }> } | null,
 *   getCurrentCwd: () => string,
 * }} options
 */
export function logServerReady(options) {
  const {
    protocol,
    port,
    bindHost,
    useHttps,
    projectRoot,
    frontHmrEnabled,
    seededRevisionCount,
    sdkRoomTransport,
    clientDebugLogPath,
    agentCallbackToken,
    getCurrentWorkspace,
    getCurrentCwd,
  } = options;
  console.log(`Cretli: ${protocol}://localhost:${port}`);
  if (seededRevisionCount > 0) console.log(`  Chat history revisions seeded: ${seededRevisionCount}`);
  if (sdkRoomTransport?.mode === 'redis') {
    console.log('  SDK room bus: Redis pub-sub enabled');
    console.log(`  SDK room registry: ${getSdkRoomRegistryMode()}`);
  }
  if (isLanExposed()) {
    const lan = getLanHost();
    if (lan) console.log(`  on LAN: ${protocol}://${lan}:${port}`);
    if (!isAuthConfigured()) {
      console.warn('  ⚠️  LAN bind with no password — first-run /login requires CRETLI_SETUP_TOKEN.');
    }
    if (!agentCallbackToken) {
      console.warn('  ⚠️  AGENT_CALLBACK_TOKEN not set — external agent callbacks (from LAN) are rejected. Localhost callbacks (auto chat title) work without a token.');
    }
  } else {
    console.log(`  Listening on: ${bindHost} (local-only bind). For LAN: CRETLI_BIND=0.0.0.0 (legacy: CURSOR_REMOTE_BIND)`);
  }
  if (!useHttps) {
    console.log('  (HTTPS: set USE_HTTPS=1 and add data/key.pem, data/cert.pem — required e.g. for phone dictation)');
  }
  if (!frontHmrEnabled && !existsSync(path.join(projectRoot, 'public', 'dist', 'app', 'index.bundle.js'))) {
    console.warn('  ⚠️  Frontend not built — the page will be blank. Run: npm run build:front:prod');
  }
  if (!isAuthConfigured()) console.log('  Auth: no password set — open /login to set one (setup).');
  else console.log('  Auth: enabled (password set).');
  console.log('Chats:', resolveDataPath('chats.json'));
  console.log('Client logs (debugRemote):', clientDebugLogPath);
  console.log('Settings (LAN):', resolveDataPath('config.json'));
  if (hasOpenCodeCredentials()) {
    void import('./opencode/opencode-server-manager.js')
      .then(({ warmUpOpenCodeFromSettings }) => warmUpOpenCodeFromSettings())
      .then((result) => {
        if (result?.skipped) return;
        if (result?.ok) {
          console.log('  OpenCode: warm-up ready');
          return;
        }
        console.warn('  OpenCode: warm-up pending —', result?.error || 'not ready yet');
      })
      .catch((err) => {
        console.warn('  OpenCode: warm-up failed —', err?.message || err);
      });
  }
  const ws = getCurrentWorkspace();
  console.log('Workspace CWD:', getCurrentCwd());
  if (ws) console.log('Folders:', ws.folders.map((f) => f.name).join(', '));
  else console.log('(no workspace file — set WORKSPACE_FILE or pick one in the app)');
}
