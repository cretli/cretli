import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_RUNTIME_STATUS,
  CHROMIUM_BASE_ARGS,
  SYSTEM_CHROMIUM_CANDIDATES,
  detectBrowserRuntime,
  isTermuxHost,
} from '../lib/browser/runtime-detect.js';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

/**
 * Guards docs/browser-runtime.md against drift. Every availability claim the document
 * makes is re-checked against the module that decides it, so the document cannot quote a
 * status, an env var, a binary path or a reason string that the code no longer produces.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docPath = path.join(projectRoot, 'docs', 'browser-runtime.md');
const doc = readFileSync(docPath, 'utf8');
// Markdown wraps long reason strings across lines and marks terms up with emphasis, so
// verbatim checks run on collapsed, emphasis-stripped text.
const docFlat = doc.replace(/\s+/g, ' ');
const docPlain = docFlat.replace(/[*`]/g, '');
const egressDoc = readFileSync(path.join(projectRoot, 'docs', 'browser-egress-proxy.md'), 'utf8');

const MISSING_PATH = '/root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome';
const SYSTEM_BINARY = '/usr/bin/chromium';
const NO_DOWNLOAD = new Error('no Playwright download');
const ROOT_UID = 0;
const USER_UID = 1000;

function fakePlaywright({ executablePath, launch } = {}) {
  return {
    chromium: {
      executablePath: () => {
        if (executablePath instanceof Error) throw executablePath;
        return executablePath;
      },
      launch: launch ?? (async () => ({})),
    },
  };
}

/** Records what the driver hands to Playwright, so launch claims are testable. */
function captureLaunches(store, key) {
  return async (options) => {
    store[key] = options;
    return {};
  };
}

function probe(options = {}) {
  return detectBrowserRuntime({
    platform: 'linux',
    getuid: () => USER_UID,
    fileExists: () => false,
    importModule: async () => fakePlaywright({ executablePath: MISSING_PATH }),
    ...options,
  });
}

const systemBinaryHost = {
  importModule: async () => fakePlaywright({ executablePath: NO_DOWNLOAD }),
  fileExists: (candidate) => candidate === SYSTEM_BINARY,
};

/** Availability scenarios the document claims, exactly as the code must produce them. */
const scenarios = {
  termux: () => probe({ platform: 'android' }),
  missingPackage: () => probe({
    importModule: async () => {
      throw new Error("Cannot find package 'playwright-core'");
    },
  }),
  requiredWithoutProxy: () => probe({ env: { CRETLI_BROWSER_NETWORK_BOUNDARY: 'required' } }),
  badBoundaryMode: () => probe({ env: { CRETLI_BROWSER_NETWORK_BOUNDARY: 'strict' } }),
  badProxyUrl: () => probe({
    env: { CRETLI_BROWSER_NETWORK_BOUNDARY: 'proxy', CRETLI_BROWSER_PROXY_SERVER: 'not-a-url' },
  }),
  binaryGone: () => probe(),
  nothingFound: () => probe({ importModule: async () => fakePlaywright({ executablePath: NO_DOWNLOAD }) }),
  systemFallback: () => probe(systemBinaryHost),
  rootWithoutOptIn: () => probe({ ...systemBinaryHost, getuid: () => ROOT_UID }),
  rootWithOptIn: () => probe({ ...systemBinaryHost, getuid: () => ROOT_UID, env: { CRETLI_BROWSER_ALLOW_NO_SANDBOX: '1' } }),
  proxyConfigured: () => probe({
    ...systemBinaryHost,
    env: {
      CRETLI_BROWSER_NETWORK_BOUNDARY: 'required',
      CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:3129',
    },
  }),
};

/**
 * Section bodies are located by heading, so a token cannot "pass" by being mentioned
 * somewhere unrelated and the assertions survive prose reordering.
 */
function section(heading) {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `document is missing the heading ${heading}`);
  const rest = doc.slice(start + heading.length);
  const next = rest.search(/\n#{2,3} /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Collapsed prose for long strings that markdown wraps or emphasizes. */
function sectionCollapsed(heading) {
  return section(heading).replace(/\s+/g, ' ').replace(/[*`]/g, '');
}

function statusTableRows() {
  return section('## Status vocabulary')
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 3)
    .filter((cells) => !cells[0].startsWith('Status'))
    .filter((cells) => !/^[`:\-\s|]+$/.test(cells[0]))
    .map(([status, ...rest]) => [status.replace(/`/g, ''), ...rest]);
}

/** Availability scenarios the prose commits to; removing a section makes this fail. */
function documentedAvailabilityScenarios() {
  /** @type {Array<[string, string]>} */
  const expected = [];
  const termux = section('## Termux (Android)');
  assert.ok(termux.includes('unsupported-platform'), 'Termux must document unsupported-platform');
  expected.push(['termux', BROWSER_RUNTIME_STATUS.UNSUPPORTED_PLATFORM]);
  const vocabulary = section('## Status vocabulary');
  assert.ok(
    vocabulary.includes('Playwright runtime is not installed'),
    'status table must mention missing Playwright package'
  );
  expected.push(['missingPackage', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  const egress = section('## Limited egress (`proxy` / `required`)');
  assert.ok(
    egress.includes('required requires CRETLI_BROWSER_PROXY_SERVER'),
    'egress table must document required-without-proxy'
  );
  expected.push(['requiredWithoutProxy', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  assert.ok(
    egress.includes('Unsupported network boundary'),
    'egress table must document bad boundary mode'
  );
  expected.push(['badBoundaryMode', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  assert.ok(
    egress.includes('CRETLI_BROWSER_PROXY_SERVER must be a valid http(s), socks4, or socks5 URL'),
    'egress table must document malformed proxy URL'
  );
  expected.push(['badProxyUrl', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  assert.ok(
    egress.includes('with a valid proxy URL'),
    'egress table must document proxy-configured availability'
  );
  expected.push(['proxyConfigured', BROWSER_RUNTIME_STATUS.AVAILABLE]);
  const install = section('## Installing Chromium');
  assert.ok(
    install.includes('Chromium is not installed at <path>. Run: npx playwright install chromium'),
    'Installing Chromium must document the missing-file-at-expected-path reason'
  );
  expected.push(['binaryGone', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  assert.ok(
    install.includes('Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.'),
    'Installing Chromium must document the no-path-from-Playwright reason'
  );
  expected.push(['nothingFound', BROWSER_RUNTIME_STATUS.UNAVAILABLE]);
  const deps = section('## Required runtime dependencies');
  assert.ok(
    deps.includes('usingSystemChromium'),
    'Required runtime dependencies must name usingSystemChromium on the detection object'
  );
  expected.push(['systemFallback', BROWSER_RUNTIME_STATUS.AVAILABLE]);
  const docker = section('## Docker');
  assert.ok(docker.includes('sandboxWarning'), 'Docker must document root sandboxWarning');
  expected.push(['rootWithoutOptIn', BROWSER_RUNTIME_STATUS.AVAILABLE]);
  assert.ok(
    docker.includes('CRETLI_BROWSER_ALLOW_NO_SANDBOX=1'),
    'Docker must document the no-sandbox opt-in path'
  );
  expected.push(['rootWithOptIn', BROWSER_RUNTIME_STATUS.AVAILABLE]);
  return expected;
}

async function reasonWhenExecutablePathMissing() {
  const sample = await scenarios.binaryGone();
  const tail = 'Run: npx playwright install chromium';
  assert.ok(sample.reason.includes(tail));
  return { prefix: 'Chromium is not installed at ', tail };
}

test('the status table covers exactly BROWSER_RUNTIME_STATUS, with a cause and an action per row', () => {
  const rows = statusTableRows();
  const enumValues = new Set(Object.values(BROWSER_RUNTIME_STATUS));
  assert.deepEqual(
    rows.map((row) => row[0]).sort(),
    [...enumValues].sort(),
    'the Status vocabulary table must list every runtime status and invent none'
  );
  for (const [status, cause, action] of rows) {
    assert.ok(cause.length > 20, `${status}: the row must explain the cause`);
    assert.ok(action.length > 20, `${status}: the row must say what the operator does`);
  }
});

test('the covered-variables table matches the env vars the availability code reads, both ways', () => {
  const gateSources = ['lib/browser/runtime-detect.js', 'lib/browser/network-boundary.js']
    .map((rel) => readFileSync(path.join(projectRoot, rel), 'utf8'))
    .join('\n');
  const inCode = new Set(gateSources.match(/CRETLI_BROWSER_[A-Z0-9_]+/g) ?? []);
  assert.ok(inCode.size >= 4, 'expected the availability modules to read several env vars');

  const documented = new Set(
    section('### Environment variables this document covers').match(/CRETLI_BROWSER_[A-Z0-9_]+/g) ?? []
  );
  for (const name of inCode) {
    assert.ok(documented.has(name), `${name} gates availability but is not documented`);
  }
  for (const name of documented) {
    assert.ok(inCode.has(name), `${name} is documented but the availability code never reads it`);
  }
});

test('the documented Chromium probe order matches SYSTEM_CHROMIUM_CANDIDATES', () => {
  const deps = section('## Required runtime dependencies');
  const documented = (deps.match(/`\/[^`]+`/g) ?? [])
    .map((token) => token.slice(1, -1))
    .filter((candidate) => SYSTEM_CHROMIUM_CANDIDATES.includes(candidate));
  assert.deepEqual(
    [...new Set(documented)].sort(),
    [...SYSTEM_CHROMIUM_CANDIDATES].sort(),
    'the document must list the same system binaries the code probes'
  );
  assert.ok(deps.includes('playwright.chromium.executablePath()'));
  assert.ok(deps.includes('CRETLI_BROWSER_EXECUTABLE_PATH'));
  const checking = section('## Checking availability');
  assert.ok(
    deps.includes('Using a system Chromium binary (Playwright download is missing).'),
    'detection fallback reason must be documented in Required runtime dependencies'
  );
  assert.ok(deps.includes('usingSystemChromium'));
  assert.ok(checking.includes('usingSystemChromium'));
  assert.match(checking, /runtime\.reason.*[`']ok[`']/);
  assert.equal(deps.search(/only signal of the fallback/), -1);
  assert.equal(deps.search(/HTTP payload has no separate flag/), -1);
});

test('GET /api/browser/status masks system-Chromium fallback on reason and usingSystemChromium', async () => {
  const detection = await scenarios.systemFallback();
  assert.equal(detection.usingSystemChromium, true);
  assert.ok(detection.reason.includes('Using a system Chromium binary'));
  const manager = new BrowserSessionManager({
    driver: { name: 'playwright-core' },
    driverStatus: detection,
  });
  const httpRuntime = manager.getRuntimeStatus();
  assert.equal(httpRuntime.reason, 'ok');
  assert.equal('usingSystemChromium' in httpRuntime, false);
  const checking = section('## Checking availability');
  const deps = section('## Required runtime dependencies');
  assert.ok(
    deps.includes('does not expose `usingSystemChromium`')
      || (checking.includes('usingSystemChromium') && checking.includes('not on this JSON')),
    'the document must state the HTTP payload omits usingSystemChromium'
  );
  assert.match(
    checking,
    /runtime\.reason.*[`']ok[`']/,
    'Checking availability must say live driver forces reason ok over HTTP'
  );
});

test('Docker slim (missing file at Playwright expected path) matches documented install reason', async () => {
  const dockerSlim = await detectBrowserRuntime({
    fileExists: () => false,
    platform: 'linux',
    getuid: () => ROOT_UID,
    env: {},
    importModule: async () => fakePlaywright({ executablePath: MISSING_PATH }),
  });
  assert.equal(dockerSlim.status, BROWSER_RUNTIME_STATUS.UNAVAILABLE);
  assert.ok(dockerSlim.reason.includes('Run: npx playwright install chromium'));
  const docker = section('## Docker');
  assert.ok(
    docker.includes('Chromium is not installed at <path>. Run: npx playwright install chromium'),
    'Docker no-binary bullet must quote the missing-file-at-expected-path reason'
  );
  const noBinaryBlock = docker.slice(docker.indexOf('**No binary**'));
  assert.ok(
    noBinaryBlock.includes('Run: npx playwright install chromium'),
    'Docker no-binary bullet must mention playwright install'
  );
  assert.ok(
    sectionCollapsed('## Docker').includes('executablePath() throws or returns nothing'),
    'Docker must distinguish Playwright returning no path'
  );
  const nothingFound = await scenarios.nothingFound();
  assert.ok(
    nothingFound.reason.includes('Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.')
  );
  const install = section('## Installing Chromium');
  assert.ok(install.includes('Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.'));
});

test('every documented availability outcome is reproduced by detectBrowserRuntime', async () => {
  const expected = documentedAvailabilityScenarios();
  for (const [name, status] of expected) {
    const result = await scenarios[name]();
    assert.equal(result.status, status, `${name} must yield ${status}`);
    assert.equal(result.available, status === BROWSER_RUNTIME_STATUS.AVAILABLE, `${name}: available disagrees with status`);
    assert.ok(result.reason, `${name} must report a reason`);
    assert.ok(result.networkBoundary, `${name} must report the boundary in the payload`);
    if (status !== BROWSER_RUNTIME_STATUS.AVAILABLE) {
      assert.equal(result.driver, null, `${name} must not hand out a driver`);
    }
  }
});

test('every reason string quoted by the document is the string the code returns', async () => {
  const sectionForScenario = {
    termux: section('## Termux (Android)'),
    missingPackage: section('## Status vocabulary'),
    requiredWithoutProxy: section('## Limited egress (`proxy` / `required`)'),
    badBoundaryMode: section('## Limited egress (`proxy` / `required`)'),
    badProxyUrl: section('## Limited egress (`proxy` / `required`)'),
    nothingFound: section('## Installing Chromium'),
    systemFallback: section('## Required runtime dependencies'),
  };
  const quoted = {
    termux: 'Termux/Android as a Chromium host is not supported; use the widget fallback.',
    missingPackage: 'Playwright runtime is not installed (',
    requiredWithoutProxy: 'required requires CRETLI_BROWSER_PROXY_SERVER',
    badBoundaryMode: 'Unsupported network boundary: strict',
    badProxyUrl: 'CRETLI_BROWSER_PROXY_SERVER must be a valid http(s), socks4, or socks5 URL',
    nothingFound: 'Chromium executable not found. Install it or set CRETLI_BROWSER_EXECUTABLE_PATH.',
    systemFallback: 'Using a system Chromium binary (Playwright download is missing).',
  };
  for (const [name, text] of Object.entries(quoted)) {
    const result = await scenarios[name]();
    assert.ok(result.reason.includes(text), `${name}: the code reason changed, the doc still quotes ${text}`);
    assert.ok(sectionForScenario[name].includes(text), `${name}: the document section no longer quotes ${text}`);
  }
  const warnings = {
    rootWithoutOptIn: 'Cretli runs as root: Chromium sandbox is unavailable. Set CRETLI_BROWSER_ALLOW_NO_SANDBOX=1 to explicitly accept --no-sandbox, or run as a non-root user.',
    rootWithOptIn: 'Cretli runs as root: launching Chromium with --no-sandbox (weaker isolation) because CRETLI_BROWSER_ALLOW_NO_SANDBOX=1.',
  };
  const dockerCollapsed = sectionCollapsed('## Docker');
  for (const [name, text] of Object.entries(warnings)) {
    const result = await scenarios[name]();
    assert.equal(result.sandboxWarning, text, `${name}: the code warning changed, the doc still quotes it`);
    assert.ok(dockerCollapsed.includes(text.replace(/\s+/g, ' ')), `${name}: Docker must quote the warning`);
    assert.ok(result.reason.includes('Using a system Chromium binary'), `${name}: availability reason must still describe the binary source`);
  }
  const { prefix, tail } = await reasonWhenExecutablePathMissing();
  const binaryGone = await scenarios.binaryGone();
  assert.ok(binaryGone.reason.startsWith(prefix));
  assert.ok(binaryGone.reason.includes(tail));
  const install = section('## Installing Chromium');
  assert.ok(install.includes(`${prefix}<path>. ${tail}`));
});

test('running as root is a warning, not a refusal: status stays available', async () => {
  const withoutOptIn = await scenarios.rootWithoutOptIn();
  assert.equal(withoutOptIn.status, BROWSER_RUNTIME_STATUS.AVAILABLE);
  assert.ok(withoutOptIn.sandboxWarning, 'root without an opt-in must warn');
  assert.match(withoutOptIn.sandboxWarning, /CRETLI_BROWSER_ALLOW_NO_SANDBOX=1/);
  assert.ok(
    section('## Docker').includes('the real failure surfaces at launch, not at detection')
  );

  const nonRoot = await scenarios.systemFallback();
  assert.equal(nonRoot.sandboxWarning, null, 'a non-root host must not warn about the sandbox');
});

test('--no-sandbox is never appended implicitly, and the WebRTC base arg always is', async () => {
  const launches = {};
  const fakeModule = (key) => fakePlaywright({
    executablePath: NO_DOWNLOAD,
    launch: captureLaunches(launches, key),
  });

  const quiet = await detectBrowserRuntime({
    ...systemBinaryHost,
    getuid: () => ROOT_UID,
    importModule: async () => fakeModule('rootDefault'),
  });
  const opted = await detectBrowserRuntime({
    ...systemBinaryHost,
    getuid: () => ROOT_UID,
    env: { CRETLI_BROWSER_ALLOW_NO_SANDBOX: '1' },
    importModule: async () => fakeModule('rootOptIn'),
  });
  await quiet.driver.launch({});
  await opted.driver.launch({});

  assert.ok(!launches.rootDefault.args.includes('--no-sandbox'), 'a silent --no-sandbox would weaken the container without operator consent');
  assert.ok(launches.rootOptIn.args.includes('--no-sandbox'), 'CRETLI_BROWSER_ALLOW_NO_SANDBOX=1 must take effect');
  for (const key of ['rootDefault', 'rootOptIn']) {
    for (const arg of CHROMIUM_BASE_ARGS) {
      assert.ok(launches[key].args.includes(arg), `${key}: every launch must carry ${arg}`);
    }
    assert.equal(launches[key].headless, true, `${key}: headless launches only`);
  }
  const docker = section('## Docker');
  assert.ok(docker.includes('appended silently'), 'Docker must say --no-sandbox is never appended silently');
  const egress = section('## Limited egress (`proxy` / `required`)');
  assert.ok(egress.includes(CHROMIUM_BASE_ARGS[0]), 'the WebRTC flag must be documented in Limited egress');
});

test('a container proxy env never reaches Chromium; only the explicit boundary var does', async () => {
  const launches = {};
  const build = (env, key) => detectBrowserRuntime({
    env,
    platform: 'linux',
    getuid: () => USER_UID,
    fileExists: (candidate) => candidate === SYSTEM_BINARY,
    importModule: async () => fakePlaywright({
      executablePath: NO_DOWNLOAD,
      launch: captureLaunches(launches, key),
    }),
  });

  const direct = await build({}, 'direct');
  assert.equal(direct.status, BROWSER_RUNTIME_STATUS.AVAILABLE);
  assert.equal(direct.networkBoundary.mode, 'mvp-defense-in-depth');
  assert.equal(direct.networkBoundary.configured, true);
  await direct.driver.launch({
    env: {
      HTTP_PROXY: 'http://127.0.0.1:3128',
      https_proxy: 'http://127.0.0.1:3128',
      NO_PROXY: 'localhost',
      CODEX_SESSION_ID: 'leak-me',
      HOME: '/root',
    },
  });
  assert.equal(launches.direct.proxy, undefined, 'an inherited proxy env must not set a Playwright proxy');
  assert.equal(launches.direct.env.HTTP_PROXY, undefined, 'Chromium must not inherit HTTP_PROXY');
  assert.equal(launches.direct.env.https_proxy, undefined);
  assert.equal(launches.direct.env.NO_PROXY, undefined);
  assert.equal(launches.direct.env.CODEX_SESSION_ID, undefined, 'the parent Codex identity must not leak into the browser');
  assert.equal(launches.direct.env.HOME, '/root', 'unrelated vars must still pass through');

  const proxied = await build({
    CRETLI_BROWSER_NETWORK_BOUNDARY: 'required',
    CRETLI_BROWSER_PROXY_SERVER: 'http://127.0.0.1:3129',
  }, 'proxied');
  assert.equal(proxied.status, BROWSER_RUNTIME_STATUS.AVAILABLE);
  await proxied.driver.launch({});
  assert.equal(launches.proxied.proxy.server, 'http://127.0.0.1:3129');
  assert.equal(launches.proxied.proxy.bypass, '', 'a bypass list would re-open direct egress');

  const egressCollapsed = sectionCollapsed('## Limited egress (`proxy` / `required`)');
  assert.ok(egressCollapsed.includes('does not widen or supply the Browser\'s egress'));
  assert.ok(egressCollapsed.includes('the only way Chromium gets a proxy'));
});

test('the document links its neighbours instead of copying their content', () => {
  const links = [...doc.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);
  assert.ok(links.length >= 5, 'expected cross-links to SECURITY.md and docs/');
  for (const link of links) {
    if (/^https?:/.test(link)) continue;
    assert.ok(
      existsSync(path.resolve(path.dirname(docPath), link)),
      `broken relative link in docs/browser-runtime.md: ${link}`
    );
  }
  assert.ok(doc.includes('browser-egress-proxy.md'));
  assert.ok(doc.includes('SECURITY.md'));
  // The egress proxy keeps its own env table: no concrete CRETLI_EGRESS_* name may leak here.
  const egressVars = new Set(egressDoc.match(/CRETLI_EGRESS_[A-Z0-9_]+/g) ?? []);
  assert.ok(egressVars.size >= 8, 'expected the egress proxy doc to list its env vars');
  for (const name of egressVars) {
    assert.ok(!doc.includes(name), `${name} must stay documented in browser-egress-proxy.md only`);
  }
});

test('the document never claims the Browser is a complete network boundary', () => {
  assert.ok(docPlain.includes('this is not a complete SSRF boundary'));
  assert.ok(docPlain.includes('not claim complete DNS/SSRF isolation'));
  assert.ok(docPlain.includes('not make the boundary complete'));
  // The residual risks named in SECURITY.md must stay disclosed rather than summarized away.
  for (const term of ['CONNECT', 'WebRTC', 'host-resolver-rules', 'mvp-defense-in-depth']) {
    assert.ok(docPlain.includes(term), `residual-risk term ${term} must stay documented`);
  }
  const affirmativeClaim = /\b(?:is|provides?|gives?|ensures?|makes?|guarantees?)\s+(?:a\s+|an\s+)?(?:full|complete|hard)\s+(?:SSRF|DNS|network|egress)\b/i;
  assert.equal(docPlain.search(affirmativeClaim), -1, 'the document must not assert a complete boundary');
});

test('no private maintainer environment leaks into browser-runtime leaf docs', () => {
  const offenders = {
    'IPv4 RFC1918 192.168 address': /\b192\.168\.\d{1,3}\.\d{1,3}\b/,
    'IPv4 RFC1918 10.x address': /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
    'home directory path': /\/(?:home|Users)\/[a-z0-9._-]+\//i,
    'private hostname': /\b(?:synology|diskstation|nas\d|[\w-]+\.internal)\b/i,
  };
  const leafDocs = [
    docPath,
    path.join(projectRoot, 'docs', 'INSTALL.md'),
    path.join(projectRoot, 'SECURITY.md'),
    path.join(projectRoot, 'README.md'),
  ];
  for (const filePath of leafDocs) {
    const text = readFileSync(filePath, 'utf8');
    const rel = path.relative(projectRoot, filePath);
    for (const [label, pattern] of Object.entries(offenders)) {
      assert.equal(text.search(pattern), -1, `${label} found in ${rel}`);
    }
  }
  assert.match(doc, /127\.0\.0\.1/);
});

test('the Termux verdict is a host decision taken before any package or binary probe', async () => {
  assert.equal(isTermuxHost('android', {}), true);
  assert.equal(isTermuxHost('linux', { PREFIX: '/data/data/com.termux/files/usr' }), true);
  assert.equal(isTermuxHost('linux', { TERMUX_VERSION: '0.132.1' }), true);
  assert.equal(isTermuxHost('linux', {}), false);

  // Even with a Chromium binary present, a Termux host must not report availability.
  const withBinary = await probe({ ...systemBinaryHost, platform: 'android' });
  assert.equal(withBinary.status, BROWSER_RUNTIME_STATUS.UNSUPPORTED_PLATFORM);
  assert.equal(withBinary.driver, null);
  const termux = section('## Termux (Android)');
  assert.ok(termux.includes('The check runs first in `detectBrowserRuntime()`') || termux.includes('The check runs first in detectBrowserRuntime()'));
  assert.ok(termux.includes('use the widget fallback'), 'Termux must name the widget fallback');
});
