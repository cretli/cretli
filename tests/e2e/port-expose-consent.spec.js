import { test, expect } from '@playwright/test';
import {
  createChatViaApi,
  deleteChatViaApi,
  ensureMockNewChatEnvironment,
  selectChatInSidebar,
} from './chat-e2e-helpers.js';

// Fake backend: the consent routes are answered from this in-memory state, so the test needs no
// real agent, port or Windows host. It models what the server does for one agent call.
function createFakeConsentBackend(chatId) {
  const s = { cards: [{ id: 'pe-1', chatId, port: 5173, ttlMs: 3_600_000, reason: 'Phone test', createdAt: Date.now(), expiresAt: Date.now() + 600_000 }], exposed: null, refusal: null };
  return {
    s,
    async install(page) {
      const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route('**/api/port-exposures/consent?*', (route) => json(route, { ok: true, prompts: s.cards }));
      await page.route('**/api/port-exposures/consent/pe-1', (route) => {
        const body = route.request().postDataJSON();
        s.cards = [];
        if (body.decision === 'once') s.exposed = { port: 5173, owner: `chat:${chatId}`, state: 'active' };
        else s.refusal = 'expose-denied-user';
        return json(route, { ok: true, port: 5173 });
      });
    },
  };
}

test.describe.configure({ mode: 'serial' });

for (const decision of ['once', 'deny']) {
  test(`port expose consent card: ${decision}`, async ({ page, request }) => {
    await ensureMockNewChatEnvironment(page);
    const chat = await createChatViaApi(request, { title: `Expose consent ${decision}`, transport: 'sdk', workspaceFolder: process.cwd() });
    const fake = createFakeConsentBackend(chat.id);
    await fake.install(page);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await selectChatInSidebar(page, chat.id);
      const card = page.locator('.chat-tab-pane.active cr-expose-consent [data-port-expose-consent]');
      await expect(card).toBeVisible();
      await expect(card).toContainText('5173');
      await expect(card).toContainText('Phone test');

      // The server owns the card: a page reload restores it.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await selectChatInSidebar(page, chat.id);
      await expect(card).toBeVisible();

      const label = decision === 'once' ? /^(Allow once|Zezwól jednorazowo)$/ : /^(Deny|Odmów)$/;
      await card.getByRole('button', { name: label }).click();
      await expect(card).toHaveCount(0);
      if (decision === 'once') expect(fake.s.exposed).toMatchObject({ port: 5173, owner: `chat:${chat.id}` });
      else expect(fake.s.refusal).toBe('expose-denied-user');
    } finally {
      await deleteChatViaApi(request, chat.id);
    }
  });
}
