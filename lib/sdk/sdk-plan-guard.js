/**
 * Shared plan-mode guard — detects file/shell mutations.
 * Read, grep, web_search, task, subagent, and read-only shell stay allowed so
 * the agent can explore in plan mode.
 */

import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.js';

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
  'web.search',
  'web_fetch',
  'web_search',
  'webfetch',
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
  const basename = planModeToolBasename(name);
  if (PLAN_MODE_READONLY_TOOL_NAMES.has(name) || PLAN_MODE_READONLY_TOOL_NAMES.has(basename)) {
    return false;
  }
  if (name === 'shell' || name.startsWith('shell.')) return true;
  if (PLAN_MODE_MUTATING_TOOL_NAMES.has(name)) return true;
  if (name.startsWith('mcp.')) return true;
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
    if (ch === ';' || ch === '|') {
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
 * Normalize a plan-guard shell command from a string or argv array.
 *
 * @param {unknown} command
 * @returns {string}
 */
export function readPlanModeShellCommand(command) {
  if (Array.isArray(command)) {
    const joined = command.map((part) => String(part ?? '')).join(' ').trim();
    return unwrapShellWrapperOnce(joined);
  }
  return unwrapShellWrapperOnce(String(command || ''));
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
  return PLAN_MODE_READONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isReadOnlyShellSegment(segment) {
  const tokens = tokenizeShellSegment(segment);
  if (tokens.length === 0) return false;
  let index = 0;
  while (index < tokens.length && (tokens[index] === 'command' || tokens[index] === 'env' || tokens[index] === 'time')) {
    index += 1;
  }
  const name = basenameCommand(tokens[index] || '');
  if (!name || !PLAN_MODE_READONLY_SHELL_COMMANDS.has(name)) return false;
  const rest = tokens.slice(index + 1);
  if (name === 'git') return isReadOnlyGitInvocation(rest);
  if (name === 'find' && rest.some((token) => token === '-delete' || token === '-exec' || token === '-ok')) {
    return false;
  }
  if (name === 'sed' && rest.some((token) => token === '-i' || token.startsWith('-i'))) return false;
  return true;
}

/**
 * Shell is mutating unless every segment is a known read-only explorer command.
 *
 * @param {unknown} command
 * @returns {boolean}
 */
export function isMutatingPlanModeShellCommand(command) {
  const text = readPlanModeShellCommand(command).trim();
  if (!text) return false;
  const unquoted = stripQuotedShellStrings(text);
  if (/[`]|\$\(|\beval\b|\bsudo\b/.test(unquoted)) return true;
  if (hasShellWriteRedirect(unquoted)) return true;
  const segments = splitShellSegments(text);
  if (segments.length === 0) return true;
  return segments.some((segment) => !isReadOnlyShellSegment(segment));
}

/**
 * @param {unknown} event SDK-shaped event (normalized stream).
 * @returns {boolean}
 */
export function isPlanModeMutatingSdkEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const ev = /** @type {Record<string, unknown>} */ (event);
  if (ev.type !== 'tool_call') return false;
  const status = typeof ev.status === 'string' ? ev.status.trim().toLowerCase() : '';
  if (status && status !== 'running' && status !== 'started' && status !== 'pending') return false;
  const name = getSdkToolCallName(ev);
  if (name === 'bash' || name === 'shell' || name.startsWith('shell.')) {
    return isMutatingPlanModeShellCommand(readToolCallCommand(ev));
  }
  return isPlanModeMutatingToolName(name);
}

export const PLAN_GUARD_USER_MESSAGE =
  'Plan mode blocked execution. Switch to Agent mode to apply changes.';

/**
 * @typedef {{ deny: boolean, abortRun: boolean, notify: boolean }} PlanModeToolDecision
 */

/**
 * Host-side Plan decision for a normalized tool_call event.
 * Codex keeps denyMutatingTools false (prompt-only, no abort).
 * @param {{ transport?: unknown, mode?: unknown, event?: unknown }} [input]
 * @returns {PlanModeToolDecision}
 */
export function resolvePlanModeSdkEventDecision(input = {}) {
  const idle = { deny: false, abortRun: false, notify: false };
  const policy = resolveHarnessPlanPolicy(input.transport);
  if (String(input.mode || '').trim().toLowerCase() !== 'plan') return idle;
  if (!policy.denyMutatingTools) return idle;
  if (!isPlanModeMutatingSdkEvent(input.event)) return idle;
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
    event: {
      type: 'tool_call',
      name: options.toolName,
      status: 'running',
      args,
    },
  });
}
