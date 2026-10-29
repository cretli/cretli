import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import webpack from 'webpack';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));

test('rendered Settings gallery updates live UI, xterm, syntax and a second tab; supports keyboard and system slots', { timeout: 120_000 }, async () => {
  const output = await mkdtemp(join(tmpdir(), 'cretli-theme-gallery-'));
  let server;
  let browser;
  try {
    const compiler = webpack({
      mode: 'development', context: root, target: 'web', devtool: false,
      entry: resolve(root, 'tests/theme-gallery-dom/harness.js'),
      output: { path: output, filename: 'harness.js', publicPath: '/' },
      resolve: { modules: [resolve(root, 'node_modules'), resolve(root, 'app_front/node_modules')] },
      resolveLoader: { modules: [resolve(root, 'node_modules'), resolve(root, 'app_front/node_modules')] },
      module: { rules: [{ test: /\.(scss|css)$/, use: ['style-loader', 'css-loader', 'sass-loader'] }] },
    });
    await new Promise((resolvePromise, reject) => compiler.run((error, stats) => {
      compiler.close(() => {});
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolvePromise();
    }));
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>Cretli appearance test</title><style>body{background:var(--cr-bg);color:var(--cr-text);font-family:var(--cr-font-ui);margin:24px}main{max-width:850px;margin:auto}#terminal{height:70px}</style></head><body><main><h1>Settings · Appearance</h1><div id="terminal"></div><pre class="hljs"><code id="code"></code></pre><cr-theme-gallery id="theme-gallery"></cr-theme-gallery></main><script src="/harness.js"></script></body></html>';
    server = createServer(async (request, response) => {
      if (request.url.endsWith('.js')) {
        response.setHeader('content-type', 'text/javascript');
        response.end(await readFile(join(output, request.url.slice(1))));
      } else {
        response.setHeader('content-type', 'text/html');
        response.end(html);
      }
    });
    await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const executablePath = [process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((file) => file && existsSync(file));
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    const context = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    const page = await context.newPage();
    const second = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await second.goto(origin);
    await page.waitForFunction(() => window.themeHarness?.ready);
    await second.waitForFunction(() => window.themeHarness?.ready);
    const screenshotDir = process.env.CRETLI_THEME_SCREENSHOT_DIR;
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    const bootId = await page.evaluate(() => window.themeHarness.bootId);
    const keywordBefore = await page.locator('.hljs-keyword').evaluate((element) => getComputedStyle(element).color);
    await page.getByRole('radio', { name: 'Dracula', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.themeId === 'dracula');
    await second.waitForFunction(() => document.documentElement.dataset.themeId === 'dracula');
    assert.equal(await page.getByRole('radio', { name: 'Dracula', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.evaluate(() => window.themeHarness.terminal.options.theme.background), '#282a36');
    assert.equal(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(40, 42, 54)');
    assert.notEqual(await page.locator('.hljs-keyword').evaluate((element) => getComputedStyle(element).color), keywordBefore);
    assert.equal(await second.evaluate(() => window.themeHarness.terminal.options.theme.background), '#282a36');
    assert.equal(await second.getByRole('radio', { name: 'Dracula', exact: true }).getAttribute('aria-checked'), 'true');
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'theme-gallery-dracula.png'), fullPage: true });
    await page.getByRole('radio', { name: 'Dracula', exact: true }).press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: 'One Dark', exact: true }).getAttribute('aria-checked'), 'true');
    await page.getByRole('radio', { name: 'One Dark', exact: true }).press('End');
    assert.equal(await page.getByRole('radio', { name: 'Gruvbox Light', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('radio', { name: 'Gruvbox Light', exact: true }).evaluate((element) => element === element.getRootNode().activeElement), true);
    await page.getByRole('radio', { name: 'Gruvbox Light', exact: true }).press(' ');
    assert.equal(await page.getByRole('radio', { name: 'Gruvbox Light', exact: true }).getAttribute('aria-checked'), 'true');
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'theme-gallery-light.png'), fullPage: true });
    // Arrow keys on a non-radio button (the mode select trigger) must not move the selection.
    const modeTrigger = page.locator('cr-theme-gallery cr-bar-select').first().getByRole('button');
    await modeTrigger.focus();
    await modeTrigger.press('ArrowRight');
    assert.equal(await page.evaluate(() => localStorage.getItem('cretli-theme')), 'gruvbox-light');
    // Enter and Space on a focused, unselected tile select it exactly once (no extra native click).
    await page.evaluate(() => {
      window.themeWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key === 'cretli-theme') window.themeWrites.push(value); return original.call(this, key, value); };
    });
    for (const key of ['Enter', ' ']) {
      await page.getByRole('radio', { name: 'Dracula', exact: true }).focus();
      await page.getByRole('radio', { name: 'Dracula', exact: true }).press(key);
      assert.deepEqual(await page.evaluate(() => window.themeWrites.splice(0)), ['dracula']);
      await page.getByRole('radio', { name: 'Nord', exact: true }).click();
      await page.evaluate(() => window.themeWrites.splice(0));
    }
    const mode = page.locator('cr-theme-gallery cr-bar-select').first();
    await mode.getByRole('button').click();
    await page.getByRole('option', { name: 'System', exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem('cretli-theme') === 'system');
    assert.deepEqual(await page.evaluate(() => ['dark', 'light'].map((appearance) => localStorage.getItem(`cretli-theme-${appearance}`))), ['cretli-dark', 'cretli-light']);
    const light = page.locator('cr-theme-gallery cr-bar-select').nth(1);
    await light.getByRole('button').click();
    assert.equal(await page.getByRole('option', { name: 'Dracula', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'GitHub Light', exact: true }).click();
    const dark = page.locator('cr-theme-gallery cr-bar-select').nth(2);
    await dark.getByRole('button').click();
    assert.equal(await page.getByRole('option', { name: 'GitHub Light', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'Nord', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.themeId === 'github-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.themeId === 'nord');
    assert.equal(await page.evaluate(() => window.themeHarness.bootId), bootId, 'all changes happen without reload');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(output, { recursive: true, force: true });
  }
});
