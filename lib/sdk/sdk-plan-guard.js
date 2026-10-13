/**
 * Shared plan-mode guard — detects file/shell mutations.
 * Read, grep, web_search, task, subagent, and read-only shell stay allowed so
 * the agent can explore in plan mode. Review may run the host-owned
 * `scripts/review-verify.js` catalog and plain `node --test tests/*.test.js`
 * (or an absolute test path inside the assigned workspace's `tests/`). Other
 * node flags, npm, and writes stay denied.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveHarnessReadOnlyPolicy } from '../agent-harness/harness-plan-policy.js';
import { normalizeAgentTransport } from '../agent-transport.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import {
  isExternalMcpToolName,
  isReadOnlyBuiltinMcpToolName,
  isReviewProtocolMcpToolName,
  readEffectiveMcpToolName,
} from '../mcp/mcp-policy.js';
import { isAskSdkMode, isReadOnlySdkMode } from './sdk-mode.js';
import { isOpaqueExecPayload, isReviewVerifyInvocation } from './sdk-review-verify.js';
import { resolveReviewLintFiles } from './sdk-review-lint.js';
import {
  ASK_GUARD_USER_MESSAGE,
  DEEPSEEK_REVIEW_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
} from './sdk-guard-messages.js';
import { resolveScoutReadOnlySdkEventDecision } from '../workspace-scout-read-only.js';

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
  if (name === 'run_terminal_command' || name === 'run_shell_command') return true;
  if (name === 'functions.exec') return true;
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

/** Fail closed when the command line is too large to classify safely. */
const SHELL_COMMAND_MAX_LENGTH = 65536;

/** Absolute prefixes for read-only system binaries (`/usr/bin/rg`). */
const TRUSTED_COMMAND_DIR_PREFIXES = ['/bin/', '/usr/bin/', '/usr/local/bin/'];

/**
 * Mask the two redirect forms that never touch the real filesystem before
 * write-redirect detection: fd duplication (`2>&1`, `>&2`, `>>&2`) and any
 * redirect whose target is exactly `/dev/null` (with an optional fd prefix).
 *
 * The `/dev/null` mask requires a word boundary after the path so that
 * `>/dev/null7` (which bash opens as a real file) is NOT masked.
 *
 * @param {string} command
 * @returns {string}
 */
function maskSafeShellRedirects(command) {
  let out = command;
  out = out.replace(/(?:^|\s)(?:\d+|&)?>>?&[0-9]+/g, ' ');
  out = out.replace(/(?:^|\s)(?:\d+|&)?>>?\s*\/dev\/null(?=$|[\s;&|])/g, ' ');
  return out;
}

/**
 * Any remaining `>` (or `>>`) writes to a real file, including digit-adjacent
 * redirects such as `echo pwned2>/tmp/out`, `printf 'x'1>/tmp/out` and
 * `cat README.md0>/tmp/out`. Read-only redirect sinks (`>&N`, `/dev/null`) are
 * masked first. Quoted content is collapsed so a `>` inside a quoted literal
 * (e.g. `grep 'a>b' lib`) is not mistaken for a redirect.
 *
 * @param {string} command
 * @returns {boolean}
 */
function hasShellWriteRedirect(command) {
  const stripped = maskSafeShellRedirects(stripQuotedShellStrings(command));
  if (/\btee\b/.test(stripped)) return true;
  return /[>]/.test(stripped);
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isTrustedCommandPathToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return false;
  if (!raw.includes('/') && !raw.includes('\\') && !raw.startsWith('.')) return true;
  if (raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('.')) return false;
  const posix = raw.replace(/\\/g, '/');
  if (!posix.startsWith('/')) return false;
  const normalized = path.posix.normalize(posix);
  return TRUSTED_COMMAND_DIR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Resolve the command basename only for bare names or trusted absolute paths.
 *
 * @param {unknown} token
 * @returns {string}
 */
function basenameCommand(token) {
  const raw = String(token || '').trim();
  if (!raw || !isTrustedCommandPathToken(raw)) return '';
  const slash = raw.lastIndexOf('/');
  return slash >= 0 ? raw.slice(slash + 1) : raw;
}

/**
 * One pass: unbalanced quotes, live expansions outside single quotes, process
 * substitution, heredocs/here-strings, and nesting/length limits.
 *
 * @param {string} command
 * @returns {boolean} true when the command must be treated as mutating/unsafe
 */
function hasUnsafeShellStructure(command) {
  const text = String(command || '');
  if (text.length > SHELL_COMMAND_MAX_LENGTH) return true;
  let quote = '';
  let parenDepth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    const next2 = text[i + 2];
    if (quote === "'") {
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        quote = '';
        continue;
      }
      if (ch === '$' && next === '(' && next2 === '(') return true;
      if (ch === '$' && next === '(') return true;
      if (ch === '$' && next === '{') return true;
      if (ch === '`') return true;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '$' && next === '(' && next2 === '(') return true;
    if (ch === '$' && next === '(') return true;
    if (ch === '$' && next === '{') return true;
    if (ch === '`') return true;
    if (ch === '<' && next === '<') return true;
    if (ch === '<' && next === '(') return true;
    if (ch === '>' && next === '(') return true;
    if (ch === '$' && next === "'") return true;
    if (ch === '$' && next === '"') return true;
    // Unbalanced parentheses outside quotes are a shell syntax error / opaque
    // grouping; fail closed rather than guessing the command's shape.
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth < 0) return true;
    }
  }
  if (quote !== '') return true;
  if (parenDepth !== 0) return true;
  // `eval`/`sudo` are only significant outside quotes; quoted literals are data.
  if (/\beval\b|\bsudo\b/.test(stripQuotedShellStrings(text))) return true;
  return false;
}

/**
 * Split on `&&`, `||`, `;`, and `|` outside quotes (escape-aware).
 *
 * Exported because `opencode-permission.js` classifies shell expansion per
 * segment too; a second splitter there would drift on quotes and redirections.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = '';
  const pushCurrent = () => {
    const part = current.trim();
    current = '';
    if (part) segments.push(part);
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = '';
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '\\') {
        if (i + 1 < command.length) {
          current += command[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === '"') quote = '';
      continue;
    }
    if (ch === '\\') {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      }
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
    if (ch === '&') {
      if (current.endsWith('>')) {
        current += ch;
        continue;
      }
      pushCurrent();
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
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
 * @returns {string[]} Tokens keep their quotes.
 */
export function tokenizeShellSegment(segment) {
  const withoutEnv = segment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/,
    '',
  );
  const tokens = [];
  let current = '';
  let quote = '';
  const pushToken = () => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < withoutEnv.length; i += 1) {
    const ch = withoutEnv[i];
    if (quote === "'") {
      current += ch;
      if (ch === "'") {
        quote = '';
        pushToken();
      }
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === '\\') {
        if (i + 1 < withoutEnv.length) {
          current += withoutEnv[i + 1];
          i += 1;
        }
        continue;
      }
      if (ch === '"') {
        quote = '';
        pushToken();
      }
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    if (ch === '\\') {
      current += ch;
      if (i + 1 < withoutEnv.length) {
        current += withoutEnv[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    current += ch;
  }
  pushToken();
  return tokens.filter((token) => token.length > 0);
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
 * Collapse the inner content of single- and double-quoted strings so downstream
 * token/redirect/keyword scans only see shell-significant characters that are
 * actually outside quotes. A single-quoted POSIX string cannot contain a quote
 * (even escaped), so a naive `[^']*` scan is exact. Double quotes honor `\"`
 * escapes before dropping the inner text. Expansions (`$(`, `${`, backticks)
 * are already rejected earlier in `hasUnsafeShellStructure`, so nothing
 * executable is hidden by collapsing these quotes here.
 *
 * @param {string} text
 * @returns {string}
 */
function stripQuotedShellStrings(text) {
  let out = '';
  let quote = '';
  const value = String(text || '');
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote === '') {
      if (ch === "'" || ch === '"') {
        quote = ch;
        out += ch;
        continue;
      }
      out += ch;
    } else if (quote === "'") {
      if (ch === "'") {
        quote = '';
        out += ch;
        continue;
      }
      // Drop inner single-quoted content.
    } else {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        quote = '';
        out += ch;
        continue;
      }
      // Drop inner double-quoted content.
    }
  }
  return out;
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
/**
 * Leading `NAME=value` environment assignments are stripped before command
 * classification (so `PATH=. rg x` stays a read-only probe). A handful of
 * variables let `git`/`less`/the shell run an arbitrary program on the command's
 * input or output; those must not be silently stripped in plan/ask mode.
 */
const DANGEROUS_ENV_VAR_NAMES = new Set([
  'GIT_EXTERNAL_DIFF',
  'LESSOPEN',
  'LESSCLOSE',
  'GIT_PAGER',
  'BASH_ENV',
  'ENV',
]);

/**
 * @param {string} segment
 * @returns {boolean}
 */
function hasDangerousEnvPrefix(segment) {
  const text = String(segment || '');
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|\S*)\s+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (DANGEROUS_ENV_VAR_NAMES.has(match[1])) return true;
  }
  return false;
}

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
/**
 * `git -c <key>=<value>` keys that cannot execute anything. `safe.directory`
 * only marks a path as safe to read (the documented `dubious ownership` fix);
 * every other config key is denied because many (`core.pager`, `core.editor`,
 * `core.hooksPath`, `alias.*`, …) can run arbitrary commands.
 */
const GIT_SAFE_CONFIG_KEYS = /^safe\.directory$/;

function isReadOnlyGitInvocation(args) {
  let index = 0;
  let sawUnsafeConfig = false;
  while (index < args.length) {
    const token = args[index];
    if (!token.startsWith('-') || token === '--') break;
    const configMatch = token.match(/^(?:-c|--config=?)(.*)$/);
    if (configMatch) {
      let spec = configMatch[1];
      if (!spec && index + 1 < args.length) {
        spec = args[index + 1];
        index += 1;
      }
      const key = spec.split('=')[0];
      if (!GIT_SAFE_CONFIG_KEYS.test(key)) sawUnsafeConfig = true;
      index += 1;
      continue;
    }
    if (token === '-C') {
      index += 2;
      continue;
    }
    index += 1;
  }
  if (sawUnsafeConfig) return false;
  const subcommand = args[index] || '';
  if (subcommand === 'remote') return isReadOnlyGitRemoteInvocation(args.slice(index + 1));
  // `--output` and `--ext-diff` let `diff`/`log`/`show`/`shortlog` write a file
  // or run an external diff program on every read-only subcommand.
  if (subcommand === 'diff' || subcommand === 'log' || subcommand === 'show' || subcommand === 'shortlog') {
    const rest = args.slice(index + 1).map((entry) => stripWrappingQuotes(entry));
    if (rest.some((entry) => /^--output(?:=|$)/.test(entry) || entry === '--ext-diff')) return false;
  }
  return PLAN_MODE_READONLY_GIT_SUBCOMMANDS.has(subcommand);
}

/**
 * @param {string} token
 * @returns {string}
 */
function shellTokenLiteral(token) {
  return stripWrappingQuotes(String(token || ''));
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function findHasMutatingFlag(args) {
  const forbidden = new Set([
    '-delete', '-exec', '-ok', '-execdir', '-okdir', '-fprint', '-fprintf', '-fls',
  ]);
  for (const token of args) {
    const literal = shellTokenLiteral(token);
    if (forbidden.has(literal)) return true;
    if (/^-(?:[^-\s]*delete|exec|ok|fprint|fprintf|fls)/.test(literal)) return true;
  }
  return false;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function sedHasMutatingScript(args) {
  for (const token of args) {
    const literal = shellTokenLiteral(token);
    // `-i` / `--in-place` edits the file in place.
    if (/^-[a-zA-Z]*i/.test(literal)) return true;
    if (literal === '--in-place' || literal.startsWith('--in-place')) return true;
    // `s` command whose flags contain `e` (execute), `w` or `W` (write) is mutating.
    const sMatch = literal.match(/^s(.)(?:\\.|(?!\1)[\s\S])*?\1(?:\\.|(?!\1)[\s\S])*?\1([a-zA-Z]*)/);
    if (sMatch && /[ewW]/.test(sMatch[2])) return true;
    // Standalone `w` / `W` command writes its output to a file.
    if (/\b[wW]\s+\S/.test(literal)) return true;
  }
  return false;
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function awkHasMutatingInvocation(args) {
  const raw = args.map(shellTokenLiteral).join(' ');
  if (/\bsystem\s*\(/i.test(raw)) return true;
  // awk's `|` operator pipes a `print`/`getline` to a shell command, executing
  // it. Collapse quoted strings and `/regex/` literals first so benign field
  // separators (`-F'|'`) and alternation patterns (`/a|b/`) are not mistaken
  // for a pipe-to-command.
  const cleaned = raw
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/\/[^/\n]*\//g, '//');
  return /\|/.test(cleaned);
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function rgHasMutatingFlag(args) {
  return args.some((token) => {
    const literal = shellTokenLiteral(token);
    return literal === '--pre' || literal.startsWith('--pre=');
  });
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function sortHasMutatingFlag(args) {
  return args.some((token) => {
    const literal = shellTokenLiteral(token);
    // `-o`, a bundled short flag that includes `o` (e.g. `-ro`), `--output`
    // (separate or `=`-joined), and `--compress-program` all write to / invoke
    // a file.
    if (literal === '-o' || /^-[a-zA-Z]*o/.test(literal)) return true;
    if (literal === '--output' || literal.startsWith('--output=')) return true;
    if (literal === '--compress-program' || literal.startsWith('--compress-program')) return true;
    return false;
  });
}

/**
 * Reject `-f` / `--file`, which make `awk`/`sed` read their program from a file
 * instead of the command line. The file content is unclassified and trivially
 * bypasses the script checks above.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function hasShellFileFlag(args) {
  return args.some((token) => {
    const literal = shellTokenLiteral(token);
    if (literal === '-f' || literal === '--file' || literal.startsWith('--file=')) return true;
    // Bundled short flag that includes `f` (e.g. `sed -nf prog`).
    return literal.length > 1 && literal.startsWith('-') && !literal.startsWith('--') && /f/.test(literal.slice(1));
  });
}

/**
 * @param {string[]} args
 * @returns {boolean}
 */
function pagerHasShellEscape(args) {
  return args.some((token) => {
    const literal = shellTokenLiteral(token);
    // `!` (history expansion / shell escape) and `-c` (command) are escapes.
    if (literal.includes('!')) return true;
    if (literal === '-c' || literal.startsWith('-c')) return true;
    return false;
  });
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
 * @param {{ allowReviewVerify?: boolean, projectRoot?: string }} [options]
 * @returns {boolean}
 */
function isReadOnlyShellSegment(segment, options = {}) {
  // env-var prefix (PATH=. node ...) strips before matcher but not before executor/advisor —
  // disallow in review-verify path to prevent PATH=./evil overrides.
  if (options.allowReviewVerify === true && /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(segment || '').trim())) {
    return false;
  }
  // A leading `NAME=value` whose variable lets git/less/the shell execute a
  // program is rejected outright (external-diff / pager-injection vector).
  if (hasDangerousEnvPrefix(segment)) return false;
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
  const reviewTokens = tokens.slice(index).filter((token) => !isSafeOutputRedirectToken(token));
  if (options.allowReviewVerify === true && isReviewVerifyInvocation(reviewTokens)) {
    return true;
  }
  if (options.allowReviewVerify === true && isReviewNodeTestInvocation(reviewTokens, options.projectRoot)) {
    return true;
  }
  if (options.allowReviewVerify === true && reviewTokens[0] === 'node' && reviewTokens[1] === 'scripts/review-lint.js') {
    return resolveReviewLintFiles(reviewTokens.slice(2).map(stripWrappingQuotes), options.projectRoot) !== null;
  }
  if (!name || !PLAN_MODE_READONLY_SHELL_COMMANDS.has(name)) return false;
  if (name === 'git') return isReadOnlyGitInvocation(rest);
  if (name === 'find' && findHasMutatingFlag(rest)) return false;
  if (name === 'sed' && (sedHasMutatingScript(rest) || hasShellFileFlag(rest))) return false;
  if (name === 'awk' && (awkHasMutatingInvocation(rest) || hasShellFileFlag(rest))) return false;
  if (name === 'rg' && rgHasMutatingFlag(rest)) return false;
  if (name === 'ripgrep' && rgHasMutatingFlag(rest)) return false;
  if (name === 'sort' && sortHasMutatingFlag(rest)) return false;
  if (name === 'uniq' && uniqWritesFile(rest)) return false;
  if ((name === 'less' || name === 'more') && pagerHasShellEscape(rest)) return false;
  return true;
}

/**
 * `uniq [input [output]]` — a second positional operand is an output file, so
 * `uniq in out` writes. A single positional (or none) reads and prints to stdout.
 *
 * @param {string[]} args
 * @returns {boolean}
 */
function uniqWritesFile(args) {
  const positionals = args.filter((token) => !shellTokenLiteral(token).startsWith('-'));
  return positionals.length >= 2;
}

/**
 * A review test may use a relative tests path or an absolute path inside the
 * assigned workspace's tests directory. Symlink escapes are rejected.
 *
 * @param {string[]} tokens
 * @returns {boolean}
 */
function isShellRedirectToken(token) {
  const literal = stripWrappingQuotes(String(token || ''));
  if (!literal) return false;
  if (/^\d+>&\d+$/.test(literal)) return true;
  // Any redirect token (`>/file`, `2>/dev/null`, `2>>&1`); `\S+` already covers
  // the `/dev/null` sink, so it is not listed separately.
  if (/^\d?>>?\S+$/.test(literal)) return true;
  return false;
}

function isSafeOutputRedirectToken(token) {
  return /^(?:\d*>&\d+|\d*>>?\/dev\/null)$/.test(String(token || ''));
}

function isReviewNodeTestInvocation(tokens, projectRoot) {
  if (!Array.isArray(tokens) || tokens.length < 2) return false;
  const rawBin = String(tokens[0] || '').trim();
  if (rawBin.includes('/') || rawBin.includes('\\')) return false;
  const bin = basenameCommand(rawBin);
  if (bin !== 'node' && bin !== 'nodejs') return false;
  const args = tokens.slice(1)
    .map((token) => stripWrappingQuotes(token))
    .filter((token) => !isShellRedirectToken(token));
  const files = args[0] === '--test' ? args.slice(1) : args;
  if (files.length === 0) return false;
  return files.every((file) => isReviewTestFileArg(file, projectRoot));
}

/**
 * @param {string} token
 * @returns {boolean}
 */
function isReviewTestFileArg(token, projectRoot) {
  if (!token || token.startsWith('-')) return false;
  if (token.includes('\\') || token.split('/').includes('..')) return false;
  if (/^(?:\.\/)?tests\/[\w./-]+\.test\.js$/.test(token)) return true;
  if (!path.isAbsolute(token) || typeof projectRoot !== 'string' || !projectRoot.trim()) return false;
  const testRoot = path.join(path.resolve(projectRoot), 'tests');
  const absoluteFile = path.resolve(token);
  const relativeFile = path.relative(testRoot, absoluteFile);
  if (
    !relativeFile
    || relativeFile === '..'
    || relativeFile.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeFile)
  ) return false;
  if (!/^[\w./-]+\.test\.js$/.test(relativeFile)) return false;
  try {
    const realTestRoot = fs.realpathSync(testRoot);
    const realFile = fs.realpathSync(absoluteFile);
    const realRelativeFile = path.relative(realTestRoot, realFile);
    return realRelativeFile !== ''
      && realRelativeFile !== '..'
      && !realRelativeFile.startsWith(`..${path.sep}`)
      && !path.isAbsolute(realRelativeFile)
      && fs.statSync(realFile).isFile();
  } catch {
    return false;
  }
}

/**
 * Shell is mutating unless every segment is a known read-only explorer command.
 * Review may also run the host-owned review-verify catalog and plain node
 * tests under `tests/`.
 *
 * @param {unknown} command
 * @param {{ allowReviewVerify?: boolean, projectRoot?: string }} [options]
 * @returns {boolean}
 */
export function isMutatingPlanModeShellCommand(command, options = {}) {
  const text = readPlanModeShellCommand(command).trim();
  if (!text) return false;
  if (hasUnsafeShellStructure(text)) return true;
  if (hasShellWriteRedirect(text)) return true;
  const segments = splitShellSegments(text);
  if (segments.length === 0) return true;
  return segments.some((segment) => !isReadOnlyShellSegment(segment, options));
}

/**
 * @param {unknown} event SDK-shaped event (normalized stream).
 * @param {{ allowReviewVerify?: boolean, projectRoot?: string }} [options]
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
  DEEPSEEK_REVIEW_GUARD_USER_MESSAGE,
  PLAN_GUARD_USER_MESSAGE,
  REVIEW_GUARD_USER_MESSAGE,
};

/**
 * @param {unknown} mode
 * @param {unknown} [assignment]
 * @returns {string}
 */
export function resolveReadOnlyGuardUserMessage(mode, assignment, transport) {
  if (isReviewReadOnlyAssignment(assignment)) {
    if (normalizeAgentTransport(transport) === 'deepseek') return DEEPSEEK_REVIEW_GUARD_USER_MESSAGE;
    return REVIEW_GUARD_USER_MESSAGE;
  }
  return isAskSdkMode(mode) ? ASK_GUARD_USER_MESSAGE : PLAN_GUARD_USER_MESSAGE;
}

/**
 * @typedef {{ deny: boolean, abortRun: boolean, notify: boolean }} PlanModeToolDecision
 */

export { resolveScoutReadOnlySdkEventDecision };

/**
 * Host-side Plan/Ask decision for a normalized tool_call event.
 * Codex Plan stays prompt-only; Ask still denies mutations before execution.
 * Review classifies native and host shells by command: read-only explorers
 * plus the host-owned review-verify runner. Mutating shell is denied.
 * @param {{ transport?: unknown, mode?: unknown, assignment?: unknown, event?: unknown, scoutReadOnly?: unknown, mcpServer?: unknown, projectRoot?: string }} [input]
 * @returns {PlanModeToolDecision}
 */
export function resolvePlanModeSdkEventDecision(input = {}) {
  const idle = { deny: false, abortRun: false, notify: false };
  // A Scout runs in agent mode; its read-only contract is enforced here, before
  // the tool executes, and never inferred from the transport mode.
  if (input.scoutReadOnly === true) {
    return resolveScoutReadOnlySdkEventDecision(input.event, input.mcpServer);
  }
  const review = isReviewReadOnlyAssignment(input.assignment);
  if (!isReadOnlySdkMode(input.mode) && !review) return idle;
  const policy = resolveHarnessReadOnlyPolicy(input.transport, input.mode, input.assignment);
  if (!policy.denyMutatingTools) return idle;
  const eventName = getSdkToolCallName(input.event);
  if (isExternalMcpToolName(eventName)) {
    const mcpName = readEffectiveMcpToolName(eventName, readToolCallArgs(input.event));
    if (isReadOnlyBuiltinMcpToolName(mcpName, input.mcpServer)) return idle;
    if (isReviewProtocolMcpToolName(mcpName)) return idle;
    if (!review) return idle;
    return {
      deny: true,
      abortRun: false,
      notify: true,
    };
  }
  // DeepSeek review runs inside DSH's enforced read-only filesystem sandbox.
  // Let its shell commands reach that sandbox: the generic command classifier
  // cannot safely inspect parser scripts such as Python used to analyze trace
  // files. Keep functions.exec payloads guarded because they are host-side JS,
  // not commands executed by the DSH shell sandbox.
  if (
    review
    && normalizeAgentTransport(input.transport) === 'deepseek'
    && eventName === 'bash'
  ) return idle;
  if (!isPlanModeMutatingSdkEvent(input.event, {
    allowReviewVerify: review,
    projectRoot: input.projectRoot,
  })) return idle;
  return {
    deny: true,
    abortRun: policy.abortOnMutation === true,
    notify: true,
  };
}

/**
 * Host-side Plan decision before a canUseTool / executor call.
 * @param {{ transport?: unknown, mode?: unknown, assignment?: unknown, toolName?: unknown, input?: unknown, scoutReadOnly?: unknown, mcpServer?: unknown, projectRoot?: string }} [options]
 * @returns {PlanModeToolDecision}
 */
export function resolvePlanModeToolDecision(options = {}) {
  const args = options.input && typeof options.input === 'object' ? options.input : {};
  return resolvePlanModeSdkEventDecision({
    transport: options.transport,
    mode: options.mode,
    assignment: options.assignment,
    scoutReadOnly: options.scoutReadOnly,
    mcpServer: options.mcpServer,
    projectRoot: options.projectRoot,
    event: {
      type: 'tool_call',
      name: options.toolName,
      status: 'running',
      args,
    },
  });
}
