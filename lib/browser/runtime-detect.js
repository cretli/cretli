/**
 * Browser runtime feature detection.
 *
 * Production uses `playwright-core` (the plan forbids pulling @playwright/test
 * into the server path). Detection is lazy and non-fatal: a missing package,
 * missing Chromium binary or an unsupported host yields a controlled
 * `browser-unavailable` / `unsupported-platform` status instead of a crash.
 */

import { existsSync } from 'fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readChildPids } from './process-tree.js';
import { resolveBrowserNetworkBoundary } from './network-boundary.js';

export const CDP_PROBE_MAX_BYTES = 1024 * 1024;
export const CDP_PROBE_TIMEOUT_MS = 5000;

export const BROWSER_RUNTIME_STATUS = Object.freeze({
  AVAILABLE: 'available',
  UNAVAILABLE: 'browser-unavailable',
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
});

function isPrivateCdpAddress(address) {
  const value = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    // Keep ordinary link-local support, but never permit well-known cloud
    // metadata endpoints as the CDP control plane.
    if (value === '169.254.169.254' || value === '169.254.170.2' || value === '100.100.100.200') return false;
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
  }
  if (net.isIP(value) === 6) {
    if (value === 'fd00:ec2::254' || value === 'fd00:ec2::253' || value === 'fd20:ce::254') return false;
    return value === '::1' || value.startsWith('fe8') || value.startsWith('fe9')
      || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('fc') || value.startsWith('fd');
  }
  return false;
}

async function readCdpProbeBody(response, maxBytes) {
  const contentLength = response?.headers?.get?.('content-length')
    || response?.headers?.['content-length'] || response?.headers?.['Content-Length'];
  if (contentLength && Number(contentLength) > maxBytes) throw new Error('CDP /json/version response is too large');
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value?.byteLength || 0;
      if (total > maxBytes) {
        await reader.cancel?.();
        throw new Error('CDP /json/version response is too large');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
  if (typeof response?.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('CDP /json/version response is too large');
    return new TextDecoder().decode(new Uint8Array(buffer));
  }
  if (typeof response?.json === 'function') return JSON.stringify(await response.json());
  throw new Error('CDP /json/version response has no readable body');
}

function rejectCdpUrl(raw, schemes) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw new Error('CRETLI_BROWSER_CDP_URL must be a valid URL'); }
  if (!schemes.includes(url.protocol) || url.username || url.password || url.hash) {
    const accepted = schemes.some((scheme) => scheme === 'ws:' || scheme === 'wss:') ? 'ws(s)' : 'http(s)';
    throw new Error(`CRETLI_BROWSER_CDP_URL must be an ${accepted} URL without credentials`);
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '';
  return url;
}

export async function resolveCdpEndpoint(raw, options = {}) {
  const endpoint = rejectCdpUrl(raw, ['http:', 'https:']);
  const allowlist = new Set(String(options.allowlist || '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean));
  const hostname = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const literal = net.isIP(hostname) ? hostname : null;
  let addresses = literal ? [literal] : [];
  if (!literal) {
    if (hostname !== 'localhost' && !allowlist.has(hostname)) {
      throw new Error('CDP host must be loopback or explicitly allowlisted');
    }
    const lookup = options.lookup || dns.lookup;
    const result = await lookup(hostname, { all: true, verbatim: true });
    addresses = (Array.isArray(result) ? result : [{ address: result }]).map((item) => item.address).filter(Boolean);
  }
  if (!addresses.length || addresses.some((address) => !isPrivateCdpAddress(address))) {
    throw new Error('CDP host DNS must resolve only to private, link-local, or loopback addresses');
  }
  const literalIp = addresses[0];
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('CDP endpoint validation requires fetch');
  const probe = new URL(endpoint.toString());
  probe.protocol = probe.protocol === 'https:' ? 'https:' : 'http:';
  probe.hostname = literalIp.includes(':') ? `[${literalIp}]` : literalIp;
  probe.pathname = '/json/version';
  probe.search = '';
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.min(Number(options.timeoutMs), 30000) : CDP_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let body;
  try {
    response = await fetchImpl(probe, { headers: { host: endpoint.host }, redirect: 'error', signal: controller.signal });
    if (!response?.ok) throw new Error(`CDP endpoint returned HTTP ${response?.status || 'error'}`);
    body = await readCdpProbeBody(response, CDP_PROBE_MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
  let version;
  try { version = JSON.parse(body); } catch { throw new Error('CDP /json/version response is not valid JSON'); }
  const wsRaw = version?.webSocketDebuggerUrl || version?.webSocketUrl;
  const ws = rejectCdpUrl(wsRaw, ['ws:', 'wss:']);
  ws.hostname = literalIp.includes(':') ? `[${literalIp}]` : literalIp;
  if (endpoint.port) ws.port = endpoint.port;
  ws.username = '';
  ws.password = '';
  return { endpoint: ws.toString(), version: version?.Browser || version?.browser || null, address: literalIp };
}

export async function createCdpDriver(chromium, config = {}) {
  const resolved = await resolveCdpEndpoint(config.url, config);
  let browser = null;
  let listener = null;
  const driver = {
    name: 'playwright-cdp', mode: 'external-cdp', version: resolved.version, executablePath: null,
    connected: 'unknown',
    onConnectionChange(fn) { listener = typeof fn === 'function' ? fn : null; },
    async connect() {
      try {
        browser = await chromium.connectOverCDP(resolved.endpoint);
        driver.connected = true;
        listener?.(true);
        browser?.on?.('disconnected', () => { driver.connected = false; listener?.(false); });
        return browser;
      } catch (error) {
        driver.connected = false;
        listener?.(false);
        throw error;
      }
    },
    getProcessId() { return null; },
  };
  return driver;
}

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
  // Newer Chromium blocks requests to loopback/private targets from pages it
  // classes as non-local (net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS),
  // which breaks the opt-in self-origin preview. The Cretli URL policy
  // (allowlist, SSRF and DNS-pinning checks) is the gate for these sessions.
  '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
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
 * @param {{ version?: string|null, executablePath?: string|null, sandboxWarning?: string|null, allowNoSandbox?: boolean, networkBoundary?: any }} meta
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
        const env = buildChromiumProcessEnv(/** @type {any} */ (options).env || /** @type {any} */ (meta).env || process.env);
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
 * @property {any} networkBoundary
 * @property {boolean} [usingSystemChromium]
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

  const cdpUrl = String(env?.CRETLI_BROWSER_CDP_URL || '').trim();
  if (cdpUrl) {
    if (networkBoundary.mode === 'proxy' || networkBoundary.mode === 'required') {
      return {
        available: false,
        status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
        mode: 'external-cdp',
        connected: false,
        reason: `External CDP cannot enforce the '${networkBoundary.mode}' network boundary on an existing browser.`,
        driver: null,
        version: null,
        executablePath: null,
        sandboxWarning: null,
        networkBoundary,
      };
    }
    try {
      const driver = await createCdpDriver(playwright.chromium, {
        url: cdpUrl,
        allowlist: env?.CRETLI_BROWSER_CDP_ALLOWLIST,
        lookup: options.lookup,
        fetch: options.fetch,
        timeoutMs: options.cdpProbeTimeoutMs,
      });
      return {
        available: true,
        status: BROWSER_RUNTIME_STATUS.AVAILABLE,
        mode: 'external-cdp',
        connected: 'unknown',
        reason: 'External browser via CDP; connection is established on first session.',
        driver,
        version: driver.version,
        executablePath: null,
        sandboxWarning: null,
        networkBoundary,
      };
    } catch (err) {
      return {
        available: false,
        status: BROWSER_RUNTIME_STATUS.UNAVAILABLE,
        mode: 'external-cdp',
        connected: false,
        reason: `External CDP browser unavailable: ${err?.message || String(err)}`,
        driver: null,
        version: null,
        executablePath: null,
        sandboxWarning: null,
        networkBoundary,
      };
    }
  }

  let version = typeof /** @type {any} */ (options).version === "string" ? /** @type {any} */ (options).version : null;

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
    mode: 'headless',
    connected: null,
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
