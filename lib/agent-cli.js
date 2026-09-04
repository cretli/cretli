import { accessSync, constants } from 'fs';
import os from 'os';
import path from 'path';
import { getEffectiveCursorApiKey } from './sdk/cursor-api-key.js';

/**
 * Resolve Cursor CLI `agent` binary when the server runs without it on PATH.
 *
 * @param {string} [configuredCmd]
 * @returns {string}
 */
export function resolveAgentCommand(configuredCmd) {
  const configured = (configuredCmd || process.env.CURSOR_AGENT_CMD || 'agent').trim();
  if (!configured) return 'agent';
  if (configured.includes('/')) {
    try {
      accessSync(configured, constants.X_OK);
      return configured;
    } catch {
      return configured;
    }
  }
  const home = process.env.HOME || os.homedir() || '';
  const candidates = [
    home ? path.join(home, '.local/bin/agent') : '',
    configured,
  ].filter(Boolean);
  for (const cmd of candidates) {
    if (!cmd.includes('/')) continue;
    try {
      accessSync(cmd, constants.X_OK);
      return cmd;
    } catch {
      // Try next candidate.
    }
  }
  return configured;
}

/**
 * Build env for Cursor CLI subprocesses. Injects settings API key when env is empty.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildAgentSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const apiKey = getEffectiveCursorApiKey();
  if (apiKey && !String(env.CURSOR_API_KEY || '').trim()) {
    env.CURSOR_API_KEY = apiKey;
  }
  return env;
}
