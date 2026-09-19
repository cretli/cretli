#!/usr/bin/env node
/**
 * Isolated Cretli process for Phase IIb Playwright tests.
 * Own port and data directory. Does not touch the user's live data/.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number.parseInt(process.env.DELEGATION_PHASE2B_E2E_PORT || '3398', 10);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-phase2b-ui-'));
const wsA = path.join(dataDir, 'ws-a');
const wsB = path.join(dataDir, 'ws-b');
fs.mkdirSync(wsA, { recursive: true });
fs.mkdirSync(wsB, { recursive: true });

const chatA = {
  id: crypto.randomUUID(),
  title: 'Phase2b parent A',
  cursorSessionId: crypto.randomUUID(),
  agentTransport: 'opencode',
  sdkMode: 'agent',
  workspaceFolder: wsA,
  model: 'opencode/test',
  createdAt: new Date().toISOString(),
};
const chatB = {
  id: crypto.randomUUID(),
  title: 'Phase2b parent B',
  cursorSessionId: crypto.randomUUID(),
  agentTransport: 'opencode',
  sdkMode: 'agent',
  workspaceFolder: wsB,
  model: 'opencode/test',
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ chats: [chatA, chatB] }, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CRETLI_DATA_DIR: dataDir,
    CURSOR_REMOTE_DATA_DIR: dataDir,
    PORT: String(port),
    USE_HTTPS: '0',
    CRETLI_BIND: '127.0.0.1',
    // Serve current app_front via webpack-dev-middleware. public/dist may lag
    // the source tree, and a stale bundle omits the Delegations settings tab.
    CRETLI_FRONT_HMR: '1',
    CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
    CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
  },
  stdio: 'inherit',
});

function cleanup() {
  try {
    child.kill('SIGKILL');
  } catch {
    // already gone
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
