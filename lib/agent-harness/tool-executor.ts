import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { trackChildProcess } from '../child-process-registry.js';
import { assertExecutorLaunchAllowed } from '../executor-launch-gate.js';
import { isGitRepo, normalizeGitArg, runGitCommand } from '../git-cli.js';
import { isMutatingToolName } from './tool-definitions.ts';
import {
  isExistingDirectory,
  isExistingFile,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from './workspace-sandbox.ts';
import {
  decodeMcpToolName,
  findServerByRuntimeName,
  isCretliBuiltinToolName,
  MCP_BUILTIN_SERVER_KIND,
  resolveMcpBuiltinToolName,
} from '../mcp/mcp-tool-names.js';
import { CRETILI_MCP_TOOL_DEFS } from '../mcp/builtin/catalog.js';
import { callContextTool, resolveContextServers } from '../mcp/mcp-service.js';
import { isReadOnlySdkMode, normalizeSdkMode } from '../sdk/sdk-mode.ts';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import {
  isMutatingPlanModeShellCommand,
  readPlanModeShellCommand,
  resolveReadOnlyGuardUserMessage,
} from '../sdk/sdk-plan-guard.ts';
import {
  resolveScoutNativeToolDecision,
  SCOUT_READ_ONLY_MESSAGE,
} from '../workspace-scout-read-only.js';
import {
  isReviewVerifyInvocation,
  parseReviewVerifyNodeArgs,
  runReviewVerify,
  tokenizeReviewVerifyCommand,
} from '../sdk/sdk-review-verify.ts';
import { recordDelegationVerifyResult } from '../delegation-service.js';
import {
  commandTouchesHistoryStore,
  HISTORY_STORE_DIR_NAMES,
  historyStoreBlockedMessage,
  historyStoreRipgrepGlobs,
  isHistoryStorePath,
} from './history-store-guard.ts';
import { findForeignRepoGitTarget, foreignRepoBlockedMessage } from './foreign-repo-guard.ts';
import { buildAgentChildEnv } from '../agent-env.js';
import { hostExecutionEnvironment, type ExecutionEnvironment } from '../worktree/execution-environment.ts';

const FILE_READ_MAX = 1024 * 1024;
const SHELL_TIMEOUT_MS = 120000;
const SHELL_MAX_OUTPUT = 256 * 1024;
const GREP_TIMEOUT_MS = 30000;

function requestedWorkspacePath(cwd: unknown, rel: unknown): string {
  const base = String(cwd || '').trim();
  const rest = String(rel || '').trim();
  if (!base) return '';
  return rest ? path.resolve(base, rest) : path.resolve(base);
}

function denyHistoryStore(resolved: unknown): { ok: false; output: string; error: string } | null {
  if (!isHistoryStorePath(resolved)) return null;
  return { ok: false, output: '', error: historyStoreBlockedMessage() };
}

/** Minimal MCP server row consumed by the executor. */
interface McpServerRow {
  id: string;
  kind?: string;
  runtimeName: string;
}

export interface ToolExecutionContext {
  cwd: string;
  mode: 'agent' | 'plan' | 'ask';
  assignment?: string;
  delegationId?: string;
  attemptId?: string;
  mcpContext?: object;
  checkPermission?: (name: string, args: object) => Promise<{ outcome: string; message?: string }>;
  scoutReadOnly?: boolean;
  executionEnvironment?: ExecutionEnvironment;
}

/** Result shape shared by every tool implementation. */
export interface ToolExecutionResult {
  ok: boolean;
  output: string;
  error?: string;
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

const BUILTIN_CRETILI_TOOL_NAMES = new Set(CRETILI_MCP_TOOL_DEFS.map((tool) => tool.name));

/**
 * Models sometimes garble the builtin runtime segment (`cretli_builtincretli`) or
 * re-wrap it in the bridge prefix. Resolve those to the builtin server only when
 * the name is Cretli-owned and its tool is in the builtin catalog.
 */
function resolveMisnamedBuiltinCall(
  toolName: string,
  servers: McpServerRow[],
): { server: McpServerRow; toolName: string } | null {
  const builtin = servers.find((row) => row.kind === MCP_BUILTIN_SERVER_KIND);
  if (!builtin || !isCretliBuiltinToolName(toolName)) return null;
  const canonical = resolveMcpBuiltinToolName(toolName);
  if (!BUILTIN_CRETILI_TOOL_NAMES.has(canonical)) return null;
  return { server: builtin, toolName: canonical };
}

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
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
  const scoutReadOnly = ctx?.scoutReadOnly === true;
  const mcpName = decodeMcpToolName(toolName);
  if (mcpName) {
    // resolveContextServers is untyped JS; the rows carry id/kind/runtimeName at runtime.
    const servers = resolveContextServers({ ...ctx?.mcpContext, mode, cwd }) as McpServerRow[];
    const byRuntime = findServerByRuntimeName(servers, mcpName.runtimeName) as McpServerRow | null;
    const resolved = byRuntime
      ? { server: byRuntime, toolName: mcpName.toolName }
      : resolveMisnamedBuiltinCall(toolName, servers);
    if (!resolved) {
      return { ok: false, output: '', error: `Unknown MCP tool ${toolName}` };
    }
    const { server, toolName: mcpToolName } = resolved;
    // A Scout's read-only contract is enforced against the real server identity
    // resolved from the runtime name, never against the encoded tool text.
    if (scoutReadOnly) {
      const scoutDecision = resolveScoutNativeToolDecision({
        toolName: mcpToolName,
        args: parsedArgs,
        server,
      });
      if (scoutDecision.deny) {
        return { ok: false, output: '', error: SCOUT_READ_ONLY_MESSAGE };
      }
    }
    if (ctx.checkPermission) {
      const permission = await ctx.checkPermission(toolName, parsedArgs);
      if (permission.outcome !== 'proceed') return { ok: false, output: '', error: permission.message || 'Permission denied' };
    }
    const result = await callContextTool(
      { ...ctx?.mcpContext, mode, cwd },
      server.id,
      mcpToolName,
      parsedArgs,
    );
    return {
      ok: result.ok !== false,
      output: String(result.output || ''),
      error: result.error,
    };
  }
  const isReadOnlyContext = scoutReadOnly || isReadOnlySdkMode(mode) || isReviewReadOnlyAssignment(ctx?.assignment);
  const review = isReviewReadOnlyAssignment(ctx?.assignment);
  if (scoutReadOnly) {
    // Non-MCP branch: bare native tool names carry no runtime segment, so the
    // server row cannot be resolved from config (only the MCP branch above can).
    const scoutDecision = resolveScoutNativeToolDecision({ toolName, args: parsedArgs });
    if (scoutDecision.deny) {
      return { ok: false, output: '', error: SCOUT_READ_ONLY_MESSAGE };
    }
  }
  if (isReadOnlyContext && toolName === 'run_terminal_command') {
    const command = readPlanModeShellCommand(parsedArgs.command);
    if (review && isReviewVerifyInvocation(command)) {
      return executeReviewVerify(cwd, command, ctx);
    }
    const mutating = isMutatingPlanModeShellCommand(command, {
      allowReviewVerify: review,
      // The in-process executor runs the command itself; only the catalog runner is host-isolated.
      denyReviewTestRun: true,
      projectRoot: cwd,
    });
    if (mutating) {
      return { ok: false, output: '', error: resolveReadOnlyGuardUserMessage(mode, ctx?.assignment) };
    }
  } else if (isReadOnlyContext && isMutatingToolName(toolName)) {
    return { ok: false, output: '', error: resolveReadOnlyGuardUserMessage(mode, ctx?.assignment) };
  }
  if (ctx.checkPermission) {
    const permission = await ctx.checkPermission(toolName, parsedArgs);
    if (permission.outcome !== 'proceed') return { ok: false, output: '', error: permission.message || 'Permission denied' };
  }
  switch (toolName) {
    case 'read_file':
      return executeReadFile(cwd, parsedArgs);
    case 'list_directory':
      return executeListDirectory(cwd, parsedArgs);
    case 'grep':
      return executeGrep(cwd, parsedArgs, ctx.executionEnvironment);
    case 'write_file':
      return executeWriteFile(cwd, parsedArgs);
    case 'search_replace':
      return executeSearchReplace(cwd, parsedArgs);
    case 'run_terminal_command':
      return executeShellCommand(cwd, parsedArgs, ctx.executionEnvironment);
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

function executeReadFile(cwd: string, args: Record<string, unknown>) {
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

function executeListDirectory(cwd: string, args: Record<string, unknown>) {
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

function executeGrep(cwd: string, args: Record<string, unknown>, executionEnvironment?: ExecutionEnvironment): ToolExecutionResult | Promise<ToolExecutionResult> {
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
    const rg = (executionEnvironment || hostExecutionEnvironment).spawn(undefined, 'rg', ['--line-number', '--no-heading', '--color=never', ...rgGlobs, pattern, searchDir], {
      cwd,
      env: buildAgentChildEnv('tool'),
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

function executeWriteFile(cwd: string, args: Record<string, unknown>) {
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

function executeSearchReplace(cwd: string, args: Record<string, unknown>) {
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
 * Host-owned review runner. Never shells the agent-supplied string.
 *
 * @param cwd
 * @param command
 */
async function executeReviewVerify(
  cwd: string,
  command: unknown,
  ctx: Partial<ToolExecutionContext> = {},
): Promise<ToolExecutionResult> {
  const tokens = tokenizeReviewVerifyCommand(command);
  let index = 0;
  const first = basenameReviewToken(tokens[0]);
  if (first === 'env' || first === 'command' || first === 'time') {
    index = 1;
  }
  const parsed = parseReviewVerifyNodeArgs(tokens.slice(index + 1), { projectRoot: cwd });
  if (!parsed.ok) {
    return { ok: false, output: '', error: resolveReadOnlyGuardUserMessage('agent', 'review') };
  }
  const result = await runReviewVerify({ ids: parsed.ids, projectRoot: cwd });
  await recordDelegationVerifyResult({
    delegationId: ctx.delegationId,
    attemptId: ctx.attemptId,
    result,
  });
  return { ok: result.ok, output: result.output, error: result.error };
}

function basenameReviewToken(token: unknown): string {
  const raw = String(token || '').replace(/^\\/, '').trim();
  if (!raw) return '';
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

function executeShellCommand(cwd: string, args: Record<string, unknown>, executionEnvironment?: ExecutionEnvironment): ToolExecutionResult | Promise<ToolExecutionResult> {
  const command = String(args.command || '').trim();
  if (!command) return { ok: false, output: '', error: 'Missing command' };
  if (commandTouchesHistoryStore(command)) {
    return { ok: false, output: '', error: historyStoreBlockedMessage() };
  }
  const foreignRepo = findForeignRepoGitTarget(command, cwd);
  if (foreignRepo) {
    return { ok: false, output: '', error: foreignRepoBlockedMessage(foreignRepo, cwd) };
  }
  return new Promise((resolve) => {
    try {
      assertExecutorLaunchAllowed({ type: 'tool-shell', label: command.slice(0, 200) });
    } catch (error) {
      resolve({ ok: false, output: '', error: (error as Error).message });
      return;
    }
    const child = (executionEnvironment || hostExecutionEnvironment).spawn(undefined, 'bash', ['-lc', command], {
      cwd,
      env: buildAgentChildEnv('tool'),
    });
    trackChildProcess(child, { type: 'tool-shell', label: command.slice(0, 200) });
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

function executeGitStatus(cwd: string) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const result = runGitCommand(['status', '-sb'], cwd);
  if (!result.ok) return { ok: false, output: '', error: result.error || result.stderr || 'git status failed' };
  return { ok: true, output: (result.stdout || '').trim() };
}

function executeGitDiff(cwd: string, args: Record<string, unknown>) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const rel = String(args.path || '').trim();
  const gitArgs = rel ? ['--no-pager', 'diff', 'HEAD', '--', rel.replace(/\\/g, '/')] : ['--no-pager', 'diff'];
  const result = runGitCommand(gitArgs, cwd);
  if (!result.ok) return { ok: false, output: '', error: result.error || result.stderr || 'git diff failed' };
  return { ok: true, output: (result.stdout || '').trim() || '(no diff)' };
}

function executeGitRun(cwd: string, args: Record<string, unknown>) {
  if (!isGitRepo(cwd)) return { ok: false, output: '', error: 'Not a git repository' };
  const action = String(args.action || '').trim();
  const arg = normalizeGitArg(args.arg);
  const actionMap: Record<string, (value: string) => string[]> = {
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
    switch: (value: string) => ['switch', value],
    'switch-new': (value: string) => ['switch', '-c', value],
    merge: (value: string) => ['merge', value],
    rebase: (value: string) => ['rebase', value],
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
