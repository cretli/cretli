/**
 * Shared plan-mode guard — detects file/shell mutations.
 * Read, grep, task, subagent, and read-only shell stay allowed so Codex can explore.
 */

export const PLAN_MODE_MUTATING_TOOL_NAMES = new Set([
  'edit',
  'write',
  'delete',
  'mcp',
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
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isPlanModeMutatingToolName(toolName) {
  const name = String(toolName || '').trim().toLowerCase();
  if (!name) return false;
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
  if (typeof args.command === 'string') return args.command;
  if (typeof args.cmd === 'string') return args.cmd;
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
 * @param {string} command
 * @returns {string[]}
 */
function splitShellSegments(command) {
  const cleaned = command.replace(/[12]>&[12]/g, ' ');
  return cleaned
    .split(/(?:&&|\|\||[;|])/)
    .map((part) => part.trim())
    .filter(Boolean);
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
  return withoutEnv.trim().split(/\s+/).filter(Boolean);
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
  const name = (tokens[index] || '').replace(/^\\/, '');
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
  const text = String(command || '').trim();
  if (!text) return true;
  if (/[`]|\$\(|\beval\b|\bsudo\b/.test(text)) return true;
  if (hasShellWriteRedirect(text)) return true;
  if (/\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|dd|truncate|mkfifo|install)\b/.test(text)) {
    return true;
  }
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
  if (name === 'shell' || name.startsWith('shell.')) {
    return isMutatingPlanModeShellCommand(readToolCallCommand(ev));
  }
  return isPlanModeMutatingToolName(name);
}

export const PLAN_GUARD_USER_MESSAGE =
  'Plan mode blocked execution. Switch to Agent mode to apply changes.';
