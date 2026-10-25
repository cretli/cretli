import { test, expect } from '@playwright/test';
import { ensureAuthenticatedPage } from './chat-e2e-helpers.js';
import { buildTodoTimeline } from '../../lib/todo-timeline.js';

const todoId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const item = { id: todoId, title: 'Timeline example', status: 'ready', createdAt: '2026-01-01T10:00:00Z' };
const entries = buildTodoTimeline(item, [{
  id: 'review', leafId: todoId, attemptId: 'attempt', childChatId: childId,
  workRole: 'review_plan', planReviewerSessionId: 'round-1',
  executor: { transport: 'codex', model: 'model-a' },
  queuedAt: '2026-01-01T10:01:00Z', startedAt: '2026-01-01T10:02:00Z', finishedAt: '2026-01-01T10:03:00Z',
  status: 'completed', reportVerdict: 'PASS', verifyResult: { recordedAt: '2026-01-01T10:04:00Z', status: 'passed' },
}]);

for (const width of [390, 1440]) {
  test(`TODO History lazily loads the timeline, counts events and links chats at ${width}px`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cretli-lang', 'en'));
    await page.setViewportSize({ width, height: 844 });
    let historyRequests = 0;
    await page.route(/\/api\/todos\/[^/]+\/history(?:\?.*)?$/, (route) => {
      historyRequests += 1;
      const cwd = new URL(route.request().url()).searchParams.get('workspaceFolder');
      return route.fulfill({ json: { ok: true, todoId, cwd, entries } });
    });
    await ensureAuthenticatedPage(page);
    await page.evaluate(async (item) => {
      await customElements.whenDefined('cr-todo-card');
      const style = document.createElement('style');
      style.textContent = 'body > :not(#timeline-fixture) { display:none!important } #timeline-fixture { padding:8px; }';
      document.head.appendChild(style);
      const fixture = document.createElement('div');
      fixture.id = 'timeline-fixture';
      const card = document.createElement('cr-todo-card');
      card.item = item;
      fixture.appendChild(card);
      document.body.appendChild(fixture);
      window.openedTimelineChat = null;
      card.addEventListener('todo-open-chat', (event) => { window.openedTimelineChat = event.detail; });
      await card.updateComplete;
    }, item);
    const card = page.locator('#timeline-fixture cr-todo-card');
    expect(historyRequests).toEqual(0);
    await card.getByRole('tab', { name: 'History', exact: true }).click();
    const timeline = card.locator('cr-todo-history');
    await expect(timeline.locator('li')).toHaveCount(entries.length);
    await expect(card.getByRole('tab', { name: `History (${entries.length})`, exact: true })).toBeVisible();
    await expect(timeline).toContainText('Plan review');
    await expect(timeline).toContainText('Round 1');
    await expect(timeline).toContainText('Verification');
    await expect(timeline).toContainText('PASS');
    expect(await timeline.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await timeline.getByRole('link', { name: 'Open chat' }).first().click();
    expect(await page.evaluate(() => window.openedTimelineChat)).toEqual({ id: todoId, chatId: childId, agentTransport: 'codex' });
    await timeline.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => historyRequests).toEqual(2);
  });
}
