#!/usr/bin/env node
/**
 * First-load cost of the frontend bundle: transferred bytes and, when a
 * Chromium is installed for Playwright, time to interactive on an emulated
 * phone over 4G. Serves public/ with the real /dist/app middleware
 * (lib/dist-static.js), so the numbers include brotli/gzip negotiation.
 *
 *   node scripts/measure-front-first-load.mjs                     # before (dev bundle, gzip: the old server) vs after (prod bundle, brotli)
 *   node scripts/measure-front-first-load.mjs --bundle prod       # one bundle only (default encoding br)
 *   node scripts/measure-front-first-load.mjs --encoding gzip     # force client Accept-Encoding: br | gzip | identity
 *   node scripts/measure-front-first-load.mjs --no-browser        # bytes only
 *   node scripts/measure-front-first-load.mjs --json
 *
 * Build both bundles first: `npm run build:front:prod` (public/dist/app) and
 * `npm run build:dev -w cretli-front` (public/dist/app-dev). Bytes are the sum of the
 * initially loaded files (entry JS/CSS plus the vendor chunk, as listed in
 * public/index.html and the webpack manifest of initial chunks); TTI needs a
 * browser, otherwise it is reported as null.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createDistStaticMiddleware } from '../lib/dist-static.js';
import { frontBundleDir } from '../lib/front-bundle.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

function parseArgs(argv) {
  const out = { bundles: ['dev', 'prod'], encoding: null, browser: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--bundle') out.bundles = [argv[++i]];
    else if (argv[i] === '--encoding') out.encoding = argv[++i];
    else if (argv[i] === '--no-browser') out.browser = false;
    else if (argv[i] === '--json') out.json = true;
  }
  out.encodings = out.bundles.map((b) => out.encoding || (out.bundles.length === 2 && b === 'dev' ? 'gzip' : 'br'));
  return out;
}

/** Files the shell requests before the first paint: every non-lazy asset named in index.html. */
function initialAssets() {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const found = new Set(['/dist/app/index.bundle.js', '/dist/app/vendor.bundle.js', '/dist/app/index.css']);
  for (const m of html.matchAll(/(?:src|href)="(\/dist\/app\/[^"?]+)/g)) found.add(m[1]);
  return [...found];
}

function startServer(mode) {
  const app = express();
  app.use('/dist/app', createDistStaticMiddleware({ dir: frontBundleDir(publicDir, mode), mode }));
  app.get('/', (_req, res) => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__CR_ASSET_VERSION__', '1');
    res.type('html').send(html);
  });
  app.use(express.static(publicDir));
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fetchBytes(port, urlPath, encoding) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { 'accept-encoding': encoding } }, (res) => {
      let bytes = 0;
      res.on('data', (chunk) => { bytes += chunk.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, coding: res.headers['content-encoding'] || 'identity' }));
    }).on('error', reject);
  });
}

async function measureTti(port) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { tti: null, litDevWarning: null, note: 'playwright not available' };
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch (err) {
    return { tti: null, litDevWarning: null, note: `chromium not installed (${String(err.message).split('\n')[0]})` };
  }
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // Slow 4G: 1.6 Mbit/s down, 750 kbit/s up, 150 ms RTT; 4x CPU slowdown ~ mid-range phone.
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    let transferred = 0;
    cdp.on('Network.loadingFinished', (e) => { transferred += e.encodedDataLength; });
    let litDevWarning = false;
    page.on('console', (msg) => { if (/Lit is in dev mode/i.test(msg.text())) litDevWarning = true; });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    // Interactive = the app shell exists and the main thread has been quiet for 500 ms.
    await page.waitForFunction(() => new Promise((resolve) => {
      let last = performance.now();
      new PerformanceObserver((list) => { if (list.getEntries().length) last = performance.now(); }).observe({ entryTypes: ['longtask'] });
      const tick = () => (performance.now() - last > 500 ? resolve(true) : setTimeout(tick, 100));
      tick();
    }), null, { timeout: 60000 });
    return { tti: Date.now() - start, litDevWarning, transferredBrowser: transferred, note: null };
  } finally {
    await browser.close();
  }
}

async function measure(mode, encoding, args) {
  const dir = frontBundleDir(publicDir, mode);
  if (!fs.existsSync(path.join(dir, 'index.bundle.js'))) return { mode, error: `bundle not built: ${dir}` };
  const server = await startServer(mode);
  const { port } = server.address();
  try {
    const files = [];
    for (const asset of initialAssets()) {
      const r = await fetchBytes(port, asset, encoding);
      if (r.status === 200) files.push({ asset, ...r });
    }
    const bundleText = ['index.bundle.js', 'vendor.bundle.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const result = {
      mode,
      encoding,
      files,
      transferredBytes: files.reduce((sum, f) => sum + f.bytes, 0),
      litDevModeString: /Lit is in dev mode/.test(bundleText),
    };
    if (args.browser) Object.assign(result, await measureTti(port));
    else Object.assign(result, { tti: null, note: '--no-browser' });
    return result;
  } finally {
    server.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const results = [];
for (const [i, mode] of args.bundles.entries()) results.push(await measure(mode, args.encodings[i], args));
if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
  for (const r of results) {
    if (r.error) { console.log(`${r.mode}: ${r.error}`); continue; }
    console.log(`${r.mode.padEnd(4)} [${r.encoding}] ${kb(r.transferredBytes)} over ${r.files.length} files; Lit dev-mode string in bundle: ${r.litDevModeString}; TTI: ${r.tti == null ? `n/a (${r.note})` : `${r.tti} ms`}`);
  }
  const dev = results.find((r) => r.mode === 'dev' && !r.error);
  const prod = results.find((r) => r.mode === 'prod' && !r.error);
  if (dev && prod) console.log(`ratio dev/prod: ${(dev.transferredBytes / prod.transferredBytes).toFixed(1)}x fewer bytes (target >= 5x)`);
}
