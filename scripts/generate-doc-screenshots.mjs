#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { detectBrowserRuntime, buildChromiumProcessEnv } from '../lib/browser/runtime-detect.js';
import { assertScreenshotClean } from './lib/doc-screenshot-privacy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'website/docs/img');
const ctx = { username: os.userInfo().username, hostname: os.hostname(), privateTokens: process.env.CRETLI_PRIVATE_TOKENS || '' };

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function generate() {
  if (spawnSync('tesseract', ['--version'], { stdio: 'ignore' }).status !== 0) {
    throw Object.assign(new Error('tesseract is required on PATH for screenshot privacy checks'), { code: 3 });
  }
  const runtime = await detectBrowserRuntime();
  if (!runtime.available) throw Object.assign(new Error(runtime.reason), { code: 2 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-doc-demo-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let child;
  let browser;
  try {
    child = spawn(process.execPath, ['scripts/demo-instance.mjs', '--dir', dir, '--port', String(port)], { cwd: root, env: { PATH: process.env.PATH, HOME: dir, CRETLI_DATA_DIR: path.join(dir, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo startup timed out')), 60000);
      let log = '';
      child.stdout.on('data', (chunk) => { log = (log + chunk).slice(-8000); if (log.includes('[demo] ready:')) { clearTimeout(timer); resolve(undefined); } });
      child.stderr.on('data', () => {});
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Demo exited before capture (${code})`)); });
    });
    browser = await chromium.launch({ executablePath: runtime.executablePath, headless: true, env: buildChromiumProcessEnv(), args: ['--disable-dev-shm-usage', ...(process.env.CRETLI_BROWSER_ALLOW_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US', serviceWorkers: 'block' });
    await context.addInitScript(() => { localStorage.setItem('cretli-theme', 'dark'); localStorage.setItem('cretli-lang', 'en'); });
    const login = await context.request.post(`${base}/api/login`, { data: { password: 'demo-password' } });
    if (!login.ok()) throw new Error(`Demo login failed: ${login.status()}`);
    const manifest = [];
    const pending = [];
    async function pageFor(mobile = false) {
      const page = await context.newPage();
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
      await page.goto(base);
      await page.locator('#header-menu-btn').waitFor();
      await page.waitForTimeout(1200);
      return page;
    }
    async function capture(page, name, mobile = false) {
      await page.evaluate('document.fonts.ready');
      await page.waitForTimeout(700);
      if (name === 'chat-list-mobile') {
        if (!(await page.locator('body').evaluate(el => el.classList.contains('sidebar-open')))) await page.locator('#header-menu-btn').click();
        await page.locator('#app-sidebar .sidebar-chat-item').nth(3).waitFor();
        await page.waitForTimeout(300);
      }
      const domText = await page.evaluate(() => {
        function text(root) {
          let value = root.innerText || '';
          for (const el of root.querySelectorAll('*')) {
            if (el.matches('input,textarea')) value += `\n${el.value}`;
            if (el.shadowRoot) value += `\n${text(el.shadowRoot)}`;
          }
          return value;
        }
        const doc = /** @type {any} */ (globalThis).document;
        return `${doc.title}\n${text(doc.body)}`;
      });
      const png = await sharp(await page.screenshot({ fullPage: false, scale: 'device' })).png({ palette: true, compressionLevel: 9 }).toBuffer();
      const temp = path.join(dir, `${name}.png`);
      await fs.writeFile(temp, png);
      const ocr = spawnSync('tesseract', [temp, 'stdout'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (ocr.status !== 0) throw new Error(`OCR failed for ${name}`);
      try { assertScreenshotClean({ domText, ocrText: ocr.stdout, ctx }); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
      if (png.length > 700000) throw new Error(`${name} exceeds 700 kB`);
      const { width, height } = await sharp(png).metadata();
      manifest.push({ name, width, height, deviceScaleFactor: mobile ? 2 : 1, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex'), generatedAt: new Date().toISOString() });
      pending.push({ name, png });
      console.log(`[screenshots] checked ${name}`);
    }
    const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US', serviceWorkers: 'block', storageState: await context.storageState() });
    await mobileContext.addInitScript(() => { localStorage.setItem('cretli-theme', 'dark'); localStorage.setItem('cretli-lang', 'en'); });
    const mobile = await mobileContext.newPage();
    await mobile.goto(base);
    await mobile.getByText('All 12 focused tests passed.', { exact: false }).first().waitFor();
    await mobile.waitForTimeout(1000);
    await mobile.locator('#header-menu-btn').click();
    await mobile.locator('cr-sidebar-chat-row[chat-id="00000000-0000-4000-8000-000000000001"] .sidebar-chat-item').waitFor();
    await capture(mobile, 'chat-list-mobile', true);
    if (await mobile.locator('#app-sidebar').evaluate(el => el.getBoundingClientRect().right <= 0)) await mobile.locator('#header-menu-btn').click();
    await mobile.locator('cr-sidebar-chat-row[chat-id="00000000-0000-4000-8000-000000000001"] .sidebar-chat-item-title-text').click();
    await mobile.waitForTimeout(1500);
    await mobile.getByText('All 12 focused tests passed.', { exact: false }).first().waitFor();
    await capture(mobile, 'chat-open-mobile', true);
    const page = await pageFor();
    await page.locator('#header-menu-btn').click();
    await page.locator('cr-sidebar-chat-row[chat-id="00000000-0000-4000-8000-000000000001"] .sidebar-chat-item-title-text').click();
    await page.getByText('All 12 focused tests passed.', { exact: false }).first().waitFor();
    await page.locator('#sidebar-close-btn').click();
    await capture(page, 'chat-desktop');
    await page.locator('[data-panel="todo"]').click();
    await page.waitForTimeout(1500);
    await page.getByText('Checkout redesign', { exact: true }).first().waitFor();
    await capture(page, 'todo-tree');
    await page.locator('#header-settings-btn').click();
    for (const [tab, name] of [['usage', 'settings-usage'], ['watcher', 'watcher-panel'], ['workspace', 'settings-workspace']]) {
      await page.locator(`#settings-tabs [data-settings-tab="${tab}"]`).click();
      await capture(page, name);
    }
    await fs.mkdir(output, { recursive: true });
    for (const { name, png } of pending) await fs.writeFile(path.join(output, `${name}.png`), png);
    await fs.writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await browser?.close();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}

generate().catch((error) => { console.error(error.message); process.exitCode = Number(error.code) || 1; });
