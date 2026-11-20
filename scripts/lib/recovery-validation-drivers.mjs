/**
 * Real-SDK drivers for `runLiveAdapterValidation` (lib/recovery/adapter-live-validation.ts).
 * Each turn runs in its own child process so the kill is a genuine process death.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXECUTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recovery-validation-executor.mjs');

/** Harnesses that have a real-SDK executor. */
export const LIVE_VALIDATION_HARNESSES = Object.freeze(['claude', 'codex']);

function markerHasLine(markerFile) {
  try {
    return readFileSync(markerFile, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

/** Spawns the executor in its own process group and collects its JSON events. */
function spawnTurn(harness, config) {
  const child = spawn(process.execPath, [EXECUTOR, harness, JSON.stringify(config)], {
    cwd: config.cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  const state = { sessionId: '', tools: 0, text: '', error: '', exited: false };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const event = JSON.parse(line);
        if (event.type === 'session' && event.id) state.sessionId = event.id;
        else if (event.type === 'tool') state.tools += 1;
        else if (event.type === 'text') state.text += `${event.text}\n`;
        else if (event.type === 'error') state.error = event.message;
      } catch {
        // Non-JSON noise from the SDK is ignored.
      }
    }
  });
  /** @type {Promise<void>} */
  const exited = new Promise((/** @type {() => void} */ resolve) => {
    child.on('exit', () => { state.exited = true; resolve(); });
    child.on('error', (err) => { state.error = err.message; state.exited = true; resolve(); });
  });
  const kill = (signal) => {
    try { process.kill(-child.pid, signal); } catch { /* already gone */ }
  };
  return { state, exited, kill };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLiveValidationDriver(harness) {
  return {
    async startAndKill({ cwd, markerFile, secret, timeoutMs }) {
      const prompt = [
        `Remember this secret word: ${secret}.`,
        `Then run exactly this shell command: echo run1 >> "${markerFile}"`,
        'After it finishes, run: sleep 120',
        'Do not reply before the sleep finishes.',
      ].join(' ');
      const turn = spawnTurn(harness, { cwd, prompt });
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline && !turn.state.exited) {
          if (turn.state.sessionId && markerHasLine(markerFile)) break;
          await sleep(200);
        }
        const ready = Boolean(turn.state.sessionId) && markerHasLine(markerFile);
        if (!ready) throw new Error(turn.state.error || 'Executor did not reach the tool call before the timeout.');
        turn.kill('SIGKILL');
        await turn.exited;
        return { sessionId: turn.state.sessionId, killed: true };
      } finally {
        turn.kill('SIGKILL');
      }
    },
    async resume({ cwd, sessionId, timeoutMs }) {
      const prompt = 'What was the secret word I told you earlier? Reply with only that word. Do not run any tools or commands.';
      const turn = spawnTurn(harness, { cwd, prompt, sessionId });
      const timer = setTimeout(() => turn.kill('SIGKILL'), timeoutMs);
      try {
        await turn.exited;
      } finally {
        clearTimeout(timer);
        turn.kill('SIGKILL');
      }
      if (turn.state.error) throw new Error(turn.state.error);
      return { sessionId: turn.state.sessionId || sessionId, replyText: turn.state.text, toolCalls: turn.state.tools };
    },
  };
}
