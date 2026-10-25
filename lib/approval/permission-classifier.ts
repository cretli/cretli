import { isHarnessPermissionControlDisabled } from './harness-permission-controls.ts';
/**
 * Harness-neutral permission classifier and approval policy. It started as the
 * OpenCode permission skill; every harness now routes its tool requests through
 * `resolveApprovalAction` (can-use-tool-adapter, plan guards, the approval
 * broker), so it lives in core. The OpenCode-only part — SSE event normalization
 * and the HTTP reply — is in harnesses/opencode/opencode-permission.js, which also
 * re-exports these functions under their former `OpenCode` names. Policy facts
 * (plan policy, per-category controls, engine profile) are still evaluated with
 * the `opencode` profile for every caller, exactly as before the move.
 */

import path from 'node:path';

import { resolveHarnessPlanPolicy } from '../agent-harness/harness-plan-policy.ts';
import { isMutatingPlanModeShellCommand, isPlanModeMutatingToolName } from '../sdk/sdk-plan-guard.ts';
import {
  collectShellInvocations,
  splitShellSegments,
  tokenizeShellSegment,
} from './shell-command-parse.ts';
import { resolvePlanGuardMcpServerIdentity } from '../mcp/mcp-session.js';
import { resolveScoutNativeToolDecision } from '../workspace-scout-read-only.js';
import { isReviewReadOnlyAssignment } from '../delegation-review-policy.js';
import { extractWorkspaceEditTarget } from './workspace-edit-policy.ts';
import { isReadOnlySdkMode } from '../sdk/sdk-mode.ts';
import {
  APPROVAL_BROKER_POLICY_VERSION,
  normalizeApprovalBrokerMode,
} from './approval-broker.ts';
import { resolvePermissionPolicyOutcome } from './permission-engine.ts';

export type PermissionReply = 'once' | 'always' | 'reject';

type InvocationLike = { name: string; args: string[] };

/**
 * Plan denies file edits at the engine. Bash is `ask` so read-only shell can
 * explore; Cretli still auto-rejects mutating commands.
 *
 * @param mode
 * @param options
 */
export function buildPlanPermissionRuleset(
  mode: unknown,
  options: { review?: boolean; scoutReadOnly?: boolean } = {},
): Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }> {
  // Reviews run in Agent mode so the model can inspect the workspace. Give
  // their session an explicit shell ask path; the host approval handler then
  // auto-allows safe reads and rejects mutations before OpenCode executes them.
  // A Scout chat is always agent mode but stays strictly read-only.
  if (options.review === true || options.scoutReadOnly === true) {
    return [
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ];
  }
  if (isReadOnlySdkMode(mode)) {
    return [
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: '*', action: 'ask' },
    ];
  }
  return [
    { permission: 'edit', pattern: '*', action: 'ask' },
    { permission: 'bash', pattern: '*', action: 'ask' },
  ];
}

function readPermissionCommand(record: Record<string, unknown>): string {
  const metadata = record.metadata && typeof record.metadata === 'object'
    ? (record.metadata as Record<string, unknown>)
    : null;
  if (typeof metadata?.command === 'string' && metadata.command.trim()) {
    return metadata.command.trim();
  }
  const resources = Array.isArray(record.resources) ? record.resources : [];
  return resources
    .filter((entry: unknown) => typeof entry === 'string' && entry.trim())
    .map((entry: unknown) => String(entry).trim())
    .join('; ');
}

/**
 * @param permissionEvent
 * @param options
 */
export function isPlanMutatingPermission(
  permissionEvent: unknown,
  options: { allowReviewVerify?: boolean; projectRoot?: string } = {},
): boolean {
  if (!permissionEvent || typeof permissionEvent !== 'object') return false;
  const record = (permissionEvent as Record<string, unknown>);
  const action = String(record.action || '').trim().toLowerCase();
  if (action === 'bash' || action === 'shell' || action.startsWith('shell.')) {
    const command = readPermissionCommand(record);
    if (command) return isMutatingPlanModeShellCommand(command, options);
    return true;
  }
  if (isPlanModeMutatingToolName(action)) return true;
  if (/\b(edit|write|delete)\b/.test(action)) return true;
  const saveOptions = Array.isArray(record.saveOptions) ? record.saveOptions : [];
  return saveOptions.some((entry: unknown) => {
    const name = String(entry || '').toLowerCase();
    if (name === 'bash' || name === 'shell') {
      const command = readPermissionCommand(record);
      if (command) return isMutatingPlanModeShellCommand(command, options);
      return true;
    }
    return isPlanModeMutatingToolName(entry) || /\b(edit|write|delete)\b/.test(name);
  });
}

/**
 * Auto-reject mutating OpenCode permissions in Plan, an active review or a
 * read-only Scout chat before the tool runs.
 * @param mode
 * @param permissionEvent
 * @param assignment
 * @param options
 */
export function shouldRejectPlanPermission(
  mode: unknown,
  permissionEvent: unknown,
  assignment?: unknown,
  options: { scoutReadOnly?: boolean; projectRoot?: string; room?: object } = {},
): boolean {
  const review = isReviewReadOnlyAssignment(assignment);
  const scoutReadOnly = options.scoutReadOnly === true;
  if (scoutReadOnly) {
    if (!permissionEvent || typeof permissionEvent !== 'object') return true;
    const record = (permissionEvent as Record<string, unknown>);
    const action = String(record.action || '').trim();
    const metadata = record.metadata && typeof record.metadata === 'object'
      ? (record.metadata as Record<string, unknown>)
      : {};
    const command = readPermissionCommand(record);
    const mcpServer = resolvePlanGuardMcpServerIdentity({
      room: options.room,
      harness: 'opencode',
      toolName: action,
      args: command ? { ...metadata, command } : metadata,
    });
    const decision = resolveScoutNativeToolDecision({
      toolName: action,
      args: command ? { ...metadata, command } : metadata,
      server: mcpServer,
    });
    return decision.deny;
  }
  if (!scoutReadOnly && !isReadOnlySdkMode(mode) && !review) return false;
  if (!review && !scoutReadOnly && !resolveHarnessPlanPolicy('opencode').denyMutatingTools) return false;
  return isPlanMutatingPermission(permissionEvent, {
    allowReviewVerify: review,
    projectRoot: options.projectRoot,
  });
}

/**
 * Review delegations auto-allow non-mutating OpenCode permissions (DSH approval
 * never parity) so fanout reviews are not blocked on shell read probes.
 *
 * @param mode
 * @param permissionEvent
 * @param assignment
 * @param options
 */
export function shouldAutoAllowReviewPermission(
  mode: unknown,
  permissionEvent: unknown,
  assignment?: unknown,
  options: { projectRoot?: string } = {},
): boolean {
  if (!isReviewReadOnlyAssignment(assignment)) return false;
  return !shouldRejectPlanPermission(mode, permissionEvent, assignment, { projectRoot: options.projectRoot });
}

/**
 * Delegated children may inspect the assigned workspace without waiting for a
 * browser permission card. Mutating tools remain interactive; this only
 * removes the deadlock where an implementer cannot even locate its TODO.
 * @param mode
 * @param permissionEvent
 * @param assignment
 * @param options
 */
export function shouldAutoAllowDelegationPermission(
  mode: unknown,
  permissionEvent: unknown,
  assignment: unknown,
  options: { projectRoot?: string } = {},
): boolean {
  const normalized = String(assignment || '').trim().toLowerCase();
  if (normalized !== 'review' && normalized !== 'implement') return false;
  if (normalized === 'review') return shouldAutoAllowReviewPermission(mode, permissionEvent, assignment, options);
  return !isPlanMutatingPermission(permissionEvent);
}

/**
 * Denylist overlay on top of the shared plan-guard heuristics. It never
 * replaces `isMutatingPlanModeShellCommand` / `isPlanModeMutatingToolName`; it
 * only marks actions the broker must never auto-approve (network, secrets,
 * production/privilege, destructive).
 */
const APPROVAL_NETWORK_TOOL_RE = /^(web[._]?(fetch|search)|webfetch|websearch|http[._]?request|fetch|browser)$/;
const APPROVAL_NETWORK_COMMAND_RE = /\b(curl|wget|nc|netcat|ncat|ssh|scp|sftp|rsync|telnet|ftp|lftp|gh\s+api|npm\s+(install|i|ci|add|publish|exec)|pnpm\s+(install|add|publish|dlx)|yarn\s+(add|install|publish|dlx)|bun\s+(add|install|x)|pip3?\s+install|uv\s+(pip|add)|poetry\s+add|apt(-get)?\s+(install|update|upgrade)|brew\s+(install|upgrade)|go\s+get|gem\s+install|cargo\s+install|docker\s+pull|git\s+(fetch|pull|clone|push))\b/i;
const APPROVAL_SECRET_TEXT_RE = /(^|[\\/\s"'`=(])(\.env(\.[a-z0-9]+)?|\.envrc|id_rsa|id_ed25519|credentials|auth\.json|mcp-secrets\.json|\.cretli-sdk\.env|\.npmrc|\.netrc|[^\s\\/]+\.(pem|p12|pfx|key))($|[\s"'`),;:|&<>])/i;
const APPROVAL_SECRET_COMMAND_RE = /(^|\s)(cat\s+\S*(\.env|id_rsa|id_ed25519|\.pem|credentials|auth\.json|mcp-secrets\.json)|grep\s+[^\n]*(\.env|id_rsa|credentials)|rg\s+[^\n]*(\.env|id_rsa|credentials)|aws\s+configure|gcloud\s+auth|gh\s+auth\s+token|op\s+item\s+get|kubectl\s+get\s+secrets?)(\s|$)/i;
// Cretli keeps API keys and runtime secrets in `data/`; a plain `config.json`
// name is too generic for the shared denylist above, so scope it to that dir.
const APPROVAL_CRETLI_DATA_SECRET_RE = /(^|[\\/\s"'`=(])data[\\/](config\.json|mcp-secrets\.json|mcp-integration-secret\.json|mcp-tx\.json|mcp\.json|auth\.json|sessions\.json|vapid-keys\.json|push-subscriptions\.json|key\.pem|cert\.pem)($|[\s"'`),;:|&<>])/i;
// Segment right after `data/` in a normalized token.
const APPROVAL_CRETLI_DATA_ENTRY_RE = /^(config\.json|mcp-secrets\.json|mcp-integration-secret\.json|mcp-tx\.json|mcp\.json|auth\.json|sessions\.json|vapid-keys\.json|push-subscriptions\.json|key\.pem|cert\.pem)$/i;
// Glob or brace expansion in that segment could expand to a secret file.
const APPROVAL_GLOB_SEGMENT_RE = /[*?[{]/;
// `cd data && cat config.json` hides the `data/` prefix from the token check.
const APPROVAL_CD_DATA_RE = /(^|[;&|(]\s*)cd\s+["']?(\.\/)?data\/?["']?($|[\s;&|)])/i;
// Environment dumps in command position (`env`, `env|head`, `; printenv`).
const APPROVAL_ENV_DUMP_RE = /(^|[;&|(]\s*)(\S*\/)?(printenv|env|export|set|declare)($|[\s;&|)<>])/;
// Variables, command substitution and `~` resolve outside what the token check
// can see (HOME may even sit inside `data/`), so such commands never get an
// automatic reply. Single-quoted text is literal in the shell and is stripped
// before this check.
const APPROVAL_SHELL_EXPANSION_RE = /[$`]|(^|[\s"'=:(])~/;
// The same pattern without `$`: backticks and a leading `~` are never exempt.
const APPROVAL_SHELL_UNSAFE_EXPANSION_RE = /`|(^|[\s"'=:(])~/;
// `$?` (exit status), `$#` (argument count) and `$$` (own pid) read no
// environment and no file. Their value can still be pasted into a path, so the
// exemption below covers printed arguments only.
const APPROVAL_SHELL_SAFE_PARAM_CHARS = new Set(['?', '#', '$']);
// Builtins whose arguments are only printed to stdout.
const APPROVAL_SHELL_PRINTING_COMMANDS = new Set(['echo', 'printf']);
// Privilege binaries in command position, including an optional path prefix
// (`/usr/bin/sudo`). A hyphenated filename such as `chat-title-service.js`
// must not match `service` — `\b` treats the hyphen as a word boundary.
const APPROVAL_PRIVILEGE_COMMAND_RE = /(?:^|[;&|(`\n]|&&|\|\|)\s*(?:[\w.+@/-]*\/)?(?:sudo|doas|chmod|chown|chgrp|setfacl|systemctl|service|kill|pkill|killall|mount|umount|useradd|usermod|passwd|visudo|docker|kubectl|helm|deploy|supervisorctl)\b|(?:^|[;&|(`\n]|&&|\|\|)\s*(?:terraform\s+apply|ansible-playbook|pm2\s+(?:start|stop|restart|delete)|npm\s+publish)\b/i;
const APPROVAL_DESTRUCTIVE_COMMAND_RE = /(^|\s)(rm|rmdir|shred|truncate|dd|mkfs|fdisk|parted|shutdown|reboot|halt|poweroff)(\s|$)|:\(\)\s*\{/i;
// A nested shell (`bash -c 'env'`) runs its quoted argument as a command.
const APPROVAL_NESTED_SHELL_RE = /(^|[\s;&|(])(\S*\/)?(ba|z|da|k)?sh\s+(-\w+\s+)*-\w*c\b/;
const APPROVAL_QUOTED_TEXT_RE = /'[^']*'|"(?:\\.|[^"\\])*"/g;

// Command-name rules on the parsed invocations (`collectShellInvocations`:
// command word of each segment, wrapper targets such as `env sudo ls`, and the
// commands inside `bash -c "..."`). They are ADDED to the regexes above, which
// stay as the fallback for forms the parser does not model (`find -exec curl`,
// `awk 'BEGIN{system(...)}'`, `(curl x)`). Guarantee: classification is never
// more lenient than the raw-text regex baseline; structured invocations only
// add categories and never hide or neutralize any part of the command.
const APPROVAL_NETWORK_BINARIES = new Set([
  'curl', 'wget', 'nc', 'netcat', 'ncat', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'lftp',
]);
// Binary -> subcommands that reach the network or a registry.
const APPROVAL_NETWORK_SUBCOMMANDS = new Map<string, string[]>([
  ['gh', ['api']],
  ['npm', ['install', 'i', 'ci', 'add', 'publish', 'exec']],
  ['pnpm', ['install', 'add', 'publish', 'dlx']],
  ['yarn', ['add', 'install', 'publish', 'dlx']],
  ['bun', ['add', 'install', 'x']],
  ['pip', ['install']],
  ['pip3', ['install']],
  ['uv', ['pip', 'add']],
  ['poetry', ['add']],
  ['apt', ['install', 'update', 'upgrade']],
  ['apt-get', ['install', 'update', 'upgrade']],
  ['brew', ['install', 'upgrade']],
  ['go', ['get']],
  ['gem', ['install']],
  ['cargo', ['install']],
  ['docker', ['pull']],
  ['git', ['fetch', 'pull', 'clone', 'push']],
]);
const APPROVAL_PRIVILEGE_BINARIES = new Set([
  'sudo', 'doas', 'chmod', 'chown', 'chgrp', 'setfacl', 'systemctl', 'service', 'kill', 'pkill', 'killall',
  'mount', 'umount', 'useradd', 'usermod', 'passwd', 'visudo', 'docker', 'kubectl', 'helm', 'deploy',
  'supervisorctl', 'ansible-playbook',
]);
const APPROVAL_PRIVILEGE_SUBCOMMANDS = new Map<string, string[]>([
  ['terraform', ['apply']],
  ['pm2', ['start', 'stop', 'restart', 'delete']],
  ['npm', ['publish']],
]);
const APPROVAL_DESTRUCTIVE_BINARIES = new Set([
  'rm', 'rmdir', 'shred', 'truncate', 'dd', 'mkfs', 'fdisk', 'parted', 'shutdown', 'reboot', 'halt', 'poweroff',
]);

/**
 * First non-option word of an invocation; `git -C dir` / `git -c k=v` options
 * consume their value.
 *
 * @param invocation
 */
function readInvocationSubcommand(invocation: InvocationLike): string {
  const { args } = invocation;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i];
    if (invocation.name === 'git' && (word === '-C' || word === '-c')) {
      i += 1;
      continue;
    }
    if (!word.startsWith('-')) return word.toLowerCase();
  }
  return '';
}

function invocationMatches(
  invocation: InvocationLike,
  binaries: Set<string>,
  subcommands: Map<string, string[]>,
): boolean {
  if (binaries.has(invocation.name)) return true;
  const wanted = subcommands.get(invocation.name);
  return Boolean(wanted && wanted.includes(readInvocationSubcommand(invocation)));
}

/**
 * Text for the command-position checks (env dump, `cd data`, privilege).
 * Quoted arguments are data, so a search pattern such as
 * `rg 'register|export|tools'` must not read as a `| export` pipeline stage.
 * With a nested shell the quotes hold a command line and become separators.
 *
 * @param command
 */
function readCommandPositionText(command: string): string {
  if (APPROVAL_NESTED_SHELL_RE.test(command)) return command.replace(/["']/g, ';');
  return command.replace(APPROVAL_QUOTED_TEXT_RE, "''");
}

/**
 * Backslash-escaped quotes (`\'`, `\"`) are not POSIX single-quote literals;
 * naive `'[^']*'` pairing then hides command-position tokens inside fake quotes.
 *
 * @param command
 */
function hasUnreliableShellQuotePairing(command: string): boolean {
  return /\\['"]/.test(command);
}

function matchesCommandPositionPattern(command: string, pattern: RegExp, commandPosition: string): boolean {
  if (pattern.test(commandPosition)) return true;
  if (!command || !hasUnreliableShellQuotePairing(command)) return false;
  return pattern.test(command);
}

/**
 * Quote pairing the segment walk can reason about. An unterminated quote makes
 * the rest of the segment data or syntax unpredictably, so such a segment never
 * gets the printing exemption.
 *
 * @param text
 */
function hasBalancedShellQuotes(text: string): boolean {
  let single = 0;
  let double = 0;
  for (const ch of text) {
    if (ch === "'") single += 1;
    else if (ch === '"') double += 1;
  }
  return single % 2 === 0 && double % 2 === 0;
}

/**
 * True when every `$` in the text is `$?`, `$#` or `$$`. `${…}`, `$(…)`, `$NAME`,
 * `$@`, `$1`, an escaped `\$` and a trailing bare `$` all stay unsafe.
 *
 * @param text
 */
function onlySafeShellParams(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '$') {
      index += 1;
      continue;
    }
    if (index > 0 && text[index - 1] === '\\') return false;
    if (!APPROVAL_SHELL_SAFE_PARAM_CHARS.has(text[index + 1])) return false;
    // Consume the whole parameter so the second `$` of `$$` is not read as
    // another expansion missing its tail.
    index += 2;
  }
  return true;
}

/**
 * A segment that can only print: `echo`/`printf` with no path separator and no
 * redirection. `cat /proc/$$/environ`, `tail -f /tmp/x $$`, `echo … > file` and
 * a nested shell are not printing segments, so a pid- or exit-derived path
 * never loses the `expansion` flag.
 *
 * @param text Segment text with single-quoted literals already stripped.
 */
function isVerifiedPrintingSegment(text: string): boolean {
  if (/[<>/]/.test(text)) return false;
  if (!hasBalancedShellQuotes(text)) return false;
  const tokens = tokenizeShellSegment(text);
  return tokens.length > 0 && APPROVAL_SHELL_PRINTING_COMMANDS.has(tokens[0]);
}

/**
 * Replace truly single-quoted spans with '' for expansion scans. A `'` inside
 * double quotes is literal and does not start a single-quoted region. Backslash
 * escapes the next character outside single quotes.
 *
 * @param text
 */
function stripShellSingleQuotedLiterals(text: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  // Unclosed single-quoted span kept for expansion scan when quotes do not balance.
  let unclosedSingleLiteral = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        unclosedSingleLiteral = '';
        out += "''";
      } else {
        unclosedSingleLiteral += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '\\') {
        if (i + 1 < text.length) {
          i += 1;
          out += '\\';
          out += text[i];
        } else {
          out += ch;
        }
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        out += ch;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      if (i + 1 < text.length) {
        i += 1;
        out += text[i];
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inSingle && unclosedSingleLiteral) {
    out += `'${unclosedSingleLiteral}`;
  }
  return out;
}

function shellSegmentExpandsUnsafely(segment: string): boolean {
  const text = stripShellSingleQuotedLiterals(segment);
  if (!text.includes('$')) return false;
  if (!isVerifiedPrintingSegment(text)) return true;
  return !onlySafeShellParams(text);
}

/**
 * Expansion risk of a command line, reusing the shared plan-guard segment
 * analysis. `$?`, `$#` and `$$` printed by `echo`/`printf` read nothing, so they
 * no longer raise `expansion` (and with it `high`) on the exit-code probe that
 * follows every test run. `$VAR`, `${…}`, `$(…)`, backticks, `~`, an escaped
 * `$`, an unbalanced quote, a nested shell, a path or a redirection argument are
 * classified exactly as before. The exemption changes only the risk category —
 * these parameters are still shell expansions, and no executable-command
 * allowlist is widened by it.
 *
 * @param command
 */
function hasApprovalShellExpansion(command: string): boolean {
  if (!command) return false;
  const stripped = stripShellSingleQuotedLiterals(command);
  if (APPROVAL_SHELL_UNSAFE_EXPANSION_RE.test(stripped)) return true;
  // Backslash-escaped quotes make single-quote stripping unreliable: the raw
  // command is the only conservative read there.
  if (hasUnreliableShellQuotePairing(command) && APPROVAL_SHELL_EXPANSION_RE.test(command)) return true;
  if (!stripped.includes('$')) return false;
  return splitShellSegments(command).some(shellSegmentExpandsUnsafely);
}

function readApprovalText(permissionEvent: unknown): { action: string; command: string; text: string } {
  const record = permissionEvent && typeof permissionEvent === 'object'
    ? (permissionEvent as Record<string, unknown>)
    : {};
  const action = String(record.action || '').trim();
  const command = readPermissionCommand(record);
  const resources = Array.isArray(record.resources)
    ? record.resources.filter((entry: unknown) => typeof entry === 'string' && entry.trim()).map((entry: unknown) => String(entry).trim())
    : [];
  const text = [action, command, ...resources].filter(Boolean).join(' ');
  return { action, command, text };
}

/**
 * Normalizes each path-like token (`data/./config.json`, `HEAD:data/x`,
 * `'data/'config.json`, `DATA/*.json`) so the `data/` secret check does not
 * depend on how the path is spelled. A `data/` directory target (`rg x data/`)
 * counts too, except for a plain `ls` listing.
 *
 * Quoting policy differs from `isPermissionWithinWorkspace()` on
 * purpose: secret detection strips quotes so it can see through
 * `'data/'config.json`, while path confinement zeroes quoted content because
 * there a quote marks data, not an argument.
 *
 * @param text
 * @param command
 */
function hasCretliDataSecretToken(text: string, command: string): boolean {
  const isListing = /^\s*ls(\s|$)/.test(command);
  const unquoted = text.replace(/["'\\]/g, '');
  for (const match of unquoted.matchAll(/[^\s`;|&<>()=:{},]+/g)) {
    const segments = path.posix.normalize(match[0]).toLowerCase().split('/');
    const index = segments.lastIndexOf('data');
    if (index < 0) continue;
    const entry = segments[index + 1] || '';
    if (!entry) {
      const isRootData = index === 0 || segments[0] === '';
      if (isRootData && match[0].includes('/') && !isListing) return true;
      continue;
    }
    if (APPROVAL_CRETLI_DATA_ENTRY_RE.test(entry) || APPROVAL_GLOB_SEGMENT_RE.test(entry)) return true;
  }
  return false;
}

/**
 * @param permissionEvent
 * @param workspaceFolder
 */
export function isPermissionWithinWorkspace(permissionEvent: unknown, workspaceFolder: unknown): boolean {
  const root = String(workspaceFolder || '').trim();
  if (!root) return false;
  const workspace = path.resolve(root);
  const record = permissionEvent && typeof permissionEvent === 'object'
    ? (permissionEvent as Record<string, unknown>)
    : {};
  const resources = Array.isArray(record.resources)
    ? record.resources.filter((entry: unknown) => typeof entry === 'string' && entry.trim()).map((entry: unknown) => String(entry).trim())
    : [];
  const command = readPermissionCommand(record);
  const candidates: string[] = [];
  for (const raw of resources) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^file:\/\//i.test(raw)) return false;
    if (/^file:\/\//i.test(raw)) {
      try {
        candidates.push(new URL(raw).pathname);
      } catch {
        return false;
      }
    } else {
      candidates.push(raw);
    }
  }
  // Absolute paths are arguments even when quoted (`cat '/etc/passwd'`), so
  // this scan keeps the raw command.
  const absolutePathPattern = /(?:^|[\s"'=])(\/|~\/)([^\s"'`;|&]*)/g;
  for (const match of command.matchAll(absolutePathPattern)) {
    candidates.push(`${match[1]}${match[2]}`);
  }
  // Relative tokens that climb out of the workspace (`..`, `cd ..`, `../x`,
  // `./../x`, `lib/../../x`). Token regex, not a shell parser: a bare `..` or
  // any token with a `..` segment and a separator is resolved against the root.
  // Scan quoted-as-data text, because a quote boundary here would turn a search
  // pattern into a path: `grep -r 'foo' '../i18n'` reads `'../i18n'` as an
  // escaped path. A nested shell still exposes its argument since quotes become
  // separators. Accepted trade-off: `cat '../etc/shadow'` is no longer flagged —
  // quoted text is data. Unquoted `..` escapes and absolute paths stay caught.
  const relativeScanText = readCommandPositionText(command);
  const relativeTokenPattern = /(?:^|[\s"'`=(])([^\s"'`;|&<>()]*)/g;
  for (const match of relativeScanText.matchAll(relativeTokenPattern)) {
    const token = String(match[1] || '');
    const isParentToken = token === '..' || (token.includes('..') && token.includes('/'));
    if (!isParentToken) continue;
    candidates.push(token);
  }
  return candidates.every((candidate) => {
    const value = String(candidate || '').replace(/[),:]+$/, '');
    if (!value) return true;
    const resolved = value.startsWith('~/')
      ? path.resolve(process.env.HOME || '/', value.slice(2))
      : path.resolve(workspace, value);
    const relative = path.relative(workspace, resolved);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

/**
 * Deterministic risk classification for an OpenCode permission request.
 *
 * @param permissionEvent
 * @param options
 */
export function classifyPermissionRisk(
  permissionEvent: unknown,
  options: { allowReviewVerify?: boolean; projectRoot?: string } = {},
): {
  categories: string[];
  risk: 'low' | 'medium' | 'high';
  action: string;
  command: string;
} {
  const { action, command, text } = readApprovalText(permissionEvent);
  const normalizedAction = action.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const categories: string[] = [];
  if (isPlanMutatingPermission(permissionEvent, options)) categories.push('mutation');
  const invocations = command ? collectShellInvocations(command) : [];
  if (
    APPROVAL_NETWORK_TOOL_RE.test(normalizedAction)
    || APPROVAL_NETWORK_COMMAND_RE.test(command || text)
    || invocations.some((entry) => invocationMatches(entry, APPROVAL_NETWORK_BINARIES, APPROVAL_NETWORK_SUBCOMMANDS))
  ) {
    categories.push('network');
  }
  if (APPROVAL_SECRET_TEXT_RE.test(text) || APPROVAL_SECRET_COMMAND_RE.test(text)) categories.push('secrets');
  const commandPosition = readCommandPositionText(command);
  if (
    matchesCommandPositionPattern(command, APPROVAL_ENV_DUMP_RE, commandPosition)
    || APPROVAL_CD_DATA_RE.test(command)
  ) categories.push('secrets');
  if (APPROVAL_CRETLI_DATA_SECRET_RE.test(text) || hasCretliDataSecretToken(text, command)) categories.push('secrets');
  if (hasApprovalShellExpansion(command)) categories.push('expansion');
  if (
    APPROVAL_PRIVILEGE_COMMAND_RE.test(command ? commandPosition : text)
    || matchesCommandPositionPattern(command, APPROVAL_PRIVILEGE_COMMAND_RE, commandPosition)
    || invocations.some((entry) => invocationMatches(entry, APPROVAL_PRIVILEGE_BINARIES, APPROVAL_PRIVILEGE_SUBCOMMANDS))
  ) categories.push('privilege');
  if (
    APPROVAL_DESTRUCTIVE_COMMAND_RE.test(command || text)
    || invocations.some((entry) => APPROVAL_DESTRUCTIVE_BINARIES.has(entry.name) || entry.name.startsWith('mkfs.'))
  ) categories.push('destructive');
  let risk: 'low' | 'medium' | 'high' = 'low';
  if (categories.some((entry) => entry !== 'mutation')) risk = 'high';
  else if (categories.includes('mutation')) risk = 'medium';
  return { categories, risk, action, command };
}

export interface ApprovalActionInput {
  mode?: unknown;
  sdkMode?: unknown;
  permissionEvent?: unknown;
  assignment?: unknown;
  workspaceFolder?: string;
  scoutReadOnly?: boolean;
  settings?: object;
}

export interface ApprovalAction {
  mode: string;
  decision: 'allow' | 'deny' | 'ask_user';
  reply: 'once' | 'reject' | null;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  confidence: number;
  policyVersion: string;
  categories: string[];
  action: string;
  command: string;
  shadow: boolean;
  notifyUser: boolean;
  editTarget: ReturnType<typeof extractWorkspaceEditTarget>;
}

/**
 * Pure local decision for the OpenCode approval broker MVP. Reuses the existing
 * plan/review guard and delegation auto-allow helpers — it never carries its own
 * command-name allowlist.
 *
 * `off` keeps the pre-broker auto-allow for delegated reads, but only inside the
 * assigned workspace and never for secrets; interactive permissions stay
 * manual. `shadow` computes a recommendation but never sends a reply.
 * `local_reads` auto-replies `once` only for safe local reads (delegation reads
 * or interactive read probes) and never for network/secrets/privilege/mutation.
 *
 * @param input
 */
export function resolveApprovalAction(input: ApprovalActionInput = {}): ApprovalAction {
  const mode = normalizeApprovalBrokerMode(input.mode);
  const permissionEvent = input.permissionEvent;
  const assignment = input.assignment;
  const review = isReviewReadOnlyAssignment(assignment);
  const scoutReadOnly = input.scoutReadOnly === true;
  const classification = classifyPermissionRisk(permissionEvent, {
    allowReviewVerify: review,
    projectRoot: input.workspaceFolder,
  });
  const guardDenied = shouldRejectPlanPermission(
    input.sdkMode,
    permissionEvent,
    assignment,
    { scoutReadOnly, projectRoot: input.workspaceFolder },
  );
  const legacyDelegationAllow = scoutReadOnly
    ? false
    : shouldAutoAllowDelegationPermission(
      input.sdkMode,
      permissionEvent,
      assignment,
      { projectRoot: input.workspaceFolder },
    );
  const unsafe = classification.risk === 'high';
  const legacySafeRead = !guardDenied && !unsafe && !classification.categories.includes('mutation');
  const safeRead = legacySafeRead && isPermissionWithinWorkspace(
    permissionEvent,
    input.workspaceFolder,
  );
  const delegationRead = legacyDelegationAllow && safeRead;
  const interactiveRead = !String(assignment || '').trim() && safeRead;

  // The ordered pipeline lives in the harness-neutral engine; this adapter only
  // supplies OpenCode-specific facts and maps the decision to the legacy shape.
  const decision = resolvePermissionPolicyOutcome({
    harness: 'opencode',
    workspace: input.workspaceFolder,
    permission: classification.action,
    policyVersion: APPROVAL_BROKER_POLICY_VERSION,
    hardBlock: { blocked: guardDenied },
    broker: {
      mode,
      risk: classification.risk,
      categories: classification.categories,
      delegationRead,
      interactiveRead,
    },
  });
  const legacyDecision = decision.state === 'deny'
    ? 'deny'
    : decision.state === 'allow_once' || decision.state === 'shadow_allow'
      ? 'allow'
      : 'ask_user';
  const base = {
    mode,
    risk: classification.risk,
    confidence: 1,
    policyVersion: APPROVAL_BROKER_POLICY_VERSION,
    categories: classification.categories,
    action: classification.action,
    command: classification.command,
    // Consumed only by the advisor `workspace_edits` scope; null for non-edits.
    editTarget: extractWorkspaceEditTarget(permissionEvent, {
      workspaceFolder: input.workspaceFolder,
      // OpenCode's permission patterns are relative to the instance directory.
      worktree: input.workspaceFolder,
      assignment,
    }),
  };

  if (!guardDenied && isHarnessPermissionControlDisabled(input.settings, 'opencode', classification.action)) {
    return { ...base, decision: 'allow', reply: 'once', reason: 'harness_category_control_disabled', shadow: false, notifyUser: false };
  }
  return {
    ...base,
    decision: legacyDecision as 'allow' | 'deny' | 'ask_user',
    reply: decision.reply as 'once' | 'reject' | null,
    reason: decision.reason,
    shadow: decision.shadow,
    notifyUser: decision.notifyUser,
  };
}
