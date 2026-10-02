/**
 * Host-owned review verification.
 *
 * Trust model: review does not run arbitrary tests or node flags. The only
 * allowed verification is this runner, with a frozen catalog of audited
 * files. The runner isolates Cretli data dirs and uses a temp cwd so a
 * catalog file cannot write onto the live project `data/` tree. Adding a
 * catalog id requires a human audit that the file does not mutate the
 * workspace. Unknown ids, reporter flags, and extra paths are rejected
 * before spawn.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_VERIFY_SCRIPT = 'scripts/review-verify.js';
export const REVIEW_VERIFY_TIMEOUT_MS = 60000;

/**
 * Audited catalog: incident unit tests that only assert in-memory helpers.
 * Keys are the only ids an agent may pass. Values are repo-relative files.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const REVIEW_VERIFY_CATALOG = Object.freeze({
  'mcp-chat-history-format': 'tests/mcp-chat-history-format.test.js',
  'sdk-history-stream-coalesce': 'tests/sdk-history-stream-coalesce.test.js',
  'sdk-assistant-block-reuse': 'tests/sdk-assistant-block-reuse.test.js',
  'delegation-contract': 'tests/delegation-contract.test.js',
  'delegation-wait': 'tests/delegation-wait.test.js',
  'delegation-executor': 'tests/delegation-executor.test.js',
  'model-role-profiles': 'tests/model-role-profiles.test.js',
  'model-pick-rotation': 'tests/model-pick-rotation.test.js',
  'model-pick-observed': 'tests/model-pick-observed.test.js',
  'timeout-progress-series': 'tests/timeout-progress-series.test.js',
  'notices': 'tests/notices.test.js',
  'claude-event-normalizer': 'tests/claude-event-normalizer.test.js',
  'todos-persist': 'tests/todos-persist.test.js',
  'todo-source-chat': 'tests/todo-source-chat.test.js',
  'todo-tools': 'tests/todo-tools.test.js',
  'todo-ref': 'tests/todo-ref.test.js',
  'todo-tree-view': 'tests/todo-tree-view.test.js',
  'todos-routes': 'tests/todos-routes.test.js',
  'workspace-watcher': 'tests/workspace-watcher.test.js',
});

export const REVIEW_VERIFY_IDS = Object.freeze(Object.keys(REVIEW_VERIFY_CATALOG));

export const REVIEW_VERIFY_PROMPT_HINT = [
  'Read-only tools are allowed, including native shell for explorers and the host-owned runner.',
  `The only allowed test command is \`node ${REVIEW_VERIFY_SCRIPT}\` or \`node ${REVIEW_VERIFY_SCRIPT} <id>\` with ids: ${REVIEW_VERIFY_IDS.join(', ')}.`,
  'Run that test command by itself: do not combine it with inspection commands, pipes, redirects, extra commands, other tests, node flags, reporters, npm, or shell mutations.',
  'If a Bash command is denied before it starts, split the read-only inspection from verification, use the standalone runner command, and continue reading and reporting.',
  'Mutating shell, edit, and delete stay denied; a denied command does not finish the review.',
].join(' ');

const REVIEW_NODE_BINARIES = new Set(['node', 'nodejs']);
const OPAQUE_EXEC_KEYS = new Set([
  'code',
  'javascript',
  'script',
  'source',
  'program',
  'expression',
]);


/**
 * @param {unknown} text
 * @returns {string}
 */
function stripWrappingQuotes(text) {
  const value = String(text || '').trim();
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isReviewVerifyScriptPath(token) {
  const raw = stripWrappingQuotes(token);
  if (!raw || raw.includes('..') || raw.includes('\\')) return false;
  return raw === REVIEW_VERIFY_SCRIPT || raw === `./${REVIEW_VERIFY_SCRIPT}`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function tokenizeReviewVerifyCommand(value) {
  if (Array.isArray(value)) {
    return value.map((part) => String(part ?? '').trim()).filter(Boolean);
  }
  const text = String(value || '').trim();
  if (!text) return [];
  return text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
}

/**
 * Parse argv after the node binary. Rejects flags, unknown ids, and extra paths.
 *
 * @param {string[]} args
 * @param {{ catalog?: Readonly<Record<string, string>> }} [options]
 * @returns {{ ok: true, ids: string[] } | { ok: false }}
 */
export function parseReviewVerifyNodeArgs(args, options = {}) {
  const catalog = options.catalog || REVIEW_VERIFY_CATALOG;
  if (!Array.isArray(args) || args.length === 0) return { ok: false };
  const script = stripWrappingQuotes(args[0]);
  if (!isReviewVerifyScriptPath(script)) return { ok: false };
  const ids = [];
  for (const token of args.slice(1)) {
    const id = stripWrappingQuotes(token);
    if (!id || id.startsWith('-') || id.includes('/') || id.includes('\\') || id.includes('..')) {
      return { ok: false };
    }
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) return { ok: false };
    ids.push(id);
  }
  return { ok: true, ids: ids.length > 0 ? ids : Object.keys(catalog) };
}

/**
 * True when argv is exactly `node scripts/review-verify.js` plus catalog ids.
 *
 * @param {unknown} command
 * @param {{ catalog?: Readonly<Record<string, string>> }} [options]
 * @returns {boolean}
 */
export function isReviewVerifyInvocation(command, options = {}) {
  const tokens = tokenizeReviewVerifyCommand(command);
  if (tokens.length < 2) return false;
  let index = 0;
  const firstRaw = stripWrappingQuotes(tokens[0]);
  if (firstRaw.includes('/') || firstRaw.includes('\\')) return false;
  if (firstRaw === 'env' || firstRaw === 'command' || firstRaw === 'time') {
    index = 1;
  }
  if (index >= tokens.length) return false;
  const binRaw = stripWrappingQuotes(tokens[index]);
  if (binRaw.includes('/') || binRaw.includes('\\')) return false;
  if (!REVIEW_NODE_BINARIES.has(binRaw)) return false;
  return parseReviewVerifyNodeArgs(tokens.slice(index + 1), options).ok === true;
}

/**
 * functions.exec-style payloads that carry JS instead of a structured command.
 * Do not regex-parse that JS; treat it as mutating.
 *
 * @param {unknown} args
 * @returns {boolean}
 */
export function isOpaqueExecPayload(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const rec = /** @type {Record<string, unknown>} */ (args);
  for (const key of Object.keys(rec)) {
    if (OPAQUE_EXEC_KEYS.has(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * @param {unknown} projectRoot
 * @returns {string}
 */
export function resolveReviewVerifyProjectRoot(projectRoot) {
  const raw = String(projectRoot || '').trim();
  if (raw) return path.resolve(raw);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * @param {{
 *   ids?: string[],
 *   projectRoot?: string,
 *   catalog?: Readonly<Record<string, string>>,
 *   timeoutMs?: number,
 * }} [input]
 * @returns {Promise<{ ok: boolean, output: string, error?: string, dataDir: string }>}
 */
export async function runReviewVerify(input = {}) {
  const catalog = input.catalog || REVIEW_VERIFY_CATALOG;
  const ids = Array.isArray(input.ids) && input.ids.length > 0
    ? input.ids
    : Object.keys(catalog);
  const projectRoot = resolveReviewVerifyProjectRoot(input.projectRoot);
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Number(input.timeoutMs) : REVIEW_VERIFY_TIMEOUT_MS;
  for (const id of ids) {
    if (!Object.prototype.hasOwnProperty.call(catalog, id)) {
      return { ok: false, output: '', error: `Unknown review verify id: ${id}`, dataDir: '' };
    }
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-data-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-review-verify-cwd-'));
  const outputs = [];
  try {
    for (const id of ids) {
      const relative = catalog[id];
      const filePath = path.resolve(projectRoot, relative);
      const relPosix = relative.replace(/\\/g, '/');
      if (!relPosix.startsWith('tests/') || relPosix.includes('..')) {
        return { ok: false, output: outputs.join('\n'), error: `Refusing catalog path ${relative}`, dataDir };
      }
      if (!fs.existsSync(filePath)) {
        return { ok: false, output: outputs.join('\n'), error: `Missing catalog file ${relative}`, dataDir };
      }
      const result = await spawnReviewVerifyFile({
        filePath,
        workDir,
        dataDir,
        timeoutMs,
      });
      outputs.push(`==> ${id}\n${result.output}`.trim());
      if (!result.ok) {
        return {
          ok: false,
          output: outputs.join('\n\n'),
          error: result.error || `${id} failed`,
          dataDir,
        };
      }
    }
    return { ok: true, output: outputs.join('\n\n') || '(no output)', dataDir };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {{ projectRoot?: string }} [options]
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
export async function runReviewVerifyCli(argv, options = {}) {
  const parsed = parseReviewVerifyNodeArgs([REVIEW_VERIFY_SCRIPT, ...argv]);
  if (!parsed.ok) {
    return {
      ok: false,
      output: '',
      error: `Rejected review verify arguments. Allowed: node ${REVIEW_VERIFY_SCRIPT} [${REVIEW_VERIFY_IDS.join('|')}...]`,
    };
  }
  return runReviewVerify({ ids: parsed.ids, projectRoot: options.projectRoot });
}

/**
 * @param {{ filePath: string, workDir: string, dataDir: string, timeoutMs: number }} input
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
function spawnReviewVerifyFile(input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [input.filePath], {
      cwd: input.workDir,
      env: {
        ...process.env,
        CRETLI_DATA_DIR: input.dataDir,
        CRETLI_TEST_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_DATA_DIR: input.dataDir,
        CURSOR_REMOTE_TEST_DATA_DIR: input.dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), input.timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (code === 0) {
        resolve({ ok: true, output: output || '(no output)' });
        return;
      }
      resolve({
        ok: false,
        output,
        error: `Command exited with code ${code ?? 'unknown'}`,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: err.message });
    });
  });
}
