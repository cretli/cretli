/**
 * Stage 5.2 — bounded tool_call stdout/result preview (UI freeze).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

import {
  UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES,
  UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES,
} from '../app_front/lib/uiFreezeRenderBudgets.js';
import {
  buildBoundedToolJsonPreview,
  buildToolOutputResultSectionHtml,
  extractPrimaryToolOutputText,
  extractToolResultMeta,
  formatToolResultMetaLine,
  resolveToolOutputPreviewModel,
  shallowTruncateStringsForJson,
} from '../app_front/lib/sdkToolCallOutputPreview.js';
import {
  getHistoryCardReportFullText,
  measureUtf8ByteLength,
  resetHistoryCardReportRuntimeForTests,
} from '../app_front/lib/delegationHistoryCardReport.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const richViewSource = readFileSync(
  path.join(projectRoot, 'app_front/lib/sdk-rich-view.js'),
  'utf8',
);

/** @param {number} minUtf8Bytes */
function buildSyntheticStdout(minUtf8Bytes) {
  const line = `${'tool-output-line '.repeat(40)}\n`;
  let body = '';
  while (measureUtf8ByteLength(body) < minUtf8Bytes) {
    body += line;
  }
  assert.ok(measureUtf8ByteLength(body) >= minUtf8Bytes);
  return body;
}

test('extractPrimaryToolOutputText reads nested value.stdout', () => {
  const stdout = 'hello stdout';
  assert.equal(extractPrimaryToolOutputText({ value: { stdout } }), stdout);
  assert.equal(extractPrimaryToolOutputText({ stdout }), stdout);
});

test('extractToolResultMeta collects exitCode alongside stdout without stringify', () => {
  const stdout = 'line\n';
  const meta = extractToolResultMeta({ exitCode: 1, value: { stdout, code: 2 } });
  assert.equal(meta?.exitCode, 1);
  assert.equal(meta?.code, 2);
  assert.equal(formatToolResultMetaLine(meta), 'exitCode=1 · code=2');
  const preview = buildBoundedToolJsonPreview({ exitCode: 0, value: { stdout } });
  assert.ok(preview.text.includes('line'));
  assert.ok(!preview.text.includes('exitCode'));
});

test('formatToolResultMetaLine stays UTF-8 bounded', () => {
  const meta = extractToolResultMeta({ error: 'x'.repeat(500), stdout: 'out' });
  assert.equal(meta, null);
  const longMeta = extractToolResultMeta({ error: 'e'.repeat(300) });
  assert.equal(longMeta, null);
  const partialMeta = extractToolResultMeta({ exitCode: 0, error: 'e'.repeat(300) });
  assert.equal(partialMeta?.exitCode, 0);
  assert.equal(partialMeta?.error, undefined);
});

test('buildBoundedToolJsonPreview avoids full stringify on ~1 MiB stdout', () => {
  const stdout = buildSyntheticStdout(1024 * 1024);
  const started = performance.now();
  const preview = buildBoundedToolJsonPreview({ value: { stdout } });
  const elapsedMs = performance.now() - started;
  assert.ok(preview.truncated);
  assert.ok(preview.utf8Bytes <= UI_FREEZE_TOOL_CALL_JSON_PREVIEW_UTF8_BYTES);
  assert.ok(elapsedMs <= 50, `preview build took ${elapsedMs} ms`);
});

test('resolveToolOutputPreviewModel keeps full text in store on demand', () => {
  resetHistoryCardReportRuntimeForTests();
  const stdout = buildSyntheticStdout(900 * 1024);
  const model = resolveToolOutputPreviewModel(stdout);
  assert.equal(model.useReportHost, true);
  assert.ok(model.fullUtf8Bytes >= 900 * 1024);
  assert.ok(measureUtf8ByteLength(model.previewText) <= UI_FREEZE_TOOL_CALL_PREVIEW_UTF8_BYTES);
  const roundTrip = getHistoryCardReportFullText(model.contentKey);
  assert.equal(roundTrip, stdout);
});

test('tool result section HTML stays bounded for ~1 MiB stdout', () => {
  resetHistoryCardReportRuntimeForTests();
  const stdout = buildSyntheticStdout(1024 * 1024);
  const started = performance.now();
  const html = buildToolOutputResultSectionHtml(stdout, {
    escapeHtml: (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;'),
    t: (key) => key,
    buildReportHostHtml: (text) => {
      const model = resolveToolOutputPreviewModel(text);
      return `<div class="sdk-rich-delegation-report-host" data-report-content-key="${model.contentKey}"><pre>${model.previewText.length}</pre></div>`;
    },
  });
  const elapsedMs = performance.now() - started;
  assert.ok(html.length < 64_000, `html length ${html.length}`);
  assert.match(html, /data-report-content-key="/);
  assert.ok(elapsedMs <= 50, `html build took ${elapsedMs} ms`);
});

test('sdk-rich-view createToolBody uses bounded tool output helpers', () => {
  assert.match(richViewSource, /buildBoundedToolJsonPreview/);
  assert.match(richViewSource, /buildToolOutputResultSectionHtml/);
  assert.match(richViewSource, /extractPrimaryToolOutputText/);
  assert.match(richViewSource, /extractToolResultMeta/);
  assert.doesNotMatch(richViewSource, /stringifySnippet\(ev\.result, 4800\)/);
});

test('shallowTruncateStringsForJson caps long strings before JSON.stringify', () => {
  const huge = 'x'.repeat(200_000);
  const cloned = /** @type {{ nested: { stdout: string } }} */ (
    shallowTruncateStringsForJson({ nested: { stdout: huge } }, 4096)
  );
  assert.ok(cloned.nested.stdout.length < 5000);
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

test('Chromium apply for ~1 MiB tool stdout stays ≤50 ms with bounded DOM', { timeout: 120_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const previewModuleUrl = `${baseUrl}/app_front/lib/sdkToolCallOutputPreview.js`;
  const reportModuleUrl = `${baseUrl}/app_front/lib/delegationHistoryCardReport.js`;
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/tests/sdk-tool-call-output-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ previewModuleUrl, reportModuleUrl, minUtf8Bytes }) => {
      const previewMod = await import(previewModuleUrl);
      const reportMod = await import(reportModuleUrl);
      reportMod.resetHistoryCardReportRuntimeForTests();
      const line = `${'tool-output-line '.repeat(40)}\n`;
      let stdout = '';
      while (reportMod.measureUtf8ByteLength(stdout) < minUtf8Bytes) stdout += line;
      const host = document.getElementById('host');
      if (!host) throw new Error('missing host');
      host.replaceChildren();
      const ev = { name: 'shell', status: 'completed', result: { value: { stdout } } };
      const t0 = performance.now();
      const primary = previewMod.extractPrimaryToolOutputText(ev.result);
      const sectionHtml = previewMod.buildToolOutputResultSectionHtml(primary, {
        escapeHtml: (value) => String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;'),
        t: (key) => key,
        buildReportHostHtml: (text) => reportMod.buildHistoryCardReportHostHtml(text, {
          escapeHtml: (value) => String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;'),
          t: (key) => key,
          renderMarkdown: (source) => `<pre class="sdk-rich-json">${source.length}</pre>`,
        }, { preserveWhitespace: true }),
      });
      const wrap = document.createElement('div');
      wrap.innerHTML = sectionHtml;
      host.appendChild(wrap);
      reportMod.wireHistoryCardReportControls(host, {
        t: (key) => key,
        renderMarkdown: (source) => `<pre>${source.length}</pre>`,
        writeTextToClipboard: () => {},
        decorateCodeForCopy: () => {},
      });
      previewMod.buildBoundedToolJsonPreview(ev.args);
      const elapsedMs = performance.now() - t0;
      const domNodes = host.querySelectorAll('*').length;
      const contentKey = host.querySelector('[data-report-content-key]')?.getAttribute('data-report-content-key') || '';
      const stored = contentKey ? reportMod.getHistoryCardReportFullText(contentKey) : '';
      return {
        elapsedMs,
        domNodes,
        stdoutLength: stdout.length,
        storedLength: stored.length,
        fullUtf8Bytes: reportMod.measureUtf8ByteLength(stdout),
        storedUtf8Bytes: reportMod.measureUtf8ByteLength(stored),
        hasExpand: !!host.querySelector('[data-report-action="expand"]'),
      };
    }, { previewModuleUrl, reportModuleUrl, minUtf8Bytes: 1024 * 1024 });
    assert.ok(result.elapsedMs <= 50, `apply took ${result.elapsedMs} ms`);
    assert.ok(result.domNodes < 80, `dom nodes ${result.domNodes}`);
    assert.ok(result.fullUtf8Bytes >= 1024 * 1024);
    assert.equal(result.storedLength, result.stdoutLength);
    assert.ok(result.storedUtf8Bytes >= 1024 * 1024);
    assert.equal(result.hasExpand, true);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
});

console.log('ui-freeze-tool-call-output-preview.test.js OK');
