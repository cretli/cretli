/** Read ChatGPT plan quotas without starting an inference turn. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';
import { buildCodexProcessEnv } from './codex-api-key.js';
import { getCodexAuthMode } from './codex-auth-mode.js';
import { hasCodexChatGptAuth, resolveCodexAuthJsonPath } from './codex-chatgpt-auth.js';
import { resolveCodexCli, isCodexCliFound } from './codex-cli.js';
import { resolveCodexHomeDir } from './codex-home.js';
import { noteHarnessPlanLimit } from '../usage/harness-health.js';

const CACHE_MS = 60000;
const TIMEOUT_MS = 8000;
let cache;
let pending;

/** Normalize only quota fields; never expose account ids or reset credit ids. */
export function normalizeCodexPlanLimits(result, observedAt = new Date().toISOString()) {
  const buckets = result?.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === 'object'
    ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits];
  const windows = [];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const lane of ['primary', 'secondary']) {
      const window = bucket[lane];
      if (!window || typeof window !== 'object') continue;
      const minutes = window.windowDurationMins;
      const type = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : `${lane}_${minutes ?? 'unknown'}`;
      const bucketId = typeof bucket.limitId === 'string' ? bucket.limitId.slice(0, 100) : 'codex';
      const percent = window.usedPercent;
      const reset = typeof window.resetsAt === 'number' && window.resetsAt > 0 ? new Date(window.resetsAt * 1000) : null;
      windows.push({
        harness: 'codex', authMode: 'chatgpt', source: 'codex-app-server', observedAt,
        rateLimitType: bucketId === 'codex' ? type : `${bucketId}:${type}`,
        ...(typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? { utilization: percent } : {}),
        ...(reset && Number.isFinite(reset.getTime()) ? { resetsAt: reset.toISOString() } : {}),
      });
    }
  }
  const credits = result?.rateLimits?.credits;
  const count = result?.rateLimitResetCredits?.availableCount;
  return {
    available: true, observedAt, windows,
    planType: typeof result?.rateLimits?.planType === 'string' ? result.rateLimits.planType : null,
    credits: credits && typeof credits === 'object' ? {
      balance: typeof credits.balance === 'string' && /^\d+(\.\d+)?$/.test(credits.balance) ? credits.balance : null,
      unlimited: credits.unlimited === true,
    } : null,
    resetCreditsAvailable: Number.isInteger(count) && count >= 0 ? count : null,
  };
}

/** One bounded JSON-RPC connection, terminated on success, error or timeout. */
export function readCodexRateLimits({ cliPath = resolveCodexCli(), env = buildCodexProcessEnv({ forceChatGpt: true }), spawnFn = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    let lines;
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines?.close();
      child?.stdin?.destroy();
      child?.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    try {
      child = spawnFn(cliPath, ['app-server', '--stdio'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
      child.on('error', () => finish(new Error('Codex CLI could not start.')));
      child.on('close', () => finish(new Error('Codex CLI closed before returning plan limits.')));
      child.stdin.on('error', () => finish(new Error('Codex CLI connection failed.')));
      timer = setTimeout(() => finish(new Error('Codex plan limit read timed out.')), timeoutMs);
      lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 1 && message.id !== 2) return;
        // Do not forward arbitrary upstream error text into the UI or logs.
        if (message.error) return finish(new Error('Codex plan limits are unavailable. Check ChatGPT login and CLI version.'));
        if (message.id === 2) return finish(null, message.result);
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/rateLimits/read', params: {} });
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cretli', version: '1.0.0' } } });
    } catch {
      finish(new Error('Codex CLI could not start.'));
    }
  });
}

/** Coalesce UI reads and invalidate cached quotas when the login file changes. */
export async function getCodexPlanLimits({ dataDir } = {}) {
  if (getCodexAuthMode() !== 'chatgpt') return { available: false, reason: 'api-key' };
  if (!hasCodexChatGptAuth()) return { available: false, reason: 'login-required' };
  if (!isCodexCliFound()) return { available: false, reason: 'cli-missing' };
  const file = resolveCodexAuthJsonPath();
  let identity;
  try { const stat = statSync(file); identity = `${file}:${stat.mtimeMs}:${stat.size}`; }
  catch { return { available: false, reason: 'login-required' }; }
  const key = `${identity}:${dataDir || ''}`;
  if (cache?.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (pending?.key === key) return pending.promise;
  const promise = (async () => {
    let value;
    try {
      const env = { ...buildCodexProcessEnv({ forceChatGpt: true }), CODEX_HOME: resolveCodexHomeDir() };
      value = normalizeCodexPlanLimits(await readCodexRateLimits({ env }));
      for (const row of value.windows) noteHarnessPlanLimit({ ...row, dataDir });
    } catch (error) {
      value = { available: false, reason: 'read-failed', error: error.message };
    }
    cache = { key, at: Date.now(), value };
    return value;
  })();
  pending = { key, promise };
  try { return await promise; }
  finally { if (pending?.promise === promise) pending = null; }
}
