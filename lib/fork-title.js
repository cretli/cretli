/**
 * Backend: one-shot agent that generates a chat title. Starts an agent (without --resume),
 * sends the prompt, collects the output and parses the JSON with "title".
 * Optionally uses Cursor CLI --print --output-format json (no TTY / interactive agent mode).
 * @see https://cursor.com/docs/cli/reference/output-format
 */

import { spawnSync } from 'child_process';
import pty from 'node-pty';
import { buildAgentSpawnEnv } from './agent-cli.js';
import {
  buildStructuredChunkSummaryPrompt,
  truncateTextForAgentPrompt,
} from './context-compression.js';

const PRINT_TIMEOUT_MS = 120000;
const SUMMARY_PRINT_TIMEOUT_MS = 180000;

const TITLE_FORK_PROMPT_PREFIX = 'Here is the chat content:\n\n';
// Must stay verbatim in sync with AUTO_TITLE_PROMPT in app_front/config.js —
// app_front/features/chat/chatTitleParsing.js slices agent output on these markers.
const TITLE_FORK_PROMPT_SUFFIX =
  '\n\nReply with a single line of JSON containing a "title" key (a short name for this chat, max 50 characters). Example: {"title": "Refactor module X"}. No other text.';

function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z@]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[PX^_][^\x1b]*(\x1b\\)?/g, '');
}

const EXAMPLE_TITLE = 'Refactor module X';
const EXAMPLE_SUMMARY =
  'The user asks for a refactor of module X. The agent proposes a step-by-step approach.';
const SUMMARY_TITLE_MAX_LEN = 50;
const TITLE_JSON_REGEX = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

/**
 * Extracts a title from the buffer: collects every {"title": "..."} and keeps the last one
 * (usually the model reply), cleans box-drawing/ANSI noise and rejects the example from the prompt.
 * @param {string} buffer
 * @returns {string|null}
 */
export function tryExtractTitleFromBuffer(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const raw = stripAnsi(buffer);
  let lastMatch = null;
  let m;
  TITLE_JSON_REGEX.lastIndex = 0;
  while ((m = TITLE_JSON_REGEX.exec(raw)) !== null) lastMatch = m;
  if (!lastMatch) return null;
  let title = lastMatch[1].replace(/\\(.)/g, '$1');
  title = title.replace(/[\r\n│\s]+/g, ' ').trim();
  if (title === EXAMPLE_TITLE || title.length === 0) return null;
  return title;
}

export function buildTitlePrompt(text) {
  return TITLE_FORK_PROMPT_PREFIX + (text || '') + TITLE_FORK_PROMPT_SUFFIX;
}

export function buildSummaryPrompt(text) {
  const segment = truncateTextForAgentPrompt(text || '');
  return buildStructuredChunkSummaryPrompt(segment, 1, 1);
}

/**
 * Extract summary and/or title JSON from agent stdout or PTY buffer.
 *
 * @param {string} buffer
 * @returns {{ summary: string, title: string } | null}
 */
export function tryExtractSummaryAndTitleFromBuffer(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const raw = stripAnsi(buffer);
  const candidates = [];
  const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) candidates.push(codeBlockMatch[1].trim());
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) candidates.push(trimmed);
  }
  const braceStart = raw.lastIndexOf('{');
  if (braceStart !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end !== -1) candidates.push(raw.slice(braceStart, end));
  }
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (!obj || typeof obj !== 'object') continue;
      const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
      const title = typeof obj.title === 'string' ? obj.title.trim() : '';
      if (!summary && !title) continue;
      if (summary === EXAMPLE_SUMMARY && title === EXAMPLE_TITLE) continue;
      return {
        summary,
        title:
          title.length > SUMMARY_TITLE_MAX_LEN ? title.slice(0, SUMMARY_TITLE_MAX_LEN) : title,
      };
    } catch (_) {}
  }
  return null;
}

/**
 * Single agent call in print mode: stdout is one JSON object (type result, where result is the model text).
 * The prompt goes to stdin. Returns the title parsed out of result ({"title":"..."}) or null.
 */
export function runAgentPrintTitle(agentCmd, agentDir, model, fullPrompt) {
  if (!agentDir || !fullPrompt) return null;
  const cliModel = model === 'Auto' ? 'auto' : model || 'auto';
  const args = ['--workspace', agentDir, '--model', cliModel, '--trust', '--print', '--output-format', 'json'];
  const r = spawnSync(agentCmd, args, {
    cwd: agentDir,
    input: fullPrompt,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: PRINT_TIMEOUT_MS,
    env: buildAgentSpawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error || r.signal) {
    console.warn(
      '[runAgentPrintTitle] spawn failed:',
      r.error?.message || r.signal,
      (r.stderr || '').slice(0, 300)
    );
    return null;
  }
  const out = (r.stdout || '').trim();
  if (!out) {
    console.warn('[runAgentPrintTitle] empty stdout:', (r.stderr || '').slice(0, 300));
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(out);
  } catch {
    try {
      const line = out.includes('\n') ? out.slice(out.lastIndexOf('\n') + 1) : out;
      obj = JSON.parse(line);
    } catch {
      console.warn('[runAgentPrintTitle] invalid JSON stdout:', out.slice(0, 300));
      return null;
    }
  }
  if (obj.type !== 'result' || obj.subtype !== 'success' || typeof obj.result !== 'string') return null;
  return tryExtractTitleFromBuffer(obj.result);
}

/**
 * One-shot agent in print mode for context summary. Parses JSON with summary + title from stdout.
 *
 * @returns {{ summary: string, title: string } | null}
 */
export function runAgentPrintSummary(agentCmd, agentDir, model, fullPrompt) {
  if (!agentDir || !fullPrompt) return null;
  const cliModel = model === 'Auto' ? 'auto' : model || 'auto';
  const args = ['--workspace', agentDir, '--model', cliModel, '--trust', '--print', '--output-format', 'json'];
  const r = spawnSync(agentCmd, args, {
    cwd: agentDir,
    input: fullPrompt,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: SUMMARY_PRINT_TIMEOUT_MS,
    env: buildAgentSpawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error || r.signal) {
    console.warn(
      '[runAgentPrintSummary] spawn failed:',
      r.error?.message || r.signal,
      (r.stderr || '').slice(0, 300)
    );
    return null;
  }
  const out = (r.stdout || '').trim();
  if (!out) {
    console.warn('[runAgentPrintSummary] empty stdout:', (r.stderr || '').slice(0, 300));
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(out);
  } catch {
    try {
      const line = out.includes('\n') ? out.slice(out.lastIndexOf('\n') + 1) : out;
      obj = JSON.parse(line);
    } catch {
      console.warn('[runAgentPrintSummary] invalid JSON stdout:', out.slice(0, 300));
      return null;
    }
  }
  if (obj.type !== 'result' || obj.subtype !== 'success' || typeof obj.result !== 'string') return null;
  const parsed = tryExtractSummaryAndTitleFromBuffer(obj.result);
  if (!parsed?.summary) {
    console.warn('[runAgentPrintSummary] no summary in result:', obj.result.slice(0, 300));
    return null;
  }
  return parsed;
}

function buildCurlCommand(url, payloadTemplate, options = {}) {
  const callbackToken =
    options && typeof options.callbackToken === 'string' ? options.callbackToken.trim() : '';
  const insecureTls = !!(options && options.insecureTls);
  const curlParts = ['curl', '-sS', '-X', 'POST', url];
  if (insecureTls) curlParts.push('-k');
  if (callbackToken) curlParts.push('-H', `"X-Agent-Token: ${callbackToken}"`);
  curlParts.push('-H', '"Content-Type: application/json"');
  curlParts.push('-d', `'${payloadTemplate}'`);
  return curlParts.join(' ');
}

/**
 * Prompt that tells the agent to generate a title and then curl our API (the agent acts as the tool).
 * baseUrl – e.g. https://192.0.2.10:3011 (no trailing slash).
 */
export function buildTitlePromptWithCallback(chatId, text, baseUrl, options = {}) {
  const url = (baseUrl || '').replace(/\/$/, '') + '/api/set-chat-title-from-agent';
  const curlCommand = buildCurlCommand(
    url,
    `{"chatId":"${chatId}","title":"YOUR_TITLE"}`,
    options
  );
  const instruction =
    '\n\nREQUIRED: at the end you must update the chat name over HTTP. Pick a short title (max 50 characters, no " inside). In the agent terminal run EXACTLY this command (substitute your title for YOUR_TITLE, as a single JSON-quoted string):\n' +
    curlCommand +
    '\n\nIf you have the ! shell mode, type ! and paste the curl line above (with the title substituted). Without that curl the chat name will not change.';
  return (
    TITLE_FORK_PROMPT_PREFIX +
    (text || '') +
    TITLE_FORK_PROMPT_SUFFIX +
    instruction
  );
}

export function buildSummaryPromptWithCallback(chatId, text, baseUrl, options = {}) {
  const url = (baseUrl || '').replace(/\/$/, '') + '/api/set-chat-summary-from-agent';
  const curlCommand = buildCurlCommand(
    url,
    `{"chatId":"${chatId}","title":"YOUR_TITLE","summary":"YOUR_SUMMARY"}`,
    options
  );
  const instruction =
    '\n\nWhen the structured JSON (summary + title) is ready, run this curl in the agent terminal. Replace ONLY YOUR_TITLE and YOUR_SUMMARY (escape quotes in summary for JSON):\n' +
    curlCommand;
  const basePrompt = buildSummaryPrompt(text || '');
  return `${basePrompt}${instruction}`;
}

/**
 * Starts an agent (fresh session, no --resume), sends the prompt and collects output until the timeout.
 * @param {string} agentCmd - command to run (e.g. 'agent')
 * @param {string} agentDir - agent working directory (workspace dir)
 * @param {string} model - e.g. 'auto'
 * @param {string} fullPrompt
 * @param {number} timeoutMs
 * @returns {Promise<{ title: string } | null>}
 */
export function runAgentOneShot(agentCmd, agentDir, model, fullPrompt, timeoutMs) {
  return new Promise((resolve) => {
    const args = [];
    if (agentDir) args.push('--workspace', agentDir);
    if (model) args.push('--model', model === 'Auto' ? 'auto' : model);
    let buffer = '';
    let settled = false;

    const p = pty.spawn(agentCmd, args, {
      cwd: agentDir || process.cwd(),
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: { ...buildAgentSpawnEnv(), TERM: 'dumb' },
    });

    const finish = (title) => {
      if (settled) return;
      settled = true;
      try {
        p.kill();
      } catch (_) {}
      resolve(title != null ? { title } : null);
    };

    const timeoutId = setTimeout(() => {
      const title = tryExtractTitleFromBuffer(buffer);
      finish(title);
    }, timeoutMs);

    p.onData((data) => {
      buffer += data;
      const title = tryExtractTitleFromBuffer(buffer);
      if (title) {
        clearTimeout(timeoutId);
        finish(title);
      }
    });

    p.onExit(() => {
      if (!settled) {
        clearTimeout(timeoutId);
        const title = tryExtractTitleFromBuffer(buffer);
        finish(title);
      }
    });

    p.write(fullPrompt + '\r');
  });
}

/**
 * Starts an agent in the background. The prompt is sent in small chunks (as if typed) so the CLI
 * does not switch to "Pasted text" mode and the agent can act on the instruction (e.g. run curl).
 */
export function runAgentOneShotInBackground(agentCmd, agentDir, model, fullPrompt) {
  const args = [];
  if (agentDir) args.push('--workspace', agentDir);
  if (model) args.push('--model', model === 'Auto' ? 'auto' : model);
  const p = pty.spawn(agentCmd, args, {
    cwd: agentDir || process.cwd(),
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: { ...buildAgentSpawnEnv(), TERM: 'xterm-256color' },
  });
  const chunkSize = 20;
  const delayMs = 30;
  let i = 0;
  function sendChunk() {
    try {
      if (i >= fullPrompt.length) {
        p.write('\r');
        return;
      }
      p.write(fullPrompt.slice(i, i + chunkSize));
      i += chunkSize;
      setTimeout(sendChunk, delayMs);
    } catch (_) {}
  }
  setTimeout(sendChunk, 400);
  p.onExit(() => {});
}
