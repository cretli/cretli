/**
 * Runs a browser-side scenario against the production sdk-rich-view in headless Chromium.
 *
 * The page serves the repo root (TS modules are transpiled by serve-ts-module) and loads
 * a DOM shell (lit + markdown-it import map) that gives the view a fixed-height scroll container.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { readServedModule } from './serve-ts-module.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].find((file) => existsSync(file));
}

/**
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string }>}
 */
function startStaticServer() {
  const root = path.resolve(projectRoot);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const filePath = path.resolve(root, decodeURIComponent(url.pathname).replace(/^\//, ''));
        if (!filePath.startsWith(`${root}${path.sep}`)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const { type, body } = readServedModule(filePath);
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      } catch (err) {
        res.writeHead(404);
        res.end(String(err instanceof Error ? err.message : err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('static server bind failed'));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

/**
 * @template T
 * @param {(ctx: { viewUrl: string, parkingUrl: string, args: any }) => Promise<T>} scenario runs in the page
 * @param {{
 *   args?: any,
 *   viewport?: { width: number, height: number },
 *   hasTouch?: boolean,
 *   beforeScenario?: (page: import('playwright-core').Page) => Promise<void>,
 *   interact?: (page: import('playwright-core').Page, result: T) => Promise<T>,
 * }} [opts]
 * @returns {Promise<{ result: T, pageErrors: string[] }>}
 */
export async function runRichViewScenario(scenario, opts = {}) {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) throw new Error('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  const { server, baseUrl } = await startStaticServer();
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: opts.viewport, hasTouch: opts.hasTouch });
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/chat-history-view-dom-shell.html`, { waitUntil: 'load' });
    if (opts.beforeScenario) await opts.beforeScenario(page);
    const source = `(${scenario.toString()})`;
    let result = await page.evaluate(
      async ({ source, ctx }) => {
        // eslint-disable-next-line no-eval
        const fn = (0, eval)(source);
        return fn(ctx);
      },
      {
        source,
        ctx: {
          viewUrl: `${baseUrl}/app_front/lib/sdk-rich-view.js`,
          parkingUrl: `${baseUrl}/app_front/features/chat/chatHistoryMountedParking.js`,
          args: opts.args ?? null,
        },
      },
    );
    if (opts.interact) result = await opts.interact(page, result);
    return { result, pageErrors };
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}
