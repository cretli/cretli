import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage, ensureSidebarOpen } from '../e2e/chat-e2e-helpers.js';
import { ensureScopedRouteContext, buildScopedPanelPath } from '../e2e/spa-route-helpers.js';

for (const mobile of [false, true]) {
  test(`Settings tree toggles without navigation and keeps nested guides (${mobile ? 'touch' : 'desktop'})`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    try {
      await ensureAuthenticatedPage(page);
      const scope = await ensureScopedRouteContext(page.request);
      await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings', 'harness-codex-models'));
      await expect(page.locator('#settings-panel.active')).toBeVisible();
      if (mobile) await page.locator('#header-menu-btn').click();
      else expect(await ensureSidebarOpen(page)).toBe(true);
      const nav = page.locator('#sidebar-settings-tree');
      await expect(nav).toBeVisible();
      const root = nav.locator('[data-settings-node="harness"]');
      // Provider pages are listed once and follow the harness in the content picker.
      const current = nav.locator('[data-settings-node="harness-provider-models"]');
      const provider = nav.locator('[data-settings-node="harness-overview"]');
      const leaf = nav.locator('[data-settings-node="harness-overview-plugins"]');
      await expect(root).toHaveAttribute('aria-expanded', 'true');
      await expect(current).toHaveAttribute('aria-current', 'page');
      await expect(current).toHaveAttribute('data-settings-tab', 'harness-codex-models');
      await expect(nav.locator('[data-settings-node="harness-codex"]')).toHaveCount(0);
      await expect(provider).toHaveAttribute('aria-expanded', 'false');
      await provider.click();
      await expect(provider).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('.settings-heading')).toHaveCount(0);
      await expect(page.locator('#header-settings-title')).toBeVisible();
      const interfaceGroup = nav.locator('[data-settings-node="interface"]');
      const beforeGroup = page.url();
      await interfaceGroup.click();
      await expect(interfaceGroup).toHaveAttribute('aria-expanded', 'true');
      expect(page.url()).toBe(beforeGroup);
      await interfaceGroup.click();
      await expect(interfaceGroup).toHaveAttribute('aria-expanded', 'false');
      const url = page.url();
      // Click the label, away from the chevron: this must never navigate.
      await provider.locator('.sidebar-workspace-title').click();
      await expect(provider).toHaveAttribute('aria-expanded', 'false');
      await expect(leaf).toHaveCount(0);
      expect(page.url()).toBe(url);
      await provider.press('Enter');
      await expect(provider).toHaveAttribute('aria-expanded', 'true');
      await expect(leaf).toBeVisible();
      await provider.press('ArrowLeft');
      await expect(provider).toHaveAttribute('aria-expanded', 'false');
      await provider.press('ArrowRight');
      await expect(leaf).toBeVisible();
      await root.locator('.sidebar-workspace-title').click();
      await expect(root).toHaveAttribute('aria-expanded', 'false');
      expect(page.url()).toBe(url);
      await root.press('Space');
      await expect(leaf).toBeVisible();
      const layout = await nav.evaluate(tree => {
        const row = tree.querySelector('[data-settings-node="harness"]');
        const child = tree.querySelector('[data-settings-node="harness-overview-plugins"]');
        const last = tree.querySelector('#settings-children-harness-overview > li:last-child');
        const group = row.closest('.sidebar-settings-group').querySelector('.sidebar-settings-group-header');
        const parent = tree.querySelector('[data-settings-node="harness-overview"] .sidebar-chat-item-harness');
        return {
          padding: parseFloat(getComputedStyle(tree).paddingLeft),
          rowInset: group.getBoundingClientRect().left - tree.getBoundingClientRect().left,
          childOffset: child.querySelector(".sidebar-chat-item-harness").getBoundingClientRect().left - parent.getBoundingClientRect().left,
          height: row.getBoundingClientRect().height,
          position: getComputedStyle(row).position,
          nested: child.closest('ul').parentElement.closest('ul').id,
          guideHeight: parseFloat(getComputedStyle(last, '::before').height),
          lastHeight: last.querySelector('button').getBoundingClientRect().height,
          guideColor: getComputedStyle(last, '::before').borderLeftColor,
        };
      });
      expect(layout.padding).toBeGreaterThan(0);
      expect(layout.rowInset).toBeCloseTo(layout.padding, 1);
      expect(layout.position).toBe('relative');
      // A child's icon starts at or past its parent's icon, never under its chevron.
      expect(layout.childOffset).toBeGreaterThanOrEqual(0);
      expect(layout.nested).toBe('settings-children-harness');
      expect(layout.guideHeight).toBeCloseTo(layout.lastHeight / 2, 0);
      // Rows share the chat list row height on every pointer type.
      expect(layout.height).toBeCloseTo(layout.lastHeight, 0);
      await page.locator('#app-sidebar').screenshot({ path: testInfo.outputPath('settings-tree.png') });
      await nav.locator('[data-settings-node="harness-provider-keys"]').click();
      await expect(page.locator('#settings-panel')).toHaveAttribute('data-active-settings-tab', 'harness-codex-keys');
      await expect(page.locator('#header-menu-btn')).toHaveAttribute('aria-label', /Back to settings|Wróć do ustawień/);
      await page.locator('#header-menu-btn').click();
      await expect(page.locator('#settings-panel')).toHaveAttribute('data-settings-view', 'list');
      await expect(page.locator('body')).toHaveAttribute('data-sidebar-mode', 'settings');
      await expect(nav).toBeVisible();
      await expect(page.locator('#settings-panel.active')).toBeAttached();
      if (mobile) await page.locator('#sidebar-close-btn').click();
      await page.locator('#header-menu-btn').click();
      await expect(page.locator('body')).toHaveAttribute('data-sidebar-mode', 'settings');

      await testInfo.attach('layout', { body: JSON.stringify(layout), contentType: 'application/json' });
    } finally {
      await context.close();
    }
  });
}

test('Settings tree starts collapsed when opened without a tab', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await ensureAuthenticatedPage(page);
    const scope = await ensureScopedRouteContext(page.request);
    // Expand a branch in an earlier visit; a fresh visit must not restore it.
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings', 'harness-codex-models'));
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings'));
    await expect(page.locator('#settings-panel.active')).toBeVisible();
    expect(await ensureSidebarOpen(page)).toBe(true);
    const nav = page.locator('#sidebar-settings-tree');
    await expect(nav.locator('[data-settings-node="harness"]')).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.locator('[aria-expanded="true"]')).toHaveCount(0);
    // The menu button turns into a gear; the close button next to it leaves settings.
    await expect(page.locator('#header-menu-btn .mdi')).toHaveClass(/mdi-cog/);
    const exit = page.locator('#header-settings-exit-btn');
    await expect(exit).toBeVisible();
    await exit.click();
    await expect(page.locator('body')).toHaveAttribute('data-sidebar-mode', 'chats');
    await expect(page.locator('#settings-panel.active')).toHaveCount(0);
    await expect(exit).toBeHidden();
    await expect(page.locator('#header-menu-btn .mdi')).toHaveClass(/mdi-menu/);
  } finally {
    await context.close();
  }
});

test('Harness picker switches provider pages and the sidebar follows', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await ensureAuthenticatedPage(page);
    const scope = await ensureScopedRouteContext(page.request);
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings', 'harness-codex-models'));
    await expect(page.locator('#settings-panel.active')).toBeVisible();
    expect(await ensureSidebarOpen(page)).toBe(true);
    const picker = page.locator('#settings-harness-picker');
    await expect(picker).toBeVisible();
    await expect.poll(() => picker.evaluate(el => /** @type {any} */ (el).value)).toBe('codex');
    await picker.getByRole('option', { name: 'Claude' }).click();
    // Same page (Models), other harness.
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-active-settings-tab', 'harness-claude-models');
    const nav = page.locator('#sidebar-settings-tree');
    await expect(nav.locator('[data-settings-node="harness-provider-models"]')).toHaveAttribute('data-settings-tab', 'harness-claude-models');
    await expect(nav.locator('[data-settings-node="harness-provider-keys"]')).toHaveAttribute('data-settings-tab', 'harness-claude-keys');
    await page.screenshot({ path: test.info().outputPath('harness-picker.png') });
    // Pages outside the provider set hide the picker.
    await nav.locator('[data-settings-node="harness-overview"]').click();
    await nav.locator('[data-settings-node="harness-overview-plugins"]').click();
    await expect(page.locator('#settings-panel')).toHaveAttribute('data-active-settings-tab', 'harness-overview-plugins');
    await expect(picker).toBeHidden();
  } finally {
    await context.close();
  }
});
