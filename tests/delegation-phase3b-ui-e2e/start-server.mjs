#!/usr/bin/env node
/**
 * Isolated Cretli process for Phase IIIb Playwright (HMR=0, old then one-shot dist).
 * Own port, data directory, and public dir. Does not touch live public/dist.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number.parseInt(process.env.DELEGATION_PHASE3B_E2E_PORT || '3399', 10);
const liveBundle = path.join(projectRoot, 'public', 'dist', 'app', 'index.bundle.js');
const liveMtime = fs.existsSync(liveBundle) ? fs.statSync(liveBundle).mtimeMs : 0;
const liveHead = fs.existsSync(liveBundle) ? fs.readFileSync(liveBundle).subarray(0, 80).toString('utf8') : '';

const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-phase3b-ui-'));
const publicDir = path.join(isolatedRoot, 'public');
const outDir = path.join(publicDir, 'dist', 'app');
const dataDir = path.join(isolatedRoot, 'data');
const wsA = path.join(dataDir, 'ws-a');
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(wsA, { recursive: true });
fs.copyFileSync(path.join(projectRoot, 'public', 'index.html'), path.join(publicDir, 'index.html'));
if (fs.existsSync(path.join(projectRoot, 'public', 'login.html'))) {
  fs.copyFileSync(path.join(projectRoot, 'public', 'login.html'), path.join(publicDir, 'login.html'));
}
fs.writeFileSync(path.join(outDir, 'index.bundle.js'), '/* stale dist without settings delegations */\n', 'utf8');

const webpackBin = path.join(projectRoot, 'node_modules', '.bin', 'webpack');
const built = spawnSync(webpackBin, [
  '--config', 'webpack.dev.js',
  '--no-watch',
  '--output-path', outDir,
], {
  cwd: path.join(projectRoot, 'app_front'),
  env: {
    ...process.env,
    CRETLI_FRONT_HMR: '0',
    CURSOR_REMOTE_FRONT_HMR: '0',
  },
  encoding: 'utf8',
});
if (built.status !== 0) {
  process.stderr.write(built.stderr || built.stdout || 'webpack failed\n');
  process.exit(built.status || 1);
}

if (fs.existsSync(liveBundle)) {
  const afterMtime = fs.statSync(liveBundle).mtimeMs;
  const afterHead = fs.readFileSync(liveBundle).subarray(0, 80).toString('utf8');
  if (afterMtime !== liveMtime || afterHead !== liveHead) {
    process.stderr.write('live public/dist changed during isolated webpack\n');
    process.exit(1);
  }
}

const stampPath = path.join(os.tmpdir(), 'cretli-phase3b-live-dist.json');
fs.writeFileSync(stampPath, JSON.stringify({
  liveDistUnchanged: true,
  liveMtime,
  isolatedRoot,
  bundleHasCenter: fs.readFileSync(path.join(outDir, 'index.bundle.js'), 'utf8').includes('delegation-center-list'),
}), 'utf8');

const chatA = {
  id: crypto.randomUUID(),
  title: 'Phase3b parent A',
  cursorSessionId: crypto.randomUUID(),
  agentTransport: 'opencode',
  sdkMode: 'agent',
  workspaceFolder: wsA,
  model: 'opencode/test',
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(dataDir, 'chats.json'), JSON.stringify({ chats: [chatA] }, null, 2));

const child = spawn(process.execPath, ['server.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CRETLI_DATA_DIR: dataDir,
    CURSOR_REMOTE_DATA_DIR: dataDir,
    CRETLI_PUBLIC_DIR: publicDir,
    PORT: String(port),
    USE_HTTPS: '0',
    CRETLI_BIND: '127.0.0.1',
    CRETLI_FRONT_HMR: '0',
    CURSOR_REMOTE_FRONT_HOT_FALLBACK: '0',
    CRETLI_TEST_CHAT_RUN_ADAPTER: '1',
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
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
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
