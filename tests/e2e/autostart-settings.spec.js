import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { pl } from '../../app_front/i18n/pl.js';
import { en } from '../../app_front/i18n/en.js';

for (const width of [1280, 390]) {
  for (const [lang, dictionary] of Object.entries({ pl, en })) {
    test(`autostart card states and confirmation: ${lang}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((language) => localStorage.setItem('cretli-lang', language), lang);
      const t = dictionary.settings;
      let state = {
        supported: true, installed: true, foreign: false, platform: 'systemd',
      };
      let activationCode = 'next_boot';
      let stopCommand;
      const posts = [];
      // Keep unrelated network diagnostics deterministic and free of host details.
      await page.route('**/api/net-env*', (route) => route.fulfill({ json: {
        ok: true, platform: 'linux', networkingMode: 'local', collectedAt: '2026-10-30T10:00:00Z',
        cretli: { bind: '127.0.0.1', lanHost: null }, helper: { state: 'unsupported' },
        issues: [], portproxy: [], listeners: [],
      } }));
      await page.route('**/api/port-exposures', (route) => route.fulfill({ json: { ok: true, exposures: [], history: [], foreign: [] } }));
      await page.route('**/api/port-exposures/policy', (route) => route.fulfill({ json: { ok: true, policy: { range: { min: 3000, max: 9999 }, denylist: [], defaultTtlMs: 3600000, maxTtlMs: 86400000, agentMode: 'ask', backend: 'auto' } } }));
      // Intercept every autostart request before login, including unexpected POSTs.
      await page.route('**/api/settings/autostart', async (route) => {
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          posts.push(body);
          state = { ...state, installed: body.enabled, activationCode, stopCommand };
        }
        await route.fulfill({ json: state });
      });
      await ensureAuthenticatedPage(page);
      const auth = await (await page.request.get('/api/auth-status')).json();
      const setup = await page.request.patch('/api/settings', {
        headers: { 'X-Cretli-Csrf': auth.csrfToken },
        data: { firstRunSetupDismissed: true, workspaceAddPath: process.cwd(), workspaceAddAs: 'folder' },
      });
      expect(setup.ok()).toBe(true);
      await page.goto('/settings/connection-network');
      const root = page.locator('.autostart-settings-root');
      const checkbox = root.getByRole('checkbox');
      const dialog = root.locator('cr-dialog');
      const status = root.getByRole('status');
      async function refresh() {
        const response = page.waitForResponse((r) => r.url().endsWith('/api/settings/autostart') && r.request().method() === 'GET');
        await root.getByRole('button', { name: t.autostartRefresh, exact: true }).click();
        await response;
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await expect(root.getByText(t.autostartInstalled, { exact: true })).toBeVisible();
      await expect(checkbox).toBeChecked();

      state = { ...state, installed: false };
      await refresh();
      await expect(root.getByText(t.autostartMissing, { exact: true })).toBeVisible();
      await expect(checkbox).not.toBeChecked();

      state = { ...state, supported: false };
      await refresh();
      await expect(root.getByText(t.autostartUnsupported, { exact: true })).toBeVisible();
      await expect(checkbox).toHaveCount(0);

      state = { ...state, supported: true, foreign: true };
      await refresh();
      await expect(root.getByText(t.autostartForeignHint, { exact: true })).toBeVisible();
      await expect(checkbox).toHaveCount(0);

      // Externally managed systemd service: read-only, three states.
      for (const [externalEnabled, key] of [[true, 'autostartSystemEnabled'], [false, 'autostartSystemDisabled'], [null, 'autostartSystemUnknown']]) {
        state = { ...state, foreign: false, managedExternally: true, externalEnabled };
        await refresh();
        await expect(root.getByText(t[key], { exact: true })).toBeVisible();
        await expect(root.getByText(t.autostartSystemHint, { exact: true })).toBeVisible();
        await expect(checkbox).toHaveCount(0);
      }

      state = { ...state, managedExternally: false, externalEnabled: undefined };
      await refresh();
      await expect(checkbox).toBeEnabled();
      for (const enabled of [true, false]) {
        await checkbox.click();
        await expect(dialog).toHaveAttribute('open', '');
        await expect(dialog.getByText(enabled ? t.autostartConfirmEnable : t.autostartConfirmDisable, { exact: true })).toBeVisible();
        const beforeCancel = posts.length;
        await dialog.getByRole('button', { name: t.autostartCancel, exact: true }).click();
        await expect(dialog).not.toHaveAttribute('open');
        await expect(checkbox).toBeChecked({ checked: !enabled });
        // A subsequent GET acts as a barrier after the cancel handler has completed.
        await refresh();
        expect(posts).toHaveLength(beforeCancel);
        await checkbox.click();
        await dialog.getByRole('button', { name: t.autostartConfirm, exact: true }).click();
        await expect(dialog).not.toHaveAttribute('open');
        expect(posts.at(-1)).toEqual({ enabled, confirm: true });
        expect(posts).toHaveLength(beforeCancel + 1);
        await expect(checkbox).toBeChecked({ checked: enabled });
        await expect(status).toHaveText(t.autostartNextBoot);
      }

      // Removal messages end with the literal stop command, including a long quoted request-stop line.
      for (const platform of ['systemd', 'wsl', 'termux']) {
        stopCommand = platform === 'systemd' ? 'systemctl --user stop cretli.service'
          : `'${'/srv/my-app/'.repeat(12)}node' '/srv/my app/scripts/cretli-supervisor.mjs' request-stop`;
        activationCode = `removed_${platform}`;
        state = { ...state, installed: true, platform };
        await refresh();
        await expect(checkbox).toBeChecked();
        await checkbox.click();
        await dialog.getByRole('button', { name: t.autostartConfirm, exact: true }).click();
        const prefix = { systemd: t.autostartRemovedSystemd, wsl: t.autostartRemovedWsl, termux: t.autostartRemovedTermux }[platform];
        await expect(status).toHaveText(`${prefix} ${stopCommand}`);
        expect(posts.at(-1)).toEqual({ enabled: false, confirm: true });
        if (platform !== 'systemd') expect(await status.textContent()).toContain('request-stop');
        expect(await status.textContent()).not.toContain('SIGTERM');
        // Hidden overflow must not make the command unreadable inside its card.
        expect(await status.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      expect(posts).toHaveLength(5);
    });
  }
}
