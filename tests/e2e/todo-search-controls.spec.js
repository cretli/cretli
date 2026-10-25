import fs from 'node:fs';
import { test, expect } from '@playwright/test';

const panelSource = fs.readFileSync(new URL('../../app_front/features/todo/views/todoPanel.js', import.meta.url), 'utf8');
const searchStart = panelSource.indexOf('function ensureTodoSearchUi(');
const searchSource = panelSource.slice(searchStart, panelSource.indexOf('\n/**', searchStart));

for (const width of [390, 1440]) {
  for (const theme of ['dark', 'light']) {
    test(`TODO search controls at ${width}px in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/login');
      await page.addStyleTag({ url: '/dist/app/index.css' });
      await page.evaluate(async ({ source, theme }) => {
        await Promise.all(['cr-bar-input', 'cr-icon-button', 'cr-checkbox'].map((tag) => customElements.whenDefined(tag)));
        document.body.classList.toggle('theme-light', theme === 'light');
        document.body.innerHTML = '<section id="todo-panel"><div class="todo-toolbar panel-toolbar"><span id="anchor"></span></div></section>';
        const labels = {
          'todo.search': 'Search', 'todo.searchPlaceholder': 'Search by title or ID',
          'todo.searchClear': 'Clear search', 'todo.searchUseFilters': 'Use list filters',
        };
        // Exercise the actual panel wiring with the real Lit primitives and stylesheet.
        window.searchState = new Function('t', `
          let todoSearchQuery = '';
          let todoSearchUseFilters = false;
          const latestItems = [{}];
          const listEl = null;
          const renderList = () => {};
          const scheduleTodoViewMemoryCapture = () => {};
          ${source}
          ensureTodoSearchUi(document.querySelector('.todo-toolbar'), document.querySelector('#anchor'));
          return () => ({ query: todoSearchQuery, useFilters: todoSearchUseFilters });
        `)((key) => labels[key] || key);
      }, { source: searchSource, theme });
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const search = page.locator('.todo-search');
      const input = search.getByRole('textbox', { name: 'Search', exact: true });
      await expect(input).toBeFocused();
      const toolbarBox = await page.locator('.todo-toolbar').boundingBox();
      const searchBox = await search.boundingBox();
      expect(searchBox.x).toEqual(toolbarBox.x);
      expect(searchBox.width).toEqual(toolbarBox.width);
      expect(await search.evaluate((el) => getComputedStyle(el).borderRadius)).toEqual('0px');
      await input.fill('Be9');
      await expect.poll(() => page.evaluate(() => window.searchState())).toEqual({ query: 'Be9', useFilters: false });
      const clear = search.getByRole('button', { name: 'Clear search' });
      await expect(clear).toBeVisible();
      const inputBox = await input.boundingBox();
      const clearBox = await clear.boundingBox();
      expect(clearBox.x).toBeGreaterThanOrEqual(inputBox.x);
      expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width);
      expect(await search.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const toggle = search.getByRole('checkbox', { name: 'Use list filters' });
      await toggle.check();
      await expect.poll(() => page.evaluate(() => window.searchState())).toEqual({ query: 'Be9', useFilters: true });
      await clear.click();
      await expect(input).toHaveValue('');
      await expect(input).toBeFocused();
      await expect(clear).toBeHidden();
      await expect(toggle).toBeChecked();
      await input.fill('second');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(search).toBeHidden();
      expect(await page.evaluate(() => window.searchState())).toEqual({ query: '', useFilters: true });
    });
  }
}
