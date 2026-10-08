/**
 * Browser runtime feature detection.
 *
 * Production uses `playwright-core` (the plan forbids pulling @playwright/test
 * into the server path). Detection is lazy and non-fatal: a missing package,
 * missing Chromium binary or an unsupported host yields a controlled
 * `browser-unavailable` / `unsupported-platform` status instead of a crash.
 */

import { existsSync } from 'fs';
import { readChildPids } from './process-tree.js';
import { resolveBrowserNetworkBoundary } from './network-boundary.js';

export const BROWSER_RUNTIME_STATUS = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'browser-unavailable',
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
});

/** Secret/identity env vars Chromium must never inherit from the Cretli server. */
export const BROWSER_ENV_DENYLIST = Object.freeze([
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
]);

/** Must not widen Browser egress when Chromium inherits the server environment. */
export const BROWSER_PROXY_ENV_DENYLIST = Object.freeze([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]);

/**
 * Baseline Chromium flags that are applied to every Browser launch.
 *
 * WebRTC opens its own UDP sockets outside `context.route`, so a hostile page on
 * an allowlisted origin could otherwise reach loopback/RFC1918/metadata
 * addresses. `disable_non_proxied_udp` makes ICE gather candidates only through
 * a configured proxy; with no proxy there are no direct candidates, so the
 * bypass is closed for the default deployment. TCP/TURN relays and a future
 * change of Chromium's flag semantics stay a documented residual risk (see
 * SECURITY.md), because Playwright has no API that removes WebRTC entirely.
 */
export const CHROMIUM_BASE_ARGS = Object.freeze([
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]);

/**
 * Builds the environment passed to the Chromium child process. A Cretli server
 * can itself run inside a Codex turn, so the browser must not inherit the
 * parent's Codex session/thread identity (same rule as the Codex CLI child).
 * @param {Record<string, string | undefined>} [baseEnv]
 * @returns {Record<string, string>}
 */
export function buildChromiumProcessEnv(baseEnv = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of BROWSER_ENV_DENYLIST) delete env[key];
  for (const key of BROWSER_PROXY_ENV_DENYLIST) delete env[key];
  return env;
}

/**
 * @param {string} [platform]
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isTermuxHost(platform = process.platform, env = process.env) {
  if (platform === 'android') return true;
  const prefix = typeof env?.PREFIX === 'string' ? env.PREFIX : '';
  if (prefix.includes('com.termux')) return true;
  return typeof env?.TERMUX_VERSION === 'string' && env.TERMUX_VERSION.trim() !== '';
}

/**
 * Wraps a Playwright `chromium` namespace in the small driver contract the
 * session manager consumes. Never injects `--no-sandbox` implicitly.
 * @param {any} chromium
 * @param {{ version?: string|null, executablePath?: string|null, sandboxWarning?: string|null, allowNoSandbox?: boolean, networkBoundary?: object }} meta
 */
export function createPlaywrightDriver(chromium, meta = {}) {
  // Launches are serialized so the child-PID snapshot cannot attribute one
  // Chromium process to two concurrent sessions.
  let launchChain = Promise.resolve();
  return {
    name: 'playwright-core',
    version: meta.version || null,
    executablePath: meta.executablePath || null,
    sandboxWarning: meta.sandboxWarning || null,
    /**
     * @param {{ allowNoSandbox?: boolean, args?: string[] }} [options]
     */
    async launch(options = {}) {
      const run = async () => {
        const allowNoSandbox = options.allowNoSandbox === true || meta.allowNoSandbox === true;
        const args = [];
        for (const arg of CHROMIUM_BASE_ARGS) {
          if (!args.includes(arg)) args.push(arg);
        }
        if (Array.isArray(options.args)) {
          for (const arg of options.args) {
            if (typeof arg === 'string' && !args.includes(arg)) args.push(arg);
          }
        }
        if (allowNoSandbox && !args.includes('--no-sandbox')) args.push('--no-sandbox');
        const env = buildChromiumProcessEnv(options.env || meta.env || process.env);
        const launchOptions = { headless: true, args, env };
        if (meta.executablePath) launchOptions.executablePath = meta.executablePath;
        if (meta.networkBoundary?.proxyServer) {
          // Explicit Playwright proxy only — no env-based bypass list.
          launchOptions.proxy = { server: meta.networkBoundary.proxyServer, bypass: '' };
        }
        const before = new Set(readChildPids(process.pid));
        const browser = await chromium.launch(launchOptions);
        const spawned = readChildPids(process.pid).find((pid) => !before.has(pid));
        if (spawned) {
          try {
            // Attached so the session manager can kill the tree on a hard
            // cleanup even though Playwright's Browser hides the process.
            browser.__cretliPid = spawned;
          } catch {
            // Browser may be sealed; killProcessTree still falls back to close().
          }
        }
        return browser;
      };
      const next = launchChain.then(run, run);
      launchChain = next.then(() => undefined, () => undefined);
      return next;
    },
    /**
     * Best-effort process id for a launched browser (Linux /proc snapshot or an
     * explicit `browser.process()` when the driver exposes one).
     * @param {any} browser
     * @returns {number|null}
     */
    getProcessId(browser) {
      try {
        const own = browser && typeof browser.process === 'function' ? browser.process() : null;
        if (own && Number.isInteger(own.pid)) return own.pid;
      } catch {
        // ignore
      }
      const marked = browser && Number.isInteger(browser.__cretliPid) ? browser.__cretliPid : null;
      return marked || null;
    },
  };
}

/** Common system Chromium/Chrome locations used as a Playwright fallback. */
export const SYSTEM_CHROMIUM_CANDIDATES = Object.freeze([
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
]);

/**
 * Resolves a system Chromium binary when Playwright's own download is missing.
 * `CRETLI_BROWSER_EXECUTABLE_PATH` wins so an operator can pin the binary.
 * @param {(path: string) => boolean} fileExists
 * @param {Record<string, string | undefined>} env
 * @returns {string|null}
 */
export function resolveSystemChromiumPath(fileExists, env = process.env) {
  const configured = typeof env?.CRETLI_BROWSER_EXECUTABLE_PATH === 'string'
    ? env.CRETLI_BROWSER_EXECUTABLE_PATH.trim()
    : '';
  if (configured && fileExists(configured)) return configured;
  for (const candidate of SYSTEM_CHROMIUM_CANDIDATES) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * @typedef {Object} BrowserRuntimeStatus
 * @property {boolean} available
 * @property {string} status
 * @property {string} reason
 * @property {object|null} driver
 * @property {string|null} version
 * @property {string|null} executablePath
 * @property {string|null} sandboxWarning
 * @property {object} networkBoundary
 */

/**
 * @param {{
 *   importModule?: (specifier: string) => Promise<any>,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   getuid?: () => number,
 *   fileExists?: (path: string) => boolean,
 * }} [options]
 * @returns {Promise<BrowserRuntimeStatus>}
 */
export async function detectBrowserRuntime(options = {}) {
  const env = options.env || process.env;
  const networkBoundary = resolveBrowserNetworkBoundary(env);
  const platform = options.platform || process.platform;
  const getuid = options.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : null);
  const fileExists = typeof options.fileExists === 'function' ? options.fileExists : existsSync;
  const importModule = typeof options.importModule === 'function'
    ? options.importModule
    : (specifier) => import(specifier);

  if (isTermuxHost(platform, env)) {
    return {
      available: false,
      status: BROWSER_RUNTIME_STATUS.UNSUPPORTED_PLATFORM,
      reason: 'Termux/Android as a Chromium host is not supported; use the widget fallback.',
      driver: null,
      version: null,
      executablePath: null,
      sandboxWarning: null,
      networkBoundary,
    };
  }

  /** @type {any} */
  let playwright = null;
  let loadError = '';
  for (const specifier of ['playwright-core', 'playwright']) {
    try {
      playwright = await importModule(specifier);
      break;
    } catch (err) {
      loadError = err?.message || String(err);
    }
  }
  if (!playwright || !playwright.chromium) {
    return {
      available: false,
      status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
      reason: `Playwright runtime is not installed (${loadError || 'playwright-core missing'}).`,
      driver: null,
      version: null,
      executablePath: null,
      sandboxWarning: null,
      networkBoundary,
    };
  }
  if (!networkBoundary.configured) {
    return {
      available: false,
      status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
      reason: networkBoundary.error,
      driver: null,
      version: null,
      executablePath: null,
      sandboxWarning: null,
      networkBoundary,
    };
  }

  let version = typeof options.version === 'string' ? options.version : null;

  let executablePath = null;
  try {
    executablePath = playwright.chromium.executablePath();
  } catch {
    executablePath = null;
  }
  let usingSystemChromium = false;
  if (!executablePath || !fileExists(executablePath)) {
    const systemPath = resolveSystemChromiumPath(fileExists, env);
    if (systemPath) {
      executablePath = systemPath;
      usingSystemChromium = true;
    } else if (executablePath) {
      return {
        available: false,
        status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
        reason: `Chromium is not installed at ${executablePath}. Run: npx playwright install chromium`,
        driver: null,
        version,
        executablePath,
        sandboxWarning: null,
        networkBoundary,
      };
    } else {
      return {
        available: false,
        status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
        reason: 'Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.',
        driver: null,
        version,
        executablePath: null,
        sandboxWarning: null,
        networkBoundary,
      };
    }
  }

  const isRoot = typeof getuid === 'function' && getuid() === 0;
  const allowNoSandbox = env?.CRETLI_BROWSER_ALLOW_NO_SANDBOX === '1';
  const sandboxWarning = isRoot
    ? (allowNoSandbox
      ? 'Cretli runs as root: launching Chromium with --no-sandbox (weaker isolation) because CRETLI_BROWSER_ALLOW_NO_SANDBOX=1.'
      : 'Cretli runs as root: Chromium sandbox is unavailable. Set CRETLI_BROWSER_ALLOW_NO_SANDBOX=1 to explicitly accept --no-sandbox, or run as a non-root user.')
    : null;

  return {
    available: true,
    status: BROWSER_RUNTIME_STATUS.AVAILABLE,
    reason: usingSystemChromium
      ? 'Using a system Chromium binary (Playwright download is missing).'
      : 'ok',
    driver: createPlaywrightDriver(playwright.chromium, {
      version,
      executablePath,
      sandboxWarning,
      allowNoSandbox,
      networkBoundary,
    }),
    version,
    executablePath,
    usingSystemChromium,
    sandboxWarning,
    networkBoundary,
  };
}
