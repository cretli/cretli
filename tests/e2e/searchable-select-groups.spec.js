import { test, expect } from '@playwright/test';

test('searchable select: grouped search, disabled choices and keyboard selection', async ({ page }) => {
  // The small login entry imports the shared UI barrel without loading chat history.
  await page.goto('/login');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ url: '/dist/app/index.css' });
  await page.evaluate(async () => {
    await customElements.whenDefined('cr-searchable-select');
    const picker = document.createElement('cr-searchable-select');
    picker.id = 'grouped-picker';
    picker.style.width = '300px';
    picker.searchThreshold = 0;
    picker.favoritesEnabled = true;
    picker.favoritesFilterEnabled = true;
    picker.availableFilterEnabled = true;
    picker.options = [
      { value: 'blocked', label: 'Model A', group: 'Alpha', disabled: true, status: 'Unavailable', description: 'Usage limit reached. Choose another model or harness. ' + 'long-message'.repeat(30) },
      { value: 'ready', label: 'Model B', group: 'Beta', status: 'Available' },
    ];
    document.body.replaceChildren(picker);
    await picker.updateComplete;
    // The new-chat modal moves to body after its Lit controls have already mounted.
    const modal = document.createElement('div');
    document.body.appendChild(modal);
    modal.appendChild(picker);
    await picker.updateComplete;
    window.selectedChoice = '';
    picker.addEventListener('cr-change', (event) => { window.selectedChoice = event.detail.value; });
    picker.addEventListener('cr-favorite-toggle', (event) => {
      picker.options = picker.options.map((row) => row.value === event.detail.value
        ? { ...row, favorite: !row.favorite } : row);
    });
  });
  const picker = page.locator('#grouped-picker');
  await picker.locator('button').click();
  const panel = page.locator('.cr-searchable-select-modal:not([hidden])');
  await expect(panel).toBeVisible({ timeout: 3000 });
  const inputBounds = await panel.locator('input').boundingBox();
  const filterBounds = await panel.locator('[data-filter="all"]').boundingBox();
  expect(Math.abs(inputBounds.height - filterBounds.height)).toBeLessThanOrEqual(1);
  await expect.poll(async () => {
    const triggerBounds = await picker.locator('button').boundingBox();
    const panelBounds = await panel.boundingBox();
    return Math.abs(panelBounds.width - triggerBounds.width);
  }).toBeLessThanOrEqual(1);
  expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(panel.locator('.cr-searchable-select-group')).toHaveText(['Alpha', 'Beta']);
  const blocked = panel.getByRole('option', { name: /Alpha · Model A/ });
  await expect(blocked).toHaveAttribute('aria-disabled', 'true');
  await blocked.click({ force: true });
  expect(await page.evaluate(() => window.selectedChoice)).toBe('');
  await expect(panel).toBeVisible();
  const availableFilter = panel.getByRole('button', { name: 'Available models', exact: true });
  const favoritesFilter = panel.getByRole('button', { name: 'Favorites', exact: true });
  const allFilter = panel.getByRole('button', { name: 'All models', exact: true });
  await availableFilter.click();
  await expect(availableFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('option')).toHaveCount(1);
  await expect(panel.getByRole('option')).toHaveAttribute('data-value', 'ready');
  await favoritesFilter.click();
  await expect(panel.getByRole('option')).toHaveCount(0);
  await expect(availableFilter).toHaveAttribute('aria-pressed', 'true');
  await expect(favoritesFilter).toHaveAttribute('aria-pressed', 'true');
  await allFilter.click();
  await expect(panel.getByRole('option')).toHaveCount(2);
  await expect(availableFilter).toHaveAttribute('aria-pressed', 'false');
  await expect(favoritesFilter).toHaveAttribute('aria-pressed', 'false');
  await panel.locator('input').fill('beta');
  await expect(panel.getByRole('option')).toHaveCount(1);
  const star = panel.getByRole('button', { name: /Add to favorites: Beta/ });
  await star.click();
  await expect(panel.getByRole('button', { name: /Remove from favorites: Beta/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('input')).toHaveValue('beta');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => window.selectedChoice)).toBe('');
  await expect(panel.getByRole('button', { name: /Remove from favorites: Beta/ })).toBeFocused();
  await panel.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(panel.locator('input')).toHaveValue('beta');
  await panel.locator('input').fill('');
  await expect(panel.getByRole('option')).toHaveCount(1);
  await expect(panel.getByRole('option')).toHaveAttribute('data-value', 'ready');
  await availableFilter.click();
  await expect(panel.getByRole('option')).toHaveCount(1);
  await expect(favoritesFilter).toHaveAttribute('aria-pressed', 'true');
  await panel.getByRole('button', { name: 'All models', exact: true }).click();
  await expect(panel.getByRole('option')).toHaveCount(2);
  await panel.locator('input').fill('beta');
  await panel.getByRole('button', { name: /Remove from favorites: Beta/ }).press('Enter');
  await expect(panel.getByRole('button', { name: /Add to favorites: Beta/ })).toHaveAttribute('aria-pressed', 'false');
  await panel.locator('input').press('Enter');
  await expect(panel).toBeHidden();
  await expect(picker).toHaveAttribute('value', 'ready');
  expect(await page.evaluate(() => window.selectedChoice)).toBe('ready');
  await picker.locator('button').click();
  await expect(panel.locator('input')).toBeFocused();
  await panel.locator('input').press('ArrowDown');
  await expect(panel.getByRole('option', { name: /Beta · Model B/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});
