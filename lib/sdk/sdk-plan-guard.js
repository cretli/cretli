/**
 * Shared plan-mode guard — detects file/shell mutations.
 * Read, grep, web_search, task, subagent, and read-only shell stay allowed so
 * the agent can explore in plan mode. Review may run the host-owned
 * `scripts/review-verify.js` catalog and plain `node --test tests/*.test.js`
 * (or `node tests/*.test.js`). Other node flags, npm, and writes stay denied.
 */

import { resolveHarnessReadOnlyPolicy } from '../agent-harness/harness-plan-policy.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import {
  isExternalMcpToolName,
  isReadOnlyBuiltinMcpToolName,
  isReviewProtocolMcpToolName,
  readEffectiveMcpToolName,
} from '../mcp/mcp-policy.js';
import { isAskSdkMode, isReadOnlySdkMode } from './sdk-mode.js';
import { isOpaqueExecPayload, isReviewVerifyInvocation } from './sdk-review-verify.js';
import {
  ASK_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
} from './sdk-guard-messages.js';

export const PLAN_MODE_MUTATING_TOOL_NAMES = new Set([
  'edit',
  'write',
  'delete',
  'mcp',
]);

const PLAN_MODE_READONLY_TOOL_NAMES = new Set([
  'grep',
  'glob',
  'read',
  'semsearch',
  'subagent',
  'task',
  'todo',
  'todo_write',
  'todowrite',
  'web.search',
  'web_fetch',
  'web_search',
  'webfetch',
]);

/**
 * Claude Code native tools that only read/inspect or report progress. Names
 * are lowercase and include the SDK 0.3.284 canonical aliases (`Agent` for the
 * legacy `Task`, `TaskStop` for `KillShell`, `ListMcpResourcesTool` for
 * `ListMcpResources`). `Skill` only loads a skill's instructions; any file or
 * shell mutation a skill suggests still travels through `Bash`/`Edit`/`Write`,
 * which the guard classifies on its own.
 */
const CLAUDE_READ_ONLY_TOOL_NAMES = new Set([
  'agent',
  'askuserquestion',
  'bashoutput',
  'exitplanmode',
  'listmcpresources',
  'listmcpresourcestool',
  'readmcpresource',
  'readmcpresourcedir',
  'readmcpresourcedirtool',
  'readmcpresourcetool',
  'skill',
  'task', // legacy alias for Agent
]);

/**
 * Claude Code native tools that mutate files/notebooks or stop background
 * work. `KillShell`/`KillBash` (SDK alias `TaskStop`) terminate a running
 * process, so they are denied in read-only modes.
 */
const CLAUDE_MUTATING_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'notebookedit',
  'write',
  'killshell',
  'killbash',
  'taskstop',
]);

const PLAN_MODE_READONLY_SHELL_COMMANDS = new Set([
  'awk',
  'basename',
  'bat',
  'cat',
  'cd',
  'column',
  'cut',
  'date',
  'df',
  'dirname',
  'du',
  'echo',
  'egrep',
  'env',
  'false',
  'fgrep',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'hostname',
  'id',
  'jq',
  'less',
  'ls',
  'more',
  'nl',
  'printenv',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'ripgrep',
  'sed',
  'sort',
  'stat',
  'tail',
  'test',
  'tree',
  'tr',
  'true',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
]);

const PLAN_MODE_READONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'ls-tree',
  'rev-list',
  'rev-parse',
  'shortlog',
  'show',
  'status',
]);

/** `git remote` / `git remote -v` only. `show` and `get-url` print; they do not write. */
const READONLY_GIT_REMOTE_LIST_FLAGS = new Set(['-v', '--verbose']);
const READONLY_GIT_REMOTE_ACTIONS = new Set(['show', 'get-url']);

/** Tokens left after splitting `for`/`if`/`while` bodies on `;`. */
const PLAN_MODE_SHELL_CONTROL_TOKENS = new Set([
  '!',
  '[[',
  ']]',
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'if',
  'in',
  'select',
  'then',
  'until',
  'while',
  '{',
  '}',
]);

/**
 * Native shell / exec names, including OpenRouter's terminal wrapper.
 *
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isPlanModeShellToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  if (name === 'bash' || name === 'shell' || name === 'exec') return true;
  if (name === 'run_terminal_command' || name === 'functions.exec') return true;
  return name.startsWith('shell.');
}

/**
 * Last dotted segment (`mcp.web_search` → `web_search`).
 *
 * @param {string} name
 * @returns {string}
 */
function planModeToolBasename(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

/**
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isPlanModeMutatingToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
  if (isExternalMcpToolName(name)) return true;
  const basename = planModeToolBasename(name);
  if (
    PLAN_MODE_READONLY_TOOL_NAMES.has(name)
    || PLAN_MODE_READONLY_TOOL_NAMES.has(basename)
    || CLAUDE_READ_ONLY_TOOL_NAMES.has(name)
    || CLAUDE_READ_ONLY_TOOL_NAMES.has(basename)
  ) {
    return false;
  }
  if (name === 'shell' || name.startsWith('shell.')) return true;
  if (
    PLAN_MODE_MUTATING_TOOL_NAMES.has(name)
    || CLAUDE_MUTATING_TOOL_NAMES.has(name)
    || CLAUDE_MUTATING_TOOL_NAMES.has(basename)
  ) {
    return true;
  }
  if (name.includes('write') || name.includes('delete') || name.includes('edit')) return true;
  return false;
}

/**
 * @param {unknown} event
 * @returns {string}
 */
export function getSdkToolCallName(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  const raw = typeof ev.name === 'string' ? ev.name : '';
  return raw.trim().toLowerCase();
}

/**
 * @param {unknown} event
 * @returns {string}
 */
function readToolCallCommand(event) {
  if (!event || typeof event !== 'object') return '';
  const ev = /** @type {Record<string, unknown>} */ (event);
  const args = ev.args && typeof ev.args === 'object'
    ? /** @type {Record<string, unknown>} */ (ev.args)
    : null;
  if (!args) return '';
  if (typeof args.command === 'string' || Array.isArray(args.command)) {
    return readPlanModeShellCommand(args.command);
  }
  if (typeof args.cmd === 'string' || Array.isArray(args.cmd)) {
    return readPlanModeShellCommand(args.cmd);
  }
  return '';
}

/**
 * @param {unknown} event
 * @returns {Record<string, unknown> | null}
 */
function readToolCallArgs(event) {
  if (!event || typeof event !== 'object') return null;
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (!ev.args || typeof ev.args !== 'object' || Array.isArray(ev.args)) return null;
  return /** @type {Record<string, unknown>} */ (ev.args);
}

/**
 * @param {string} command
 * @returns {boolean}
 */
function hasShellWriteRedirect(command) {
  const stripped = command
    .replace(/(?:^|\s)(?:\d+|&)?>+\s*\/dev\/null/g, ' ')
    .replace(/(?:^|\s)2>>?\s*\S+/g, ' ');
  if (/\btee\b/.test(stripped)) return true;
  return /(?:^|[^0-9&])>{1,2}/.test(stripped);
}

/**
 * Split on `&&`, `||`, `;`, and `|` outside quotes so `rg 'a|b|delete'` stays one segment.
 *
 * @param {string} command
 * @returns {string[]}
 */
function splitShellSegments(command) {
  const cleaned = command.replace(/[12]>&[12]/g, ' ');
  const segments = [];
  let current = '';
  let quote = '';
  const pushCurrent = () => {
    const part = current.trim();
    current = '';
    if (part) segments.push(part);
  };
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      pushCurrent();
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n' || ch === '&') {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return segments;
}

/**
 * @param {string} segment
 * @returns {string[]}
 */
function tokenizeShellSegment(segment) {
  const withoutEnv = segment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/,
    '',
  );
  const tokens = withoutEnv.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  return tokens || [];
}

/**
 * Drop quoted strings so `|`, `$(`, and `>` inside `rg` patterns are not shell syntax.
 *
 * @param {string} command
 * @returns {string}
 */
function stripQuotedShellStrings(command) {
  let out = '';
  let quote = '';
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Last path segment of a command token (`/bin/bash` → `bash`).
 *
 * @param {unknown} token
 * @returns {string}
 */
function basenameCommand(token) {
  const raw = String(token || '').replace(/^\\/, '').trim();
  if (!raw) return '';
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * @param {string} text
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
 * Codex (and some CLIs) wrap exec as `/bin/bash -lc 'script'` or argv
 * `["/bin/bash", "-lc", "script"]`. Classify the inner script, not `bash`.
 *
 * @param {string} command
 * @returns {string}
 */
function unwrapShellWrapperOnce(command) {
  const text = String(command || '').trim();
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens || tokens.length < 2) return text;
  const bin = basenameCommand(tokens[0]);
  if (bin !== 'bash' && bin !== 'sh') return text;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.startsWith('-') || token === '--') break;
    index += 1;
    if (!token.slice(1).includes('c')) continue;
    const script = tokens.slice(index).join(' ');
    return stripWrappingQuotes(script) || text;
  }
  return text;
}

/**
 * Codex `parsed_cmd` entries are objects (`{ cmd }`). Stringifying them yields
 * `[object Object]`, which the review guard treats as a mutation and aborts
 * the whole job. Read the command text instead.
 *
 * @param {unknown} part
 * @returns {string}
 */
function shellCommandPartText(part) {
  if (typeof part === 'string') return part.trim();
  if (!part || typeof part !== 'object') return '';
  const row = /** @type {Record<string, unknown>} */ (part);
  if (typeof row.cmd === 'string' && row.cmd.trim()) return row.cmd.trim();
  if (typeof row.command === 'string' && row.command.trim()) return row.command.trim();
  return '';
}

/**
 * Normalize a plan-guard shell command from a string or argv array.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function readPlanModeShellCommand(command) {
  if (Array.isArray(command)) {
    const objectParts = command.some((part) => part && typeof part === 'object');
    if (objectParts) {
      const cmds = command.map(shellCommandPartText).filter(Boolean);
      return unwrapShellWrapperOnce(cmds.join(' && '));
    }
    const joined = command.map((part) => String(part ?? '')).join(' ').trim();
    return unwrapShellWrapperOnce(joined);
  }
  return unwrapShellWrapperOnce(String(command || ''));
}

/**
 * Listing and URL lookup. `add`, `remove`, `rename`, `set-url`, and `prune` stay denied.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function isReadOnlyGitRemoteInvocation(args) {
  let index = 0;
  while (index < args.length && READONLY_GIT_REMOTE_LIST_FLAGS.has(args[index])) {
    index += 1;
  }
  if (index >= args.length) return true;
  const action = args[index] || '';
  if (!action || action.startsWith('-')) return false;
  return READONLY_GIT_REMOTE_ACTIONS.has(action);
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function isReadOnlyGitInvocation(args) {
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token.startsWith('-') || token === '--') break;
    if (token === '-C' || token === '-c') {
      index += 2;
      continue;
    }
    index += 1;
  }
  const subcommand = args[index] || '';
  if (subcommand === 'remote') return isReadOnlyGitRemoteInvocation(args.slice(index + 1));
  return PLAN_MODE_READONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * Skip wrappers and `for p in a b` / `do then fi` prefixes. Splitting on `;`
 * leaves those fragments without a command body; they are not mutations.
 *
 * @param {string[]} tokens
 * @returns {number}
 */
function skipReadOnlyShellPrefix(tokens) {
  let index = 0;
  while (index < tokens.length) {
    const raw = String(tokens[index] || '').trim();
    if (raw.includes('/') || raw.includes('\\')) break;
    const name = basenameCommand(raw);
    if (name === 'command' || name === 'env' || name === 'time') {
      index += 1;
      continue;
    }
    if (name === 'for') {
      index += 1;
      if (index < tokens.length) index += 1;
      if (tokens[index] === 'in') {
        index += 1;
        while (index < tokens.length && tokens[index] !== 'do') {
          index += 1;
        }
      }
      continue;
    }
    if (PLAN_MODE_SHELL_CONTROL_TOKENS.has(name)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/**
 * @param {string} segment
 * @param {{ allowReviewVerify?: boolean }} [options]
 * @returns {boolean}
 */
function isReadOnlyShellSegment(segment, options = {}) {
  // env-var prefix (PATH=. node ...) strips before matcher but not before executor/advisor —
  // disallow in review-verify path to prevent PATH=./evil overrides.
  if (options.allowReviewVerify === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(segment || '').trim())) {
    return false;
  }
  const tokens = tokenizeShellSegment(segment);
  if (tokens.length === 0) return false;
  const index = skipReadOnlyShellPrefix(tokens);
  if (index >= tokens.length) return true;
  const name = basenameCommand(tokens[index] || '');
  const rest = tokens.slice(index + 1);
  // A wrapper (env/command/time) with a path separator in the token passes
  // execution to its arguments. Block it: we can't verify it's the real binary.
  const rawMainToken = String(tokens[index] || '').trim();
  if (
    (name === 'env' || name === 'command' || name === 'time')
    && (rawMainToken.includes('/') || rawMainToken.includes('\\'))
  ) return false;
  if (options.allowReviewVerify === true && isReviewVerifyInvocation(tokens.slice(index))) {
    return true;
  }
  if (options.allowReviewVerify === true && isReviewNodeTestInvocation(tokens.slice(index))) {
    return true;
  }
  if (!name || !PLAN_MODE_READONLY_SHELL_COMMANDS.has(name)) return false;
  if (name === 'git') return isReadOnlyGitInvocation(rest);
  if (name === 'find' && rest.some((token) => token === '-delete' || token === '-exec' || token === '-ok')) {
    return false;
  }
  if (name === 'sed' && rest.some((token) => token === '-i' || token.startsWith('-i'))) return false;
  return true;
}

/**
 * A review test run is `node --test tests/<file>.test.js` or
 * `node tests/<file>.test.js`. No other flags, no absolute paths, no `..`.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isReviewNodeTestInvocation(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 2) return false;
  const rawBin = String(tokens[0] || '').trim();
  if (rawBin.includes('/') || rawBin.includes('\\')) return false;
  const bin = basenameCommand(rawBin);
  if (bin !== 'node' && bin !== 'nodejs') return false;
  const args = tokens.slice(1).map((token) => stripWrappingQuotes(token));
  const files = args[0] === '--test' ? args.slice(1) : args;
  if (files.length === 0) return false;
  return files.every(isReviewTestFileArg);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isReviewTestFileArg(token) {
  if (!token || token.startsWith('-')) return false;
  if (token.includes('..') || token.startsWith('/') || token.includes('\\')) return false;
  return /^(?:\.\/)?tests\/[\w./-]+\.test\.js$/.test(token);
}

/**
 * Shell is mutating unless every segment is a known read-only explorer command.
 * Review may also run the host-owned review-verify catalog and plain node
 * tests under `tests/`.
 *
 * @param {unknown} command
 * @param {{ allowReviewVerify?: boolean }} [options]
 * @returns {boolean}
 */
export function isMutatingPlanModeShellCommand(command, options = {}) {
  const text = readPlanModeShellCommand(command).trim();
  if (!text) return false;
  const unquoted = stripQuotedShellStrings(text);
  if (/[`]|\$\(|\beval\b|\bsudo\b/.test(unquoted)) return true;
  if (hasShellWriteRedirect(unquoted)) return true;
  const segments = splitShellSegments(text);
  if (segments.length === 0) return true;
  return segments.some((segment) => !isReadOnlyShellSegment(segment, options));
}

/**
 * @param {unknown} event SDK-shaped event (normalized stream).
 * @param {{ allowReviewVerify?: boolean }} [options]
 * @returns {boolean}
 */
export function isPlanModeMutatingSdkEvent(event, options = {}) {
  if (!event || typeof event !== 'object') return false;
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'tool_call') return false;
  const status = typeof ev.status === 'string' ? ev.status.trim().toLowerCase() : '';
  if (status && status !== 'running' && status !== 'started' && status !== 'pending') return false;
  const name = getSdkToolCallName(ev);
  if (isPlanModeShellToolName(name)) {
    const args = readToolCallArgs(ev);
    if (isOpaqueExecPayload(args)) return true;
    const command = readToolCallCommand(ev);
    if (name === 'functions.exec' && !command) return true;
    return isMutatingPlanModeShellCommand(command, options);
  }
  return isPlanModeMutatingToolName(name);
}

// Owned by `sdk-guard-messages.js` (a leaf module) and re-exported here so the
// existing import sites keep working without pulling the tool catalog in.
export {
  ASK_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
} from './sdk-guard-messages.js';

/**
 * @param {unknown} mode
 * @param {unknown} [assignment]
 * @returns {string}
 */
export function resolveReadOnlyGuardUserMessage(mode, assignment) {
  if (isReviewReadOnlyAssignment(assignment)) return REVIEW_GUARD_USER_MESSAGE;
  return isAskSdkMode(mode) ? ASK_GUARD_USER_MESSAGE : PLAN_GUARD_USER_MESSAGE;
}

/**
 * @typedef {{ deny: boolean, abortRun: boolean, notify: boolean }} PlanModeToolDecision
 */

/**
 * Host-side Plan/Ask decision for a normalized tool_call event.
 * Codex Plan stays prompt-only; Ask still denies mutations before execution.
 * Review classifies native and host shells by command: read-only explorers
 * plus the host-owned review-verify runner. Mutating shell is denied.
 * @param {{ transport?: unknown, mode?: unknown, assignment?: unknown, event?: unknown }} [input]
 * @returns {PlanModeToolDecision}
 */
export function resolvePlanModeSdkEventDecision(input = {}) {
  const idle = { deny: false, abortRun: false, notify: false };
  const review = isReviewReadOnlyAssignment(input.assignment);
  if (!isReadOnlySdkMode(input.mode) && !review) return idle;
  const policy = resolveHarnessReadOnlyPolicy(input.transport, input.mode, input.assignment);
  if (!policy.denyMutatingTools) return idle;
  const eventName = getSdkToolCallName(input.event);
  if (isExternalMcpToolName(eventName)) {
    const mcpName = readEffectiveMcpToolName(eventName, readToolCallArgs(input.event));
    if (isReadOnlyBuiltinMcpToolName(mcpName)) return idle;
    if (isReviewProtocolMcpToolName(mcpName)) return idle;
    if (!review) return idle;
    return {
      deny: true,
      abortRun: false,
      notify: true,
    };
  }
  if (!isPlanModeMutatingSdkEvent(input.event, { allowReviewVerify: review })) return idle;
  return {
    deny: true,
    abortRun: policy.abortOnMutation === true,
    notify: true,
  };
}

/**
 * Host-side Plan decision before a canUseTool / executor call.
 * @param {{ transport?: unknown, mode?: unknown, toolName?: unknown, input?: unknown }} [options]
 * @returns {PlanModeToolDecision}
 */
export function resolvePlanModeToolDecision(options = {}) {
  const args = options.input && typeof options.input === 'object' ? options.input : {};
  return resolvePlanModeSdkEventDecision({
    transport: options.transport,
    mode: options.mode,
    assignment: options.assignment,
    event: {
      type: 'tool_call',
      name: options.toolName,
      status: 'running',
      args,
    },
  });
}
