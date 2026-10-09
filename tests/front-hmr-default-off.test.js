import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getFreePort, requestJson, stopServer } from './helpers/delegation-isolated-http.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function waitForReady(child, readOutput, port) {
  const pattern = new RegExp(`Cretli: https?://localhost:${port}`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (pattern.test(readOutput())) return;
    if (child.exitCode !== null) {
      throw new Error(`server exited early (${child.exitCode}):\n${readOutput().slice(-2000)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server did not become ready:\n${readOutput().slice(-2000)}`);
}

test('a plain server start never boots the in-process webpack HMR compiler', async () => {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-hmr-default-'));
  const env = {
    ...process.env,
    PORT: String(port),
    USE_HTTPS: '0',
    CRETLI_BIND: '127.0.0.1',
    CRETLI_DATA_DIR: dataDir,
    CURSOR_REMOTE_DATA_DIR: dataDir,
  };
  delete env.CRETLI_FRONT_HMR;
  delete env.CURSOR_REMOTE_FRONT_HMR;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    await waitForReady(child, () => output, port);
    const health = await requestJson({ port, method: 'GET', url: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    // The middleware logs `[front-hmr] active` as soon as it mounts the webpack
    // compiler; is absence proves `npm start` stayed HMR-free.
    assert.doesNotMatch(output, /\[front-hmr\]/);
  } finally {
    await stopServer(child, 'SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
