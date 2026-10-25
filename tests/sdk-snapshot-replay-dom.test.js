/**
 * Answer snapshots replayed after a reconnect (real DOM).
 *
 * A reconnect re-delivers every cumulative snapshot of a run. Once later cards
 * (tool, usage) are on screen the older snapshots sort before them; each one
 * used to open its own answer block. They must all update the one block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { readServedModule } from './helpers/serve-ts-module.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('replayed answer snapshots update one block when later cards exist', { timeout: 120_000 }, async () => {
  const executablePath = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((file) => existsSync(file)) || String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '');
  if (!executablePath || !existsSync(executablePath)) assert.fail('Chromium executable required');
  const server = createServer((req, res) => {
    const file = path.resolve(projectRoot, decodeURIComponent(new URL(req.url || '/', 'http://x').pathname).replace(/^\//, ''));
    if (!file.startsWith(projectRoot)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const { type, body } = readServedModule(file);
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/related-chat-links-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async (viewUrl) => {
      const view = await import(viewUrl);
      const full = 'Yes, but the cache belongs to the prompt prefix, so a fork inherits it';
      const snap = (i) => ({
        type: 'assistant',
        streamTextMode: 'snapshot',
        message: { role: 'assistant', content: [{ type: 'text', text: full.slice(0, i * 8) }] },
      });
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const chat = { id: 'replay-1' };
      const rich = view.createSdkRichView(chat, mount, { appendPlain() {} });
      const meta = (seq) => ({ roomEventSeq: seq, eventStreamId: 'S1' });
      rich.appendUserPrompt('hi', meta(90));
      for (let i = 1; i <= 8; i += 1) rich.applyEvent(snap(i), meta(100 + i));
      rich.applyEvent({ type: 'tool_call', call_id: 't1', name: 'Bash', status: 'completed', result: 'ok' }, meta(120));
      rich.applyEvent({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }, meta(121));
      // Reconnect: hello resets the stream, then the whole run is replayed.
      delete chat._sdkAssistantAcc;
      delete chat._sdkThinkingAcc;
      rich.onStreamReset();
      for (let i = 1; i <= 8; i += 1) rich.applyEvent(snap(i), meta(100 + i));
      const hosts = [...mount.querySelectorAll('.sdk-rich-assistant-md')];
      return { count: hosts.length, raw: hosts[0]?.dataset.rawMd || '' };
    }, `${baseUrl}/app_front/lib/sdk-rich-view.js`);
    assert.deepEqual(pageErrors, []);
    assert.equal(result.count, 1);
    assert.ok(result.raw.startsWith('Yes, but the cache'));
  } finally {
    await browser.close();
    server.close();
  }
});
