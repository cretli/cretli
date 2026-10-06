/**
 * Child-chat link backfill placement (real DOM).
 *
 * A parent chat mounts only the last history window, but chat metadata knows
 * every child. Appending the unmounted ones pushed all older "Child chat" rows
 * to the stream tail on every resume. A backfilled link must sit next to the
 * delegation card that created it, or not render at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('backfilled child links anchor to the delegation card or stay out', { timeout: 120_000 }, async () => {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    assert.fail('Chromium executable required (set CHAT_E2E_CHROMIUM_EXECUTABLE_PATH)');
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const viewUrl = `${baseUrl}/app_front/lib/sdk-rich-view.js`;
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    await page.goto(`${baseUrl}/tests/related-chat-links-dom-shell.html`, { waitUntil: 'load' });
    const result = await page.evaluate(async ({ viewUrl }) => {
      const view = await import(viewUrl);
      const mount = document.getElementById('mount');
      if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
      const rich = view.createSdkRichView({ id: 'parent-1' }, mount, { appendPlain() {} });
      const delegation = {
        kind: 'meta',
        variant: 'delegation',
        historySeq: 1,
        payload: JSON.stringify({
          id: 'd1',
          status: 'running',
          childChatId: 'child-1',
          executor: {},
        }),
      };
      const related = {
        kind: 'meta',
        variant: 'relatedChat',
        historySeq: 2,
        payload: JSON.stringify({ role: 'child', chatId: 'child-1', title: 'Task' }),
      };
      await rich.replayHistoryRecords([delegation, related], { instant: true, source: 'test' });
      const renderedFromHistory = document.querySelectorAll('[data-related-chat-id]').length;

      rich.ensureRelatedChatLinks({
        parent: null,
        children: [{ chatId: 'child-1' }, { chatId: 'child-2' }],
      });
      const afterFirstPass = [...document.querySelectorAll('[data-related-chat-id]')]
        .map((el) => el.dataset.relatedChatId);
      const unanchoredPresent = !!document.querySelector('[data-related-chat-id="child-2"]');

      document.querySelector('[data-related-chat-id="child-1"]')?.remove();
      rich.ensureRelatedChatLinks({
        parent: null,
        children: [{ chatId: 'child-1' }, { chatId: 'child-2' }],
      });
      const backfilled = document.querySelector('[data-related-chat-id="child-1"]');
      const delegationCard = document.querySelector('[data-delegation-id="d1"]');
      return {
        renderedFromHistory,
        afterFirstPass,
        unanchoredPresent,
        anchoredBeforeDelegation: Boolean(
          backfilled instanceof HTMLElement
          && delegationCard instanceof HTMLElement
          && backfilled.nextElementSibling === delegationCard
        ),
        backfilledStillUnanchoredPresent: !!document.querySelector('[data-related-chat-id="child-2"]'),
      };
    }, { viewUrl });

    assert.deepEqual(pageErrors, []);
    assert.equal(result.renderedFromHistory, 1, 'history paints the child link inline');
    assert.deepEqual(result.afterFirstPass, ['child-1'], 'existing link is not duplicated');
    assert.equal(result.unanchoredPresent, false, 'an unanchored child must not be appended');
    assert.equal(result.anchoredBeforeDelegation, true, 'a re-backfilled link sits by its delegation card');
    assert.equal(result.backfilledStillUnanchoredPresent, false);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve(undefined)));
    });
  }
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
        const type = filePath.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(readFileSync(filePath));
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
