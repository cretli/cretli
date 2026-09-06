import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { isGitRepo, normalizeGitArg, runGitCommand } from '../git-cli.js';
import { isMutatingToolName } from './tool-definitions.js';
import {
  isExistingDirectory,
  isExistingFile,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from './workspace-sandbox.js';
import { decodeMcpToolName, findServerByRuntimeName } from '../mcp/mcp-tool-names.js';
import { callContextTool, resolveContextServers } from '../mcp/mcp-service.js';
import { isReadOnlySdkMode, normalizeSdkMode } from '../sdk/sdk-mode.js';
import { resolveReadOnlyGuardUserMessage } from '../sdk/sdk-plan-guard.js';
import {
  commandTouchesHistoryStore,
  HISTORY_STORE_DIR_NAMES,
  historyStoreBlockedMessage,
  historyStoreRipgrepGlobs,
  isHistoryStorePath,
} from './history-store-guard.js';

const FILE_READ_MAX = 1024 * 1024;
const SHELL_TIMEOUT_MS = 120000;
const SHELL_MAX_OUTPUT = 256 * 1024;
const GREP_TIMEOUT_MS = 30000;

function requestedWorkspacePath(cwd, rel) {
  const base = String(cwd || '').trim();
  const rest = String(rel || '').trim();
  if (!base) return '';
  return rest ? path.resolve(base, rest) : path.resolve(base);
}

/**
 * @param {unknown} resolved
 * @returns {{ ok: false, output: string, error: string } | null}
 */
function denyHistoryStore(resolved) {
  if (!isHistoryStorePath(resolved)) return null;
  return { ok: false, output: '', error: historyStoreBlockedMessage() };
}

/**
 * @typedef {Object} ToolExecutionContext
 * @property {string} cwd
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {object} [mcpContext]
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function parseToolArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return /** @type {Record<string, unknown>} */ (value);
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * @param {string} name
 * @param {unknown} args
 * @param {ToolExecutionContext} ctx
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
export async function executeTool(name, args, ctx) {
  const toolName = String(name || '').trim();
  if (!toolName) {
    return { ok: false, output: '', error: 'Missing tool name' };
  }
  const cwd = String(ctx?.cwd || '').trim();
  if (!cwd) {
    return { ok: false, output: '', error: 'Missing workspace directory' };
  }
  const mode = normalizeSdkMode(ctx?.mode);
  const parsedArgs = parseToolArgs(args);
  const mcpName = decodeMcpToolName(toolName);
  if (mcpName) {
    const servers = resolveContextServers({ ...ctx?.mcpContext, mode, cwd });
    const server = findServerByRuntimeName(servers, mcpName.runtimeName);
    if (!server) {
      return { ok: false, output: '', error: `Unknown MCP tool ${toolName}` };
    }
    const result = await callContextTool(
      { ...ctx?.mcpContext, mode, cwd },
      server.id,
      mcpName.toolName,
      parsedArgs,
    );
    return {
      ok: result.ok !== false,
      output: String(result.output || ''),
      error: result.error,
    };
  }
  if (isReadOnlySdkMode(mode) && isMutatingToolName(toolName)) {
    return { ok: false, output: '', error: resolveReadOnlyGuardUserMessage(mode) };
  }
  switch (toolName) {
    case 'read_file':
      return executeReadFile(cwd, parsedArgs);
    case 'list_directory':
      return executeListDirectory(cwd, parsedArgs);
    case 'grep':
      return executeGrep(cwd, parsedArgs);
    case 'write_file':
      return executeWriteFile(cwd, parsedArgs);
    case 'search_replace':
      return executeSearchReplace(cwd, parsedArgs);
    case 'run_terminal_command':
      return executeShellCommand(cwd, parsedArgs);
    case 'git_status':
      return executeGitStatus(cwd);
    case 'git_diff':
      return executeGitDiff(cwd, parsedArgs);
    case 'git_run':
      return executeGitRun(cwd, parsedArgs);
    default:
      return { ok: false, output: '', error: `Unknown tool: ${toolName}` };
  }
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeReadFile(cwd, args) {
  const rel = String(args.path || '').trim();
  const deniedRequested = denyHistoryStore(requestedWorkspacePath(cwd, rel));
  if (deniedRequested) return deniedRequested;
  const resolved = resolveWorkspacePath(cwd, rel);
  if (!resolved) return { ok: false, output: '', error: 'Path outside workspace' };
  const denied = denyHistoryStore(resolved);
  if (denied) return denied;
  if (!isExistingFile(resolved)) return { ok: false, output: '', error: 'File not found' };
  const size = fs.statSync(resolved).size;
  if (size > FILE_READ_MAX) {
    return { ok: false, output: '', error: `File too large (${size} bytes, max ${FILE_READ_MAX})` };
  }
  const content = fs.readFileSync(resolved, 'utf8');
  return { ok: true, output: content };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeListDirectory(cwd, args) {
  const rel = String(args.path || '').trim();
  const deniedRequested = denyHistoryStore(requestedWorkspacePath(cwd, rel));
  if (deniedRequested) return deniedRequested;
  const resolved = rel ? resolveWorkspacePath(cwd, rel) : path.resolve(cwd);
  if (!resolved) return { ok: false, output: '', error: 'Path outside workspace' };
  const denied = denyHistoryStore(resolved);
  if (denied) return denied;
  if (!isExistingDirectory(resolved)) return { ok: false, output: '', error: 'Directory not found' };
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => !isHistoryStorePath(path.join(resolved, entry.name)))
    .map((entry) => {
      const full = path.join(resolved, entry.name);
      const relPath = toWorkspaceRelativePath(cwd, full);
      if (entry.isDirectory()) return `${relPath}/`;
      const size = fs.statSync(full).size;
      return `${relPath} (${size} bytes)`;
    })
    .sort((a, b) => a.localeCompare(b));
  return { ok: true, output: entries.join('\n') || '(empty directory)' };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
function executeGrep(cwd, args) {
  const pattern = String(args.pattern || '').trim();
  if (!pattern) return { ok: false, output: '', error: 'Missing pattern' };
  const rel = String(args.path || '').trim();
  const deniedRequested = denyHistoryStore(requestedWorkspacePath(cwd, rel));
  if (deniedRequested) return deniedRequested;
  const searchDir = rel ? resolveWorkspacePath(cwd, rel) : path.resolve(cwd);
  if (!searchDir) return { ok: false, output: '', error: 'Path outside workspace' };
  const denied = denyHistoryStore(searchDir);
  if (denied) return denied;
  const rgGlobs = historyStoreRipgrepGlobs().flatMap((glob) => ['--glob', glob]);
  const grepExcludeDirs = HISTORY_STORE_DIR_NAMES.flatMap((name) => ['--exclude-dir', name]);
  return new Promise((resolve) => {
    const rg = spawn('rg', ['--line-number', '--no-heading', '--color=never', ...rgGlobs, pattern, searchDir], {
      cwd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      rg.kill('SIGTERM');
    }, GREP_TIMEOUT_MS);
    rg.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > SHELL_MAX_OUTPUT) rg.kill('SIGTERM');
    });
    rg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    rg.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.trim()) {
        return resolve({ ok: true, output: stdout.trim() || '(no matches)' });
      }
      if (code === 1) return resolve({ ok: true, output: '(no matches)' });
      if (stderr.includes('ENOENT')) {
        const fallback = spawnSync(
          'grep',
          ['-r', '-n', ...grepExcludeDirs, '--', pattern, searchDir],
          { cwd, encoding: 'utf8', timeout: GREP_TIMEOUT_MS },
        );
        const out = (fallback.stdout || '').trim();
        if (out) return resolve({ ok: true, output: out.slice(0, SHELL_MAX_OUTPUT) });
        return resolve({ ok: true, output: '(no matches)' });
      }
      return resolve({ ok: false, output: stdout.trim(), error: stderr.trim() || `grep exited ${code}` });
    });
    rg.on('error', () => {
      clearTimeout(timer);
      const fallback = spawnSync(
        'grep',
        ['-r', '-n', ...grepExcludeDirs, '--', pattern, searchDir],
        { cwd, encoding: 'utf8', timeout: GREP_TIMEOUT_MS },
      );
      const out = (fallback.stdout || '').trim();
      if (out) return resolve({ ok: true, output: out.slice(0, SHELL_MAX_OUTPUT) });
      if (fallback.status === 1) return resolve({ ok: true, output: '(no matches)' });
      return resolve({ ok: false, output: '', error: (fallback.stderr || 'grep failed').trim() });
    });
  });
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeWriteFile(cwd, args) {
  const rel = String(args.path || '').trim();
  const content = typeof args.content === 'string' ? args.content : '';
  const deniedRequested = denyHistoryStore(requestedWorkspacePath(cwd, rel));
  if (deniedRequested) return deniedRequested;
  const resolved = resolveWorkspacePath(cwd, rel);
  if (!resolved) return { ok: false, output: '', error: 'Path outside workspace' };
  const denied = denyHistoryStore(resolved) || denyHistoryStore(path.dirname(resolved));
  if (denied) return denied;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, 'utf8');
  return { ok: true, output: `Wrote ${toWorkspaceRelativePath(cwd, resolved)} (${content.length} bytes)` };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeSearchReplace(cwd, args) {
  const rel = String(args.path || '').trim();
  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  if (!oldString) return { ok: false, output: '', error: 'old_string is required' };
  const deniedRequested = denyHistoryStore(requestedWorkspacePath(cwd, rel));
  if (deniedRequested) return deniedRequested;
  const resolved = resolveWorkspacePath(cwd, rel);
  if (!resolved) return { ok: false, output: '', error: 'Path outside workspace' };
  const denied = denyHistoryStore(resolved);
  if (denied) return denied;
  if (!isExistingFile(resolved)) return { ok: false, output: '', error: 'File not found' };
  const original = fs.readFileSync(resolved, 'utf8');
  const index = original.indexOf(oldString);
  if (index < 0) return { ok: false, output: '', error: 'old_string not found in file' };
  const updated = `${original.slice(0, index)}${newString}${original.slice(index + oldString.length)}`;
  fs.writeFileSync(resolved, updated, 'utf8');
  return { ok: true, output: `Updated ${toWorkspaceRelativePath(cwd, resolved)}` };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 * @returns {Promise<{ ok: boolean, output: string, error?: string }>}
 */
function executeShellCommand(cwd, args) {
  const command = String(args.command || '').trim();
  if (!command) return { ok: false, output: '', error: 'Missing command' };
  if (commandTouchesHistoryStore(command)) {
    return { ok: false, output: '', error: historyStoreBlockedMessage() };
  }
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), SHELL_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > SHELL_MAX_OUTPUT) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(0, SHELL_MAX_OUTPUT);
      if (code === 0) return resolve({ ok: true, output: output || '(no output)' });
      return resolve({
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

/**
 * @param {string} cwd
 */
function executeGitStatus(cwd) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const result = runGitCommand(['status', '-sb'], cwd);
  if (!result.ok) return { ok: false, output: '', error: result.error || result.stderr || 'git status failed' };
  return { ok: true, output: (result.stdout || '').trim() };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeGitDiff(cwd, args) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const rel = String(args.path || '').trim();
  const gitArgs = rel ? ['--no-pager', 'diff', 'HEAD', '--', rel.replace(/\\/g, '/')] : ['--no-pager', 'diff'];
  const result = runGitCommand(gitArgs, cwd);
  if (!result.ok) return { ok: false, output: '', error: result.error || result.stderr || 'git diff failed' };
  return { ok: true, output: (result.stdout || '').trim() || '(no diff)' };
}

/**
 * @param {string} cwd
 * @param {Record<string, unknown>} args
 */
function executeGitRun(cwd, args) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const action = String(args.action || '').trim();
  const arg = normalizeGitArg(args.arg);
  const actionMap = {
    status: () => ['status', '-sb'],
    fetch: () => ['fetch'],
    pull: () => ['pull'],
    push: () => ['push'],
    log: () => ['log', '--oneline', '--graph', '--decorate', '-n', '20'],
    diff: () => ['diff'],
    'diff-staged': () => ['diff', '--staged'],
    branch: () => ['branch', '-a'],
    stash: () => ['stash'],
    'stash-pop': () => ['stash', 'pop'],
    switch: (value) => ['switch', value],
    'switch-new': (value) => ['switch', '-c', value],
    merge: (value) => ['merge', value],
    rebase: (value) => ['rebase', value],
  };
  const factory = actionMap[action];
  if (!factory) return { ok: false, output: '', error: `Unknown git action: ${action}` };
  if (['switch', 'switch-new', 'merge', 'rebase'].includes(action) && !arg) {
    return { ok: false, output: '', error: 'Missing required arg (branch name)' };
  }
  const gitArgs = factory(arg);
  const result = runGitCommand(gitArgs, cwd);
  if (!result.ok) {
    return { ok: false, output: (result.stderr || result.stdout || '').trim(), error: 'git command failed' };
  }
  return { ok: true, output: (result.stdout || result.stderr || '').trim() || '(ok)' };
}
