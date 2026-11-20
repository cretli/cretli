/**
 * Shared shell-command parsing primitives: segmentation of compound commands,
 * quote-aware tokenization, env-prefix handling and quote stripping.
 *
 * Consumed by the plan/ask read-only guard (`lib/sdk/sdk-plan-guard.ts`) and
 * the OpenCode permission classifier (`lib/approval/permission-classifier.ts`)
 * so both classify the same segments and tokens instead of re-scanning raw text.
 *
 * `parseShellCommandStructure` turns a command line into segments with a
 * command word, arguments (`{ raw, value, quoted }`), redirections and env
 * prefix; `collectShellInvocations` resolves wrappers and nested shells into the
 * list of programs a line can run. Guarantee for consumers: classification is
 * never more lenient than the raw-text regex baseline; structured invocations
 * only add categories and never hide or neutralize any part of the command.
 */

/**
 * Split on `&&`, `||`, `;`, and `|` outside quotes (escape-aware).
 *
 * Exported because `opencode-permission.js` classifies shell expansion per
 * segment too; a second splitter there would drift on quotes and redirections.
 *
 * @param command
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
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
 * @param segment
 * @returns Tokens keep their quotes.
 */
export function tokenizeShellSegment(segment: string): string[] {
  const withoutEnv = segment.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/,
    '',
  );
  const tokens: string[] = [];
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

export function stripWrappingQuotes(text: string): string {
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
 * @param text
 */
export function stripQuotedShellStrings(text: string): string {
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
  // Code-loading / injection variables: they make even `node --check` run code.
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
]);

export function hasDangerousEnvPrefix(segment: string): boolean {
  const text = String(segment || '');
  const re = /([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|\S*)\s+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (DANGEROUS_ENV_VAR_NAMES.has(match[1])) return true;
  }
  return false;
}

export function shellTokenLiteral(token: string): string {
  return stripWrappingQuotes(String(token || ''));
}

export type ShellArgument = { raw: string; value: string; quoted: boolean; quote: '' | "'" | '"' };
export type ShellRedirect = { operator: string; target: string };
export type ShellSegmentStructure = {
  text: string;
  command: ShellArgument | null;
  args: ShellArgument[];
  redirects: ShellRedirect[];
  envPrefix: Array<{ name: string; value: string }>;
};
export type ShellInvocation = { name: string; args: string[] };

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=('[^']*'|"[^"]*"|\S*)\s+/;
const REDIRECT_TOKEN_RE = /^(?:\d*|&)(>>|>&|>\||>|<<<|<<|<&|<)(.*)$/;

function toShellArgument(raw: string): ShellArgument {
  const first = raw[0];
  const wrapped = raw.length >= 2 && (first === '"' || first === "'") && raw[raw.length - 1] === first;
  return {
    raw,
    value: wrapped ? raw.slice(1, -1) : raw,
    quoted: wrapped,
    quote: wrapped ? (first as "'" | '"') : '',
  };
}

/**
 * Structure of one segment: env prefix, command word, arguments and
 * redirections. Built on `tokenizeShellSegment`, so quoting follows it exactly.
 *
 * @param segment
 */
function parseShellSegmentStructure(segment: string): ShellSegmentStructure {
  const envPrefix: Array<{ name: string; value: string }> = [];
  let rest = String(segment || '');
  let match: RegExpExecArray | null;
  while ((match = ENV_ASSIGNMENT_RE.exec(rest)) !== null) {
    envPrefix.push({ name: match[1], value: stripWrappingQuotes(match[2]) });
    rest = rest.slice(match[0].length);
  }
  const words: ShellArgument[] = [];
  const redirects: ShellRedirect[] = [];
  const tokens = tokenizeShellSegment(rest);
  for (let i = 0; i < tokens.length; i += 1) {
    const redirect = REDIRECT_TOKEN_RE.exec(tokens[i]);
    if (!redirect || /^["']/.test(tokens[i])) {
      words.push(toShellArgument(tokens[i]));
      continue;
    }
    let target = redirect[2];
    if (!target && i + 1 < tokens.length) {
      i += 1;
      target = tokens[i];
    }
    redirects.push({ operator: redirect[1], target: stripWrappingQuotes(target) });
  }
  return {
    text: String(segment || ''),
    command: words[0] || null,
    args: words.slice(1),
    redirects,
    envPrefix,
  };
}

/**
 * Parse a command line into segments (split on `&&`, `||`, `;`, `|`, newline).
 *
 * @param command
 */
export function parseShellCommandStructure(command: string): ShellSegmentStructure[] {
  return splitShellSegments(String(command || '')).map(parseShellSegmentStructure);
}

const SHELL_INTERPRETER_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
// Wrapper -> option letters that consume the next word.
const WRAPPER_OPTIONS_WITH_VALUE: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  time: new Set(['-f', '-o', '--format', '--output']),
  nohup: new Set(),
  setsid: new Set(),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R', '-T']),
  doas: new Set(['-u', '-C']),
  xargs: new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-l']),
  watch: new Set(['-n', '-d', '--interval']),
};
// Wrappers whose first non-option word is a positional operand, not the command.
const WRAPPER_LEADING_OPERANDS: Record<string, number> = { timeout: 1 };

function commandBasename(word: string): string {
  const literal = stripWrappingQuotes(word);
  return literal.slice(literal.lastIndexOf('/') + 1).toLowerCase();
}

/**
 * The command a wrapper runs: `env`/`command`/`time`/`sudo`/... skip their
 * options (and `VAR=value` operands for `env`) and hand over the rest.
 *
 * @param name Lower-cased wrapper basename.
 * @param args
 */
function unwrapShellWrapper(name: string, args: string[]): ShellInvocation | null {
  const withValue = WRAPPER_OPTIONS_WITH_VALUE[name];
  if (!withValue) return null;
  let skipOperands = WRAPPER_LEADING_OPERANDS[name] || 0;
  let index = 0;
  while (index < args.length) {
    const word = args[index];
    if (word === '--') {
      index += 1;
      break;
    }
    if (word.startsWith('-') && word.length > 1) {
      index += withValue.has(word) ? 2 : 1;
      continue;
    }
    if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      index += 1;
      continue;
    }
    if (skipOperands > 0) {
      skipOperands -= 1;
      index += 1;
      continue;
    }
    break;
  }
  if (index >= args.length) return null;
  return { name: commandBasename(args[index]), args: args.slice(index + 1) };
}

/**
 * Every program a command line can run: the command word of each segment, the
 * command behind each wrapper (`env sudo ls` -> `env`, `sudo`, `ls`) and the
 * commands of a nested shell (`bash -c "curl x"` -> `bash`, `curl`). Argument
 * values are unquoted. Names are lower-cased basenames (`/usr/bin/curl` ->
 * `curl`).
 *
 * @param command
 * @param depth
 */
export function collectShellInvocations(command: string, depth = 0): ShellInvocation[] {
  const out: ShellInvocation[] = [];
  if (depth > 3) return out;
  for (const segment of parseShellCommandStructure(command)) {
    if (!segment.command) continue;
    let name = commandBasename(segment.command.raw);
    let args = segment.args.map((arg) => arg.value);
    for (let hop = 0; hop < 6; hop += 1) {
      out.push({ name, args });
      if (SHELL_INTERPRETER_NAMES.has(name)) {
        const flagIndex = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
        if (flagIndex >= 0 && args[flagIndex + 1] !== undefined) {
          out.push(...collectShellInvocations(args[flagIndex + 1], depth + 1));
        }
        break;
      }
      const next = unwrapShellWrapper(name, args);
      if (!next) break;
      ({ name, args } = next);
    }
  }
  return out;
}
