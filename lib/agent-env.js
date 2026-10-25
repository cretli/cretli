/**
 * Allowlist environment for harness child processes.
 *
 * Replaces `{ ...process.env }` at spawn sites. OPT-IN: the allowlist is active
 * only with `CRETLI_AGENT_ENV_ALLOWLIST=1`; otherwise the child inherits the full
 * server environment exactly as before. When active, a harness CLI never inherits
 * secrets that belong to Cretli itself or to another provider (GITHUB_TOKEN,
 * CRETLI_*, foreign *_API_KEY). `CRETLI_AGENT_ENV_PASSTHROUGH=1` is kept as an
 * alias that force-disables the allowlist. `CRETLI_AGENT_ENV_EXTRA` adds names
 * (or `PREFIX_*` patterns) to the allowlist. See docs/agent-env-allowlist.md.
 */

/** Variables every child gets (when set in the parent). */
const BASE_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'COLORTERM',
  'TMPDIR', 'TEMP', 'TMP', 'TZ', 'PWD', 'NO_COLOR',
  // Network plumbing (corporate proxy / custom CA) is not a secret.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Toolchain / session plumbing needed by shells and package managers.
  'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'EDITOR', 'VISUAL', 'PAGER', 'NODE_ENV', 'NODE_OPTIONS',
  'NVM_DIR', 'NVM_BIN', 'NVM_INC', 'VOLTA_HOME', 'PNPM_HOME', 'FNM_DIR', 'MISE_DATA_DIR',
  // Termux detection (codex CA fix reads PREFIX/TERMUX_VERSION from the child env) and npm cache location.
  'PREFIX', 'TERMUX_VERSION', 'NPM_CONFIG_CACHE', 'npm_config_cache',
  // Python toolchain selection (not secrets).
  'PYTHONPATH', 'VIRTUAL_ENV', 'PYTHON_BIN',
  // Windows basics.
  'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);
/** Prefixes every child gets (locale, XDG dirs for CLI login state). */
// GIT_AUTHOR_/GIT_COMMITTER_ are commit identity only (GIT_ASKPASS etc. stay out).
const BASE_PREFIXES = ['LC_', 'XDG_', 'GIT_AUTHOR_', 'GIT_COMMITTER_'];

/** Never forwarded, even when a provider prefix would match. */
const DENY_EXACT = new Set(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT', 'NPM_TOKEN']);
const DENY_PREFIXES = ['CRETLI_', 'CURSOR_REMOTE_'];

/**
 * Provider-owned variables per harness. A harness gets only its own prefixes.
 * @type {Record<string, { prefixes: string[], exact?: string[] }>}
 */
export const HARNESS_PROVIDER_ENV = Object.freeze({
  claude: {
    prefixes: ['ANTHROPIC_', 'CLAUDE_', 'AWS_'],
    exact: ['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION'],
  },
  codex: { prefixes: ['OPENAI_', 'CODEX_'] },
  qwen: { prefixes: ['QWEN_', 'DASHSCOPE_', 'OPENAI_'] },
  codebuddy: { prefixes: ['CODEBUDDY_'] },
  deepseek: { prefixes: ['DEEPSEEK_', 'DSH_'] },
  zai: { prefixes: ['ZAI_'] },
  mistral: { prefixes: ['MISTRAL_'] },
  mimo: { prefixes: ['MIMO_'] },
  openrouter: { prefixes: ['OPENROUTER_'] },
  cursor: { prefixes: ['CURSOR_'] },
  // OpenCode is multi-provider: it may use any provider Cretli configures for it.
  opencode: { prefixes: ['OPENCODE_', 'OPENROUTER_', 'ZAI_', 'MIMO_', 'MISTRAL_'] },
  // Helper processes (rg, bash tools, setup scripts): no provider secrets.
  tool: { prefixes: [] },
});

const TRUTHY = /^(1|true|yes|on)$/i;

/**
 * Alias that force-disables the allowlist (wins over the opt-in flag).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isAgentEnvPassthrough(env = process.env) {
  return TRUTHY.test(String(env.CRETLI_AGENT_ENV_PASSTHROUGH || '').trim());
}

/**
 * True only when the operator opted in with CRETLI_AGENT_ENV_ALLOWLIST=1 (in the
 * server env or the supplied base) and did not force passthrough.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {boolean}
 */
export function isAgentEnvAllowlistEnabled(base = process.env) {
  if (isAgentEnvPassthrough(process.env) || isAgentEnvPassthrough(base)) return false;
  return TRUTHY.test(String(process.env.CRETLI_AGENT_ENV_ALLOWLIST || '').trim())
    || TRUTHY.test(String(base.CRETLI_AGENT_ENV_ALLOWLIST || '').trim());
}

/**
 * Operator extras: comma-separated names, or `PREFIX_*` patterns.
 * @param {NodeJS.ProcessEnv} base
 * @returns {{ exact: Set<string>, prefixes: string[] }}
 */
function readExtras(base) {
  const raw = String(process.env.CRETLI_AGENT_ENV_EXTRA || base.CRETLI_AGENT_ENV_EXTRA || '');
  const exact = new Set();
  const prefixes = [];
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    if (item.endsWith('*')) prefixes.push(item.slice(0, -1));
    else exact.add(item);
  }
  return { exact, prefixes };
}

function denied(key) {
  return DENY_EXACT.has(key) || DENY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Build the env for a harness child process.
 *
 * @param {string} harness key of HARNESS_PROVIDER_ENV (unknown => base only)
 * @param {{ base?: NodeJS.ProcessEnv, home?: string, overrides?: Record<string, string | undefined> }} [options]
 *   `home` replaces HOME (isolated per-harness home); omit to keep the login home.
 *   `overrides` are applied last (explicit provider key/URL injected by Cretli);
 *   an `undefined` value removes the key.
 * @returns {NodeJS.ProcessEnv}
 */
export function buildAgentChildEnv(harness, options = {}) {
  const base = options.base || process.env;
  /** @type {NodeJS.ProcessEnv} */
  let env;
  if (!isAgentEnvAllowlistEnabled(base)) {
    env = { ...base };
  } else {
    const spec = HARNESS_PROVIDER_ENV[harness] || { prefixes: [] };
    const extras = readExtras(base);
    env = {};
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) continue;
      // Explicit operator extras may re-allow a denied name; the built-in deny list wins otherwise.
      if (denied(key) && !extras.exact.has(key)) continue;
      const keep = BASE_EXACT.has(key)
        || BASE_PREFIXES.some((p) => key.startsWith(p))
        || (spec.exact || []).includes(key)
        || spec.prefixes.some((p) => key.startsWith(p))
        || extras.exact.has(key)
        || extras.prefixes.some((p) => key.startsWith(p));
      if (keep) env[key] = value;
    }
  }
  if (options.home) env.HOME = options.home;
  for (const [key, value] of Object.entries(options.overrides || {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Overlay that masks every key of `base` that `buildAgentChildEnv` would drop.
 * For SDKs that spawn with `{ ...process.env, ...options.env }` (Qwen): an
 * `undefined` value overrides the inherited key and Node omits undefined
 * entries from the spawned env. Empty when the allowlist is not enabled (default).
 *
 * @param {string} harness
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {Record<string, undefined>}
 */
export function buildAgentEnvMask(harness, base = process.env) {
  /** @type {Record<string, undefined>} */
  const mask = {};
  if (!isAgentEnvAllowlistEnabled(base)) return mask;
  const kept = buildAgentChildEnv(harness, { base });
  for (const key of Object.keys(base)) {
    if (!(key in kept)) mask[key] = undefined;
  }
  return mask;
}
