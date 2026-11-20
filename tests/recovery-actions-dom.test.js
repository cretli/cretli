/**
 * Recovery action UI (real DOM, Playwright).
 *
 * These regressions need the actual `createSdkRichView` DOM lifecycle, not a
 * source-text assertion:
 *
 * - F1: "Keep stopped" empties the persisted run list. The success feedback
 *   must stay rendered after the action's second read (and after the registry
 *   is notified again) instead of hiding the banner.
 * - F2: recovery widget registrations must be released when the card is removed
 *   or the view is destroyed, while a card that a replay temporarily detaches
 *   keeps its registration.
 */
import test from 'node:test';
import './fixtures/fake-transport.js';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { readServedModule } from './helpers/serve-ts-module.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ page: import('playwright-core').Page, close: () => Promise<void> }>}
 */
async function openPage(t) {
  const executablePath = resolveChromiumExecutable();
  if (!executablePath) {
    t.skip('Chromium executable required for the recovery DOM test');
    return null;
  }
  const { server, baseUrl } = await startStaticModuleServer(projectRoot);
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/tests/recovery-actions-dom-shell.html`, { waitUntil: 'load' });
  return {
    page,
    async close() {
      await browser.close();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)));
      });
    },
  };
}

test('keep-stopped feedback survives an empty run list after the action read', { timeout: 120_000 }, async (t) => {
  const opener = await openPage(t);
  if (!opener) return;
  const { page, close } = opener;
  try {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    const result = await page.evaluate(async () => {
      /** @type {string[]} */
      const recoveryReads = [];
      /** @type {'present' | 'empty'} */
      let runMode = 'present';
      const run = {
        logicalRunId: 'run-1',
        chatId: 'chat-1',
        state: 'interrupted',
        status: 'interrupted_restart',
        reason: 'server_restart',
        revision: 2,
        canResume: true,
        canKeepStopped: true,
        needsConfirm: false,
      };
      const previousFetch = window.fetch;
      window.fetch = async (url) => {
        const pathname = new URL(String(url), window.location.href).pathname;
        if (pathname.endsWith('/recovery-runs')) {
          recoveryReads.push(pathname);
          const runs = runMode === 'present' ? [run] : [];
          return { status: 200, ok: true, json: async () => ({ ok: true, runs }) };
        }
        if (pathname.endsWith('/keep-stopped')) {
          return {
            status: 200,
            ok: true,
            json: async () => ({ ok: true, status: 'kept_stopped', revision: 3, state: 'cancelled' }),
          };
        }
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      };
      try {
        const { initI18n } = await import('/app_front/i18n/index.js');
        await initI18n();
        const { createSdkRichView } = await import('/app_front/lib/sdk-rich-view.js');
        const mount = document.getElementById('mount');
        if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
        const view = createSdkRichView({
          id: 'chat-1',
          _serverRunState: { recoveryStatus: 'interrupted_restart' },
        }, mount, { appendPlain() {} });
        const waitFor = async (predicate, label) => {
          for (let attempt = 0; attempt < 150; attempt += 1) {
            const value = predicate();
            if (value) return value;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(`timeout waiting for ${label}`);
        };
        const banner = () => document.querySelector('.sdk-rich-recovery-banner');
        const button = await waitFor(
          () => document.querySelector('[data-recovery-action="keep-stopped"]'),
          'keep-stopped button',
        );
        const readsBeforeAction = recoveryReads.length;
        runMode = 'empty';
        button.click();
        await waitFor(() => {
          const el = banner()?.querySelector('.sdk-rich-recovery-feedback');
          return el && el.hidden === false && recoveryReads.length === readsBeforeAction + 1 ? el : null;
        }, 'visible action feedback');
        // Give any stale second refresh a chance to wipe the confirmation.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const settled = banner()?.querySelector('.sdk-rich-recovery-feedback');
        const snapshot = {
          readsBeforeAction,
          totalReads: recoveryReads.length,
          bannerHidden: banner()?.hidden === true,
          feedbackHidden: settled?.hidden === true,
          feedbackText: settled?.textContent || '',
          remainingRows: banner()?.querySelectorAll('.sdk-rich-recovery-row').length || 0,
          heading: banner()?.querySelector('.sdk-rich-recovery-banner-title')?.textContent || '',
        };
        view.destroy();
        return snapshot;
      } finally {
        window.fetch = previousFetch;
      }
    });
    assert.deepEqual(pageErrors, []);
    assert.equal(result.readsBeforeAction, 1, 'the mount performs the first persisted read');
    assert.equal(result.totalReads, 2, 'the action performs exactly one refresh read');
    assert.equal(result.bannerHidden, false, 'the banner stays visible for the confirmation');
    assert.equal(result.feedbackHidden, false, 'the keep-stopped confirmation stays visible');
    assert.equal(result.feedbackText, 'The run is marked as stopped.');
    assert.equal(result.remainingRows, 0, 'the kept-stopped run is no longer actionable');
    assert.equal(result.heading, 'Interrupted run');
  } finally {
    await close();
  }
});

test('recovery widget registrations follow the card lifecycle, not a leaked closure', { timeout: 120_000 }, async (t) => {
  const opener = await openPage(t);
  if (!opener) return;
  const { page, close } = opener;
  try {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    const result = await page.evaluate(async () => {
      /** @type {string[]} */
      const recoveryReads = [];
      const runFor = (chatId) => ({
        logicalRunId: `run-${chatId}`,
        chatId,
        state: 'interrupted',
        status: 'interrupted_restart',
        reason: 'server_restart',
        revision: 2,
        canResume: true,
        canKeepStopped: true,
        needsConfirm: false,
      });
      const previousFetch = window.fetch;
      window.fetch = async (url) => {
        const pathname = new URL(String(url), window.location.href).pathname;
        if (pathname.endsWith('/recovery-runs')) {
          recoveryReads.push(pathname);
          const chatId = decodeURIComponent(pathname.split('/')[3] || '');
          const runs = chatId ? [runFor(chatId)] : [];
          return { status: 200, ok: true, json: async () => ({ ok: true, runs }) };
        }
        return { status: 200, ok: true, json: async () => ({ ok: true }) };
      };
      const waitFor = async (predicate, label) => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const value = predicate();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`timeout waiting for ${label}`);
      };
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        const { initI18n } = await import('/app_front/i18n/index.js');
        await initI18n();
        const { createSdkRichView } = await import('/app_front/lib/sdk-rich-view.js');
        const { notifyRecoveryWidgets } = await import('/app_front/features/chat/recoveryActions.js');
        const mount = document.getElementById('mount');
        if (!(mount instanceof HTMLElement)) throw new Error('missing mount');
        const view = createSdkRichView({
          id: 'chat-1',
          _serverRunState: { recoveryStatus: 'interrupted_restart' },
        }, mount, { appendPlain() {} });
        const readsFor = (chatId) => recoveryReads.filter(
          (pathname) => pathname.endsWith(`/api/chats/${chatId}/recovery-runs`),
        ).length;
        const cardFor = (delegationId) => document.querySelector(`[data-delegation-id="${delegationId}"]`);
        const recordFor = (delegationId, childChatId, historySeq) => ({
          kind: 'meta',
          variant: 'delegation',
          historySeq,
          payload: JSON.stringify({
            id: delegationId,
            status: 'failed',
            childChatId,
            executor: { transport: 'testfake', model: 'testfake/test' },
          }),
        });
        const mountCard = async (delegationId, childChatId, historySeq) => {
          await view.replayHistoryRecords(
            [recordFor(delegationId, childChatId, historySeq)],
            { instant: true, source: 'test' },
          );
          const card = await waitFor(() => cardFor(delegationId), `${delegationId} card`);
          await waitFor(() => card.querySelector('.sdk-rich-recovery-row'), `${delegationId} recovery row`);
          return card;
        };

        const card = await mountCard('d1', 'child-1', 1);
        const initialChildReads = readsFor('child-1');

        // Temporary detach (what a paged replay does): notify must not unregister
        // a host that is reinserted before the next task.
        card.remove();
        const detachedNotify = notifyRecoveryWidgets('child-1');
        const readsWhileDetached = readsFor('child-1');
        mount.querySelector('.sdk-rich-stream')?.appendChild(card);
        await wait(50);
        const reinsertNotify = notifyRecoveryWidgets('child-1');
        await wait(50);
        const readsAfterReinsert = readsFor('child-1');

        // Permanent removal: the next notification only schedules the cleanup
        // and issues no GET; once the host stays detached the registry drops it.
        card.remove();
        const removalNotify = notifyRecoveryWidgets('child-1');
        await wait(50);
        const readsAfterRemoval = readsFor('child-1');
        const afterRemovalNotify = notifyRecoveryWidgets('child-1');

        // Ledger eviction/reset must unregister while the card stays connected,
        // so no later notify is needed to trigger the detached fallback cleanup.
        const ledger = view.mountedWindowHarness.getMountedViewResourceLedger();
        const evictCard = await mountCard('d3', 'child-3', 3);
        const beforeEvictNotify = notifyRecoveryWidgets('child-3');
        const evictConnected = evictCard.isConnected;
        ledger.releaseCard(evictCard);
        const afterEvictNotify = notifyRecoveryWidgets('child-3');
        const resetCard = await mountCard('d4', 'child-4', 4);
        const beforeResetNotify = notifyRecoveryWidgets('child-4');
        const resetConnected = resetCard.isConnected;
        ledger.resetAll();
        const afterResetNotify = notifyRecoveryWidgets('child-4');

        // Destroy must release a live card registration and the chat banner.
        const card2 = await mountCard('d2', 'child-2', 2);
        const child2Reads = readsFor('child-2');
        view.destroy();
        const afterDestroyCardNotify = notifyRecoveryWidgets('child-2');
        const afterDestroyBannerNotify = notifyRecoveryWidgets('chat-1');
        await wait(50);

        return {
          beforeEvictNotify,
          afterEvictNotify,
          beforeResetNotify,
          afterResetNotify,
          resetCardConnected: Boolean(resetConnected && evictConnected),
          detachedNotify,
          reinsertNotify,
          removalNotify,
          afterRemovalNotify,
          afterDestroyCardNotify,
          afterDestroyBannerNotify,
          readsBeforeDetach: initialChildReads,
          readsWhileDetached,
          readsAfterReinsert,
          readsAfterRemoval,
          child2Reads,
          readsAfterDestroy: readsFor('child-2'),
          card2StillInDom: Boolean(card2.isConnected),
        };
      } finally {
        window.fetch = previousFetch;
      }
    });
    assert.deepEqual(pageErrors, []);
    assert.ok(result.readsBeforeDetach >= 1, 'mounting the card reads child recovery state');
    assert.equal(result.detachedNotify, 1, 'a temporary detach keeps the listener registered');
    assert.equal(
      result.readsWhileDetached,
      result.readsBeforeDetach,
      'a detached host must not issue a recovery GET',
    );
    assert.equal(result.reinsertNotify, 1, 'a reinserted card is still registered');
    assert.equal(result.readsAfterReinsert, result.readsBeforeDetach + 1);
    assert.equal(result.removalNotify, 1, 'the removal notification still reaches the listener');
    assert.equal(result.readsAfterRemoval, result.readsAfterReinsert, 'a removed card does not fetch');
    assert.equal(result.afterRemovalNotify, 0, 'a permanently detached card unregisters');
    assert.equal(result.resetCardConnected, true);
    assert.equal(result.beforeEvictNotify, 1, 'a mounted card is registered');
    assert.equal(result.afterEvictNotify, 0, 'ledger eviction releases the card listener');
    assert.equal(result.beforeResetNotify, 1);
    assert.equal(result.afterResetNotify, 0, 'ledger reset releases the card listener');
    assert.equal(result.afterDestroyCardNotify, 0, 'destroy releases the delegation card registration');
    assert.equal(result.afterDestroyBannerNotify, 0, 'destroy releases the chat banner registration');
    assert.equal(result.readsAfterDestroy, result.child2Reads, 'no GET arrives after destroy');
    assert.equal(result.card2StillInDom, false);
  } finally {
    await close();
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
        const { type, body } = readServedModule(filePath);
        res.writeHead(200, {
          'Content-Type': type,
          'Access-Control-Allow-Origin': '*',
        });
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
