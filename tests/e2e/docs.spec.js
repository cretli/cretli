import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { ensureScopedRouteContext, buildScopedPanelPath, cretliCsrfHeaders } from './spa-route-helpers.js';

test.describe.configure({ mode: 'serial' });

for (const width of [1440, 375]) {
  test(`Docs tab, reload, wiki, search, save and disk conflict at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-docs-e2e-'));
    await fs.writeFile(path.join(root, 'start.md'), '# Start note\n\n[[next|Follow next]]');
    await fs.writeFile(path.join(root, 'next.md'), '# Next note\n\nSearchable text\n\n[Jump](#section)');
    let configUrl;
    let previousRoot;
    let previousConsent;
    try {
      await ensureAuthenticatedPage(page);
      const scope = await ensureScopedRouteContext(page.request);
      await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'chat'));
      const configRequest = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/docs/config');
      await page.locator('.tab[data-panel="docs"]').click();
      const initial = await configRequest;
      configUrl = initial.url();
      const initialConfig = await initial.json();
      previousRoot = initialConfig.root?.path || null;
      previousConsent = initialConfig.root?.external && initialConfig.root.consented ? initialConfig.agentRead : undefined;
      const headers = await cretliCsrfHeaders(page.request);
      const setRoot = await page.request.put(configUrl, { headers, data: { root } });
      expect(setRoot.ok()).toBeTruthy();
      const consentUrl = configUrl.replace('/config?', '/consent?');
      expect((await page.request.post(consentUrl, { headers, data: { agentRead: false } })).ok()).toBeTruthy();
      await page.reload();
      await expect(page).toHaveURL(/\/docs\?/);
      const panel = page.locator('cr-docs-panel');
      await expect(panel.locator('.docs-note-button').filter({ hasText: 'Start note' })).toBeVisible();
      await panel.locator('.docs-note-button').filter({ hasText: 'Start note' }).click();
      await panel.locator('.docs-wikilink').filter({ hasText: 'Follow next' }).click();
      await expect(panel.locator('.docs-note h2')).toHaveText('Next note');
      await expect(panel.locator('.docs-tree [aria-current="page"]')).toHaveText('Next note');
      await expect(panel.locator('[role="status"][aria-live="polite"]')).toHaveCount(1);
      await expect(panel.locator('.docs-markdown')).toContainText('Jump');
      await expect(panel.locator('.docs-markdown a[href^="#"]')).toHaveCount(0);
      await panel.locator('[data-docs-search] input').fill('Searchable');
      await panel.locator('[data-docs-search] input').press('Enter');
      await expect(panel.locator('.docs-tree .docs-note-button')).toHaveCount(1);
      await panel.locator('[data-docs-search] input').fill('');
      // These selectors use stable i18n text only for domain-independent toolbar actions.
      await panel.locator('.docs-note cr-bar-button').first().click();
      const editor = panel.locator('[data-docs-editor] textarea');
      await editor.fill('# Next note\n\nSaved in panel');
      await expect(panel.locator('header cr-bar-button').last()).toHaveAttribute('disabled');
      await panel.locator('.docs-tree .docs-note-button').filter({ hasText: 'Start note' }).click();
      await expect(panel.locator('cr-dialog[open]')).toBeVisible();
      await panel.locator('cr-dialog cr-bar-button').first().click();
      await expect(editor).toHaveValue('# Next note\n\nSaved in panel');
      await panel.locator('.docs-note cr-bar-button[variant="primary"]').click();
      await expect.poll(() => fs.readFile(path.join(root, 'next.md'), 'utf8')).toContain('Saved in panel');
      await expect(editor).toHaveCount(0);
      await panel.locator('.docs-note cr-bar-button').first().click();
      await editor.fill('# Next note\n\nMy retained draft');
      await fs.writeFile(path.join(root, 'next.md'), '# Next note\n\nChanged on disk');
      await panel.locator('.docs-note cr-bar-button[variant="primary"]').click();
      await expect(panel.locator('.docs-conflict')).toBeVisible();
      await expect(editor).toHaveValue(/My retained draft/);
      await panel.locator('.docs-conflict cr-bar-button').last().click();
      await expect(panel.locator('.docs-review')).toContainText('Changed on disk');
      await panel.locator('cr-dialog cr-bar-button[variant="primary"]').click();
      await expect.poll(() => fs.readFile(path.join(root, 'next.md'), 'utf8')).toContain('My retained draft');
      await expect(panel.locator('.docs-conflict')).toHaveCount(0);
      const dimensions = await panel.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
      expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
      if (width === 375) {
        const tree = panel.locator('.docs-tree > details');
        await tree.locator(':scope > summary').click();
        await expect(tree).not.toHaveAttribute('open');
      }
    } finally {
      if (configUrl) {
        const headers = await cretliCsrfHeaders(page.request);
        await page.request.put(configUrl, { headers, data: { root: previousRoot } });
        if (previousConsent !== undefined) {
          await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: previousConsent } });
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test('Workspace Docs settings separate panel consent and agent read; note dialogs create, rename and trash', async ({ page }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-docs-settings-e2e-'));
  let configUrl;
  let previousConfig;
  try {
    await ensureAuthenticatedPage(page);
    const scope = await ensureScopedRouteContext(page.request);
    const initialResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/docs/config');
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'settings', 'workspace'));
    const response = await initialResponse;
    configUrl = response.url(); previousConfig = await response.json();
    const settings = page.locator('cr-docs-settings');
    await settings.locator('cr-bar-input input').fill(root);
    await settings.locator('.docs-toolbar').first().locator('cr-bar-button').first().click();
    await expect(settings.locator('cr-checkbox')).toBeVisible();
    await expect(settings.locator('cr-checkbox input')).not.toBeChecked();
    const grant = settings.locator('.docs-toolbar').nth(1).locator('cr-bar-button').first();
    const consent = async () => {
      await grant.click();
      await expect(settings.locator('cr-dialog[open]')).toContainText(root);
      await settings.locator('cr-dialog cr-bar-button[variant="primary"]').click();
      await expect(settings.locator('cr-dialog')).not.toHaveAttribute('open');
    };
    await consent();
    let config = await (await page.request.get(configUrl)).json();
    expect(config.root.consented).toBe(true); expect(config.agentRead).toBe(false);
    await settings.locator('cr-checkbox input').check();
    await consent();
    config = await (await page.request.get(configUrl)).json();
    expect(config.agentRead).toBe(true);
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'docs'));
    const panel = page.locator('cr-docs-panel');
    const create = panel.locator('header cr-bar-button').last();
    await expect(create).not.toHaveAttribute('disabled');
    await create.click();
    await panel.locator('[data-docs-name] input').fill('  created.md  ');
    await panel.locator('cr-dialog cr-bar-button[variant="primary"]').click();
    await expect(panel.locator('.docs-note h2')).toHaveText('created');
    await panel.locator('.docs-note .docs-toolbar cr-bar-button').nth(1).click();
    await panel.locator('[data-docs-name] input').fill('  renamed.md  ');
    await panel.locator('cr-dialog cr-bar-button[variant="primary"]').click();
    await expect(panel.locator('.docs-note .cr-hint')).toHaveText('renamed.md');
    expect(await fs.readFile(path.join(root, 'renamed.md'), 'utf8')).toBe('');
    await panel.locator('.docs-note .docs-toolbar cr-bar-button').nth(2).click();
    await panel.locator('cr-dialog cr-bar-button[variant="primary"]').click();
    await expect(panel.locator('.docs-note h2')).toHaveCount(0);
    await expect.poll(() => fs.readdir(path.join(root, '.cretli-trash'))).not.toHaveLength(0);
  } finally {
    if (configUrl && previousConfig) {
      const headers = await cretliCsrfHeaders(page.request);
      await page.request.put(configUrl, { headers, data: { root: previousConfig.root?.path || null } });
      if (previousConfig.root?.external && previousConfig.root.consented) {
        await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: previousConfig.agentRead } });
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Docs links from Todo and Initiative views and @doc composer pointer', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cretli-lang', 'en'));
  const { ensureMockNewChatEnvironment } = await import('./chat-e2e-helpers.js');
  await ensureMockNewChatEnvironment(page);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-docs-links-e2e-'));
  await fs.writeFile(path.join(root, 'design.md'), '# Linked design\nSECRET NOTE BODY');
  let configUrl; let previous; let todoId; let initiativeId; let query;
  const headers = await cretliCsrfHeaders(page.request);
  expect((await page.request.patch('/api/settings', { headers, data: { workspaceAddPath: root, workspaceAddAs: 'folder' } })).ok()).toBeTruthy();
  const workspaces = await (await page.request.get('/api/workspaces?refresh=1')).json();
  const workspace = workspaces.workspaces.find((row) => row.folders?.some((folder) => folder.resolvedPath === root));
  expect(workspace).toBeTruthy();
  const folder = workspace.folders.find((row) => row.resolvedPath === root);
  const scope = { workspaceKey: workspace.workspaceKey, folderKey: folder.folderKey };
  try {
    const configResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/docs/config' && new URL(res.url()).searchParams.get('workspaceFolder') === root);
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'docs'));
    const response = await configResponse;
    configUrl = response.url(); previous = await response.json();
    query = new URL(configUrl).search;
    expect((await page.request.put(configUrl, { headers, data: { root } })).ok()).toBeTruthy();
    expect((await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: true } })).ok()).toBeTruthy();
    const todoResponse = await page.request.post(`/api/todos${query}`, { headers, data: { title: 'Docs linked todo', status: 'idea' } });
    expect(todoResponse.ok()).toBeTruthy(); todoId = (await todoResponse.json()).item.id;
    const initiativeResponse = await page.request.post(`/api/initiatives${query}`, {
      headers: { ...headers, 'Idempotency-Key': `docs-e2e-${Date.now()}` },
      data: { initiative: { title: 'Docs linked initiative', desiredOutcome: 'Verify linked notes' } },
    });
    expect(initiativeResponse.ok()).toBeTruthy(); initiativeId = (await initiativeResponse.json()).initiative.id;
    const linkFrom = async (section) => {
      await section.locator('[data-doc-link]').click();
      const picker = section.locator('cr-doc-picker');
      await expect(picker.locator('cr-dialog[open]')).toBeVisible();
      await picker.getByRole('button', { name: 'Linked design', exact: true }).click();
      await expect(section.locator('li')).toContainText('design.md');
      const links = await (await page.request.get(`/api/docs/links${query}&target=${await section.getAttribute('kind')}:${await section.evaluate((el) => el.targetId)}`)).json();
      expect(links.items.some((link) => link.note === 'design.md')).toBe(true);
    };
    await page.locator('.tab[data-panel="todo"]').click();
    await page.locator(`.todo-row[data-id="${todoId}"] .todo-row-title`).click();
    const card = page.locator('cr-todo-card').filter({ has: page.locator('cr-doc-links') }).first();
    await card.locator('[role="tab"][data-tab="notes"]').click();
    const todoDocs = card.locator('cr-doc-links');
    await todoDocs.locator('[data-doc-link]').click();
    await expect(todoDocs.locator('cr-doc-picker cr-dialog[open]')).toBeVisible();
    await todoDocs.locator('cr-doc-picker cr-bar-input input').focus();
    await page.keyboard.press('Escape');
    await expect(todoDocs.locator('cr-doc-picker cr-dialog')).not.toHaveAttribute('open');
    await expect(page.locator('.todo-editor-dialog')).toHaveAttribute('open');
    await linkFrom(todoDocs);
    await todoDocs.locator('[data-doc-unlink]').click();
    await expect(todoDocs.locator('li')).toHaveCount(0);
    await linkFrom(todoDocs);
    await todoDocs.locator('[data-doc-open]').click();
    await expect(page).toHaveURL(/\/docs\?/);
    await expect(page.locator('cr-docs-panel .docs-note h2')).toHaveText('Linked design');
    await page.locator('.tab[data-panel="plans"]').click();
    const initiatives = page.locator('cr-initiatives-panel');
    await initiatives.locator(`[data-open="${initiativeId}"]`).click();
    const initiativeDocs = initiatives.locator('cr-doc-links');
    await linkFrom(initiativeDocs);
    await initiativeDocs.locator('[data-doc-unlink]').click();
    await expect(initiativeDocs.locator('li')).toHaveCount(0);

    const chatResponse = await page.request.post('/api/chats', {
      headers, data: { ...Object.fromEntries(new URLSearchParams(query)), agentTransport: 'opencode', title: 'Docs mention test' },
    });
    expect(chatResponse.ok()).toBeTruthy();
    const chatData = await chatResponse.json();
    const chatId = chatData.chat?.id || chatData.id;
    expect(chatId).toBeTruthy();
    const chatUrl = new URL(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'chat'), page.url());
    chatUrl.searchParams.set('chat', chatId);
    await page.goto(chatUrl.href);
    const composer = page.locator('.chat-tab-pane.active .send-keys-input').first();
    await composer.fill('@doc design');
    const picker = page.locator('body > cr-doc-picker');
    await expect(picker.locator('cr-dialog[open]')).toBeVisible();
    const choice = picker.getByRole('button', { name: 'Linked design', exact: true });
    await choice.focus(); await page.keyboard.press('Enter');
    await expect(composer).toHaveValue('cretli-ref doc=design.md');
    expect(await composer.inputValue()).not.toContain('SECRET NOTE BODY');
  } finally {
    if (todoId) await page.request.delete(`/api/todos/${todoId}${query}`, { headers });
    if (initiativeId) await page.request.post(`/api/initiatives/${initiativeId}/archive${query}`, { headers, data: {} });
    if (configUrl) {
      await page.request.put(configUrl, { headers, data: { root: previous.root?.path || null } });
      if (previous.root?.external && previous.root.consented) await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: previous.agentRead } });
    }
    await page.request.patch('/api/settings', { headers, data: { workspaceRemoveId: workspace.id } });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Docs proposals: MCP creates, human approves or rejects in the panel', async ({ page, baseURL }) => {
  // This test may mint credentials only for the disposable E2E server, never an external instance.
  test.skip(!!process.env.CHAT_E2E_BASE_URL, 'Requires the isolated E2E server and its test token issuer');
  const { execFileSync } = await import('node:child_process');
  const { projectRoot } = await import('./spa-route-helpers.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cretli-docs-proposals-e2e-'));
  await fs.writeFile(path.join(root, 'proposal.md'), '# Before proposal\n');
  let configUrl; let previous;
  try {
    await ensureAuthenticatedPage(page);
    const setup = await page.request.patch('/api/settings', { headers: await cretliCsrfHeaders(page.request), data: { firstRunSetupDismissed: true } });
    expect(setup.ok()).toBeTruthy();
    const scope = await ensureScopedRouteContext(page.request);
    await page.goto(buildScopedPanelPath(scope.workspaceKey, scope.folderKey, 'chat'));
    const initial = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/docs/config');
    await page.locator('.tab[data-panel="docs"]').click();
    const response = await initial; configUrl = response.url(); previous = await response.json();
    const headers = await cretliCsrfHeaders(page.request);
    expect((await page.request.put(configUrl, { headers, data: { root } })).ok()).toBeTruthy();
    expect((await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: true } })).ok()).toBeTruthy();
    const query = Object.fromEntries(new URL(configUrl).searchParams);
    const dataDir = process.env.CHAT_E2E_DATA_DIR || path.join(projectRoot, '.tmp/e2e-data');
    if (path.resolve(dataDir) === path.join(projectRoot, 'data')) throw new Error('E2E must use disposable data');
    const issue = `import { mintMcpIntegrationToken } from './lib/mcp/mcp-integration-token.js';
      process.stdout.write(mintMcpIntegrationToken(JSON.parse(process.argv[1])));`;
    const token = execFileSync(process.execPath, ['--input-type=module', '-e', issue, JSON.stringify({ ...query,
      sessionId: 'docs-proposal-e2e', chatId: 'docs-proposal-e2e', harness: 'test', incarnation: 'docs-proposal-e2e' })], {
      cwd: projectRoot, env: { ...process.env, CRETLI_DATA_DIR: dataDir, CURSOR_REMOTE_DATA_DIR: dataDir }, encoding: 'utf8',
    });
    const propose = async (text) => {
      const result = await page.request.post(`${baseURL}/api/docs/proposals/write`, {
        headers: { authorization: `Bearer ${token}` }, data: { path: 'proposal.md', text },
      });
      expect(result.ok(), `Proposal HTTP ${result.status()}: ${await result.text()}`).toBeTruthy();
      return (await result.json()).decision;
    };
    const applied = await propose('# Approved proposal\n');
    expect(await fs.readFile(path.join(root, 'proposal.md'), 'utf8')).toBe('# Before proposal\n');
    await page.reload();
    const proposals = page.locator('cr-doc-proposals');
    await proposals.locator(':scope > details > summary').click();
    const approvedCard = proposals.locator(`[data-proposal-id="${applied.id}"]`);
    await expect(approvedCard.locator('pre').first()).toContainText('+# Approved proposal');
    await approvedCard.locator('[data-proposal-apply]').click();
    await expect.poll(() => fs.readFile(path.join(root, 'proposal.md'), 'utf8')).toBe('# Approved proposal\n');
    const rejected = await propose('# Rejected proposal\n');
    await page.reload();
    await page.locator('cr-doc-proposals').locator(':scope > details > summary').click();
    const rejectedCard = page.locator('cr-doc-proposals').locator(`[data-proposal-id="${rejected.id}"]`);
    const rejection = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/decisions/${rejected.id}` && r.request().method() === 'POST');
    await rejectedCard.locator('[data-proposal-reject]').click(); expect((await rejection).ok()).toBeTruthy();
    expect(await fs.readFile(path.join(root, 'proposal.md'), 'utf8')).toBe('# Approved proposal\n');
  } finally {
    if (configUrl) {
      const headers = await cretliCsrfHeaders(page.request);
      await page.request.put(configUrl, { headers, data: { root: previous.root?.path || null } });
      if (previous.root?.external && previous.root.consented) await page.request.post(configUrl.replace('/config?', '/consent?'), { headers, data: { agentRead: previous.agentRead } });
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
