/**
 * Stage 3.2 — delegation/mailbox report preview budgets and shared Markdown cache.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

import {
  UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES,
  UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES,
} from '../app_front/lib/uiFreezeRenderBudgets.js';
import {
  buildHistoryCardReportViewModel,
  computeHistoryCardReportContentKey,
  estimateHtmlElementCount,
  getHistoryCardReportMarkdownRenderCount,
  measureUtf8ByteLength,
  registerHistoryCardReportFullText,
  renderHistoryCardReportMarkdownCached,
  resetHistoryCardReportRuntimeForTests,
  sliceUtf8TextPage,
  truncateUtf8Text,
} from '../app_front/lib/delegationHistoryCardReport.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const richViewSource = readFileSync(
  path.join(projectRoot, 'app_front/lib/sdk-rich-view.js'),
  'utf8',
);
const reportModuleSource = readFileSync(
  path.join(projectRoot, 'app_front/lib/delegationHistoryCardReport.js'),
  'utf8',
);
const noBufferChild = path.join(projectRoot, 'tests/delegation-history-card-report-no-buffer.mjs');

/** @param {number} minUtf8Bytes */
function buildSyntheticReport(minUtf8Bytes) {
  const line = `${'paragraph '.repeat(120)}\n\n`;
  let body = '';
  while (measureUtf8ByteLength(body) < minUtf8Bytes) {
    body += line;
  }
  assert.ok(measureUtf8ByteLength(body) >= minUtf8Bytes);
  return body;
}

const reportTestDeps = {
  escapeHtml: (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;'),
  t: (key) => key,
  renderMarkdown: (source) => `<div class="sdk-md"><pre><code>${source.length}</code></pre></div>`,
};

/** @param {string} dir */
function walkJsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      walkJsFiles(full, out);
      continue;
    }
    if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('preview caps UTF-8 for synthetic report ≥800 KiB', () => {
  const full = buildSyntheticReport(800 * 1024);
  const model = buildHistoryCardReportViewModel({ fullText: full });
  assert.equal(model.isTruncated, true);
  assert.ok(model.previewUtf8Bytes <= UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES);
  assert.ok(model.fullUtf8Bytes >= 800 * 1024);
});

test('expand pages stay within expand byte budget', () => {
  const full = buildSyntheticReport(900 * 1024);
  let offset = UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES;
  let pages = 0;
  while (pages < 200) {
    const page = sliceUtf8TextPage(full, offset, UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES);
    if (!page.text) break;
    assert.ok(page.utf8Bytes <= UI_FREEZE_DELEGATION_EXPAND_UTF8_BYTES);
    offset = page.nextUtf8ByteOffset;
    pages += 1;
    if (!page.hasMore) break;
  }
  assert.ok(pages >= 2);
  assert.equal(offset, measureUtf8ByteLength(full));
});

test('shared content key deduplicates heavy Markdown render across two cards', () => {
  resetHistoryCardReportRuntimeForTests();
  const full = buildSyntheticReport(820 * 1024);
  const key = registerHistoryCardReportFullText(full);
  const model = buildHistoryCardReportViewModel({ fullText: full });
  let renderCalls = 0;
  const renderMarkdown = (source) => {
    renderCalls += 1;
    assert.ok(measureUtf8ByteLength(source) <= UI_FREEZE_DELEGATION_PREVIEW_UTF8_BYTES);
    return `<pre>${source.length}</pre>`;
  };
  renderHistoryCardReportMarkdownCached(`${key}:view:0`, model.previewText, renderMarkdown);
  renderHistoryCardReportMarkdownCached(`${key}:view:0`, model.previewText, renderMarkdown);
  assert.equal(renderCalls, 1);
  assert.equal(getHistoryCardReportMarkdownRenderCount(), 1);
  assert.equal(computeHistoryCardReportContentKey(full), key);
});

test('preview DOM estimate stays far below naive full-report render for 800 KiB', () => {
  const full = buildSyntheticReport(800 * 1024);
  const model = buildHistoryCardReportViewModel({ fullText: full });
  const previewHtml = renderHistoryCardReportMarkdownCached(
    `${model.contentKey}:bench:0`,
    model.previewText,
    (source) => `<div class="sdk-md"><pre><code>${source}</code></pre></div>`,
  );
  const previewNodes = estimateHtmlElementCount(previewHtml);
  const naiveHtml = `<div class="sdk-md"><pre><code>${full}</code></pre></div>`;
  const naiveNodes = estimateHtmlElementCount(naiveHtml);
  assert.ok(previewNodes < 32);
  assert.ok(naiveNodes > 10_000 || full.length > 500_000);
  assert.ok(previewNodes * 2 < 500);
});

test('sdk-rich-view keeps status/actions and wires bounded report controls', () => {
  assert.match(richViewSource, /buildHistoryCardReportHostHtml/);
  assert.match(richViewSource, /wireHistoryCardReportControls/);
  assert.match(richViewSource, /delegationOpenChild/);
  assert.match(richViewSource, /renderDelegationCard/);
  assert.match(richViewSource, /renderMailboxCard/);
  assert.match(reportModuleSource, /chat\.delegationReportCopyFull/);
  assert.match(reportModuleSource, /chat\.delegationReportShowMore/);
});

test('truncateUtf8Text respects UTF-8 multibyte boundary', () => {
  const text = 'ąę'.repeat(2000);
  const slice = truncateUtf8Text(text, 100);
  assert.ok(slice.utf8Bytes <= 100);
  const roundTripBytes = measureUtf8ByteLength(slice.text);
  assert.equal(roundTripBytes, slice.utf8Bytes);
});

test('app_front/lib has no Node Buffer API usage', () => {
  const libRoot = path.join(projectRoot, 'app_front/lib');
  const files = walkJsFiles(libRoot);
  const offenders = [];
  const pattern = /\bBuffer\.(byteLength|from|alloc|concat)\b/;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (pattern.test(source)) offenders.push(path.relative(projectRoot, file));
  }
  assert.deepEqual(offenders, []);
});

test('report helpers run without global Buffer (subprocess)', () => {
  const importUrl = pathToFileURL(noBufferChild).href;
  const out = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `globalThis.Buffer = undefined;
delete global.Buffer;
await import(${JSON.stringify(importUrl)});`,
  ], { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.match(out, /no-buffer\.mjs OK/);
});

/**
 * @param {string} root
 * @returns {Promise<{ server: import('node:http').Server, baseUrl: string }>}
 */
function startStaticModuleServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const rel = decodeURIComponent(url.pathname).replace(/^\//, '');
        const filePath = path.resolve(root, rel);
        if (!filePath.startsWith(`${path.resolve(root)}${path.sep}`) && filePath !== path.resolve(root)) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }
        const data = readFileSync(filePath);
        const type = filePath.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
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

function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  return candidates.find((file) => existsSync(file));
}

test('two report cards and expand stay within DOM node budget (Chromium)', { timeout: 120_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required for DOM harness (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const moduleUrl = `${baseUrl}/app_front/lib/delegationHistoryCardReport.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/tests/delegation-history-card-report-dom-shell.html`, { waitUntil: 'load' });
    await page.evaluate(async ({ importUrl, minUtf8Bytes }) => {
      const mod = await import(importUrl);
      mod.resetHistoryCardReportRuntimeForTests();
      const line = `${'paragraph '.repeat(120)}\n\n`;
      let body = '';
      while (mod.measureUtf8ByteLength(body) < minUtf8Bytes) body += line;
      const deps = {
        escapeHtml: (value) => String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/"/g, '&quot;'),
        t: (key) => key,
        renderMarkdown: (source) => `<div class="sdk-md"><pre><code>${source.length}</code></pre></div>`,
      };
      const cardHtml = mod.buildHistoryCardReportHostHtml(body, deps);
      const cardHtmlSecond = mod.buildHistoryCardReportHostHtml(body, deps);
      const root = document.getElementById('cards');
      if (!root) throw new Error('missing root');
      root.innerHTML = cardHtml + cardHtmlSecond;
      mod.wireHistoryCardReportControls(root, {
        t: (key) => key,
        renderMarkdown: deps.renderMarkdown,
        writeTextToClipboard: () => {},
        decorateCodeForCopy: () => {},
      });
    }, { importUrl: moduleUrl, minUtf8Bytes: 800 * 1024 });
    const nodesBeforeExpand = await page.evaluate(() => {
      const root = document.getElementById('cards');
      return root ? root.querySelectorAll('*').length : 0;
    });
    assert.ok(nodesBeforeExpand > 0);
    assert.ok(nodesBeforeExpand < 500, `expected bounded preview DOM, got ${nodesBeforeExpand} nodes`);
    await page.evaluate(async () => {
      const root = document.getElementById('cards');
      if (!root) throw new Error('missing root');
      const btn = root.querySelector('[data-report-action="expand"]');
      if (!(btn instanceof HTMLElement)) throw new Error('missing expand');
      btn.click();
    });
    const nodesAfterExpand = await page.evaluate(() => {
      const root = document.getElementById('cards');
      return root ? root.querySelectorAll('*').length : 0;
    });
    assert.ok(nodesAfterExpand > nodesBeforeExpand);
    assert.ok(nodesAfterExpand < 600, `expand should stay bounded, got ${nodesAfterExpand} nodes`);
    const pageCount = await page.evaluate(() => document.querySelectorAll('.sdk-rich-delegation-report-page').length);
    assert.equal(pageCount, 1);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

console.log('ui-freeze-delegation-report-preview.test.js OK');
