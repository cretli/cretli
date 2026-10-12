import { test, expect } from '@playwright/test';

test('unknown git sub-view returns HTTP 404', async ({ request }) => {
  for (const pathname of ['/git/nope', '/git/worktrees/deep']) {
    const res = await request.get(pathname);
    expect(res.status(), pathname).toBe(404);
  }
});

test('allowed git worktrees path returns SPA shell', async ({ request }) => {
  const res = await request.get('/git/worktrees');
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/cretli|app\.bundle|index/i);
});

test('signed-out deep link redirects to login with allowlisted next', async ({ playwright }) => {
  const baseURL = process.env.CHAT_E2E_BASE_URL || 'http://127.0.0.1:3311';
  const anon = await playwright.request.newContext({ baseURL });
  try {
    const res = await anon.get('/git/worktrees?ws=cretli:ws:test&folder=f1', { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const location = res.headers().location || '';
    expect(location).toMatch(/\/login\?next=/);
    expect(decodeURIComponent(location)).toContain('/git/worktrees');
    const unknown = await anon.get('/git/nope');
    expect(unknown.status()).toBe(404);
  } finally {
    await anon.dispose();
  }
});

test('embed route is not treated as a main-shell chat rewrite target', async ({ request }) => {
  const res = await request.get('/embed/e2e-nonexistent-installation', { maxRedirects: 0 });
  expect([404, 200]).toContain(res.status());
  const location = res.headers().location || '';
  expect(location).not.toMatch(/^\/chat/);
});
