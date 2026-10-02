/**
 * One-shot title generation on a subscription plan (no API key): Claude Code login via the Agent
 * SDK and ChatGPT-plan Codex via `codex exec`. Both run with tools denied, an empty temp cwd and
 * no persisted session, so nothing is written to a Cretli chat and no delegation is created.
 * They consume plan usage like any other request.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { loadClaudeSdk } from './claude/claude-sdk.js';
import { buildClaudeProcessEnv } from './claude/claude-api-key.js';
import { buildCodexProcessEnv } from './codex/codex-api-key.js';
import { resolveCodexCli } from './codex/codex-cli.js';
import { ensureCodexHomeDir } from './codex/codex-home.js';

const TITLE_SYSTEM_PROMPT = 'You name chats. Reply with the requested title only, no tools, no commentary.';
const MAX_OUTPUT_CHARS = 4000;

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeScratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * @param {{ prompt: string, model: string, signal?: AbortSignal }} input
 * @returns {Promise<string>}
 */
export async function generateTitleViaClaudePlan({ prompt, model, signal }) {
  const sdk = await loadClaudeSdk();
  const scratch = makeScratchDir('cretli-title-claude-');
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const query = sdk.query({
      prompt,
      options: {
        cwd: scratch,
        model,
        env: buildClaudeProcessEnv(),
        abortController,
        systemPrompt: TITLE_SYSTEM_PROMPT,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        canUseTool: async () => ({ behavior: 'deny', message: 'Tools are disabled for title generation.' }),
      },
    });
    let text = '';
    for await (const message of query) {
      if (message?.type === 'result') {
        if (message.is_error === true) throw new Error(`title generator ${message.subtype || 'error'}`);
        if (typeof message.result === 'string') text = message.result;
      } else if (!text && message?.type === 'assistant') {
        const blocks = message.message?.content;
        if (Array.isArray(blocks)) text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('');
      }
    }
    return text;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * @param {{ prompt: string, model: string, signal?: AbortSignal }} input
 * @returns {Promise<string>}
 */
export async function generateTitleViaCodexPlan({ prompt, model, signal }) {
  const scratch = makeScratchDir('cretli-title-codex-');
  const outFile = path.join(scratch, 'last-message.txt');
  const cli = resolveCodexCli();
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '-s', 'read-only', '-C', scratch, '-o', outFile,
    '-c', 'model_reasoning_effort="low"',
    '-m', model, '-',
  ];
  const env = buildCodexProcessEnv({ forceChatGpt: true });
  env.CODEX_HOME = ensureCodexHomeDir();
  const isScript = /\.[cm]?js$/.test(cli);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(isScript ? process.execPath : cli, isScript ? [cli, ...args] : args, {
        cwd: scratch,
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
        signal,
      });
      child.on('error', (err) => reject(err?.name === 'AbortError' ? err : new Error('title generator codex failed to start')));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`title generator codex exit ${code}`))));
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').slice(0, MAX_OUTPUT_CHARS) : '';
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
