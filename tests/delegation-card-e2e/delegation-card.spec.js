import { test, expect } from '@playwright/test';

function record(seq, variant, payload) {
  return {
    kind: 'meta',
    variant,
    historySeq: seq,
    createdAt: '2026-09-18T10:00:00.000Z',
    payload: JSON.stringify(payload),
  };
}

async function waitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__delegationCard?.ready === true);
}

async function replay(page, records) {
  await page.evaluate((rows) => window.__delegationCard.replay(rows), records);
}

async function append(page, records) {
  await page.evaluate((rows) => window.__delegationCard.append(rows), records);
}

async function harnessState(page) {
  return page.evaluate(() => ({
    calls: window.__delegationCard.calls.slice(),
    alerts: window.__delegationCard.alerts.slice(),
  }));
}

async function setMock(page, patch) {
  await page.request.post('/mock/config', { data: patch });
}

test.describe('delegation card DOM', () => {
  test('replay, reconnect, retry, cancel, errors, uncertain', async ({ page }) => {
    await waitReady(page);

    await replay(page, [record(1, 'delegation', {
      id: 'job-1',
      status: 'running',
      childChatId: 'child-1',
      attemptId: 'a1',
      attempts: [],
      sourceKind: 'text',
      executor: { transport: 'opencode', model: 'opencode/test' },
      startedAt: '2026-09-18T10:00:00.000Z',
    })]);
    const running = page.locator('[data-delegation-id="job-1"]');
    await expect(running).toBeVisible();
    await expect(running).toContainText('Delegated execution');
    await expect(running).toContainText('Running');
    await expect(running).toContainText('Attempt 1');
    await expect(running).toContainText('Delivery: pending');
    await expect(running.locator('button', { hasText: 'Stop' })).toBeVisible();
    await expect(running.locator('button', { hasText: 'Retry' })).toHaveCount(0);

    await running.locator('button', { hasText: 'Stop' }).click();
    await expect.poll(async () => (await harnessState(page)).calls.some((row) => row.type === 'cancel')).toBe(true);

    await append(page, [record(2, 'delegation', {
      id: 'job-1',
      status: 'failed',
      childChatId: 'child-1',
      attemptId: 'a1',
      attempts: [],
      sourceKind: 'text',
      error: 'Executor crashed',
      startedAt: '2026-09-18T10:00:00.000Z',
      finishedAt: '2026-09-18T10:01:00.000Z',
    })]);
    await expect(running).toContainText('Failed');
    await expect(running).toContainText('Executor crashed');
    await expect(running.locator('button', { hasText: 'Retry' })).toBeVisible();
    await expect(running.locator('button', { hasText: 'Stop' })).toHaveCount(0);

    await setMock(page, { retryOk: false, retryError: 'Could not retry this job.' });
    await running.locator('button', { hasText: 'Retry' }).click();
    await expect.poll(async () => (await harnessState(page)).alerts.join(' ')).toContain('Could not retry this job.');

    await setMock(page, { retryOk: true });
    await running.locator('button', { hasText: 'Retry' }).click();
    await expect.poll(async () => (
      await harnessState(page)
    ).calls.filter((row) => row.type === 'retry').length).toBeGreaterThan(1);

    await append(page, [record(3, 'delegation', {
      id: 'job-1',
      status: 'interrupted',
      childChatId: 'child-1',
      attemptId: 'a2',
      attempts: [{ attemptId: 'a1', status: 'failed' }],
      sourceKind: 'text',
      delivery: 'uncertain',
      startedAt: '2026-09-18T10:00:00.000Z',
      finishedAt: '2026-09-18T10:02:00.000Z',
    })]);
    await expect(running).toContainText('Outcome unconfirmed');
    await expect(running).toContainText('Delivery: unconfirmed');
    await expect(running).toContainText('Attempt 2');
    await expect(running.locator('button', { hasText: 'Retry' })).toBeVisible();

    await replay(page, [
      record(1, 'delegation', {
        id: 'job-2',
        status: 'running',
        childChatId: 'child-2',
        attemptId: 'b1',
        attempts: [],
        event: 'started',
      }),
      record(2, 'delegation', {
        id: 'job-2',
        status: 'completed',
        childChatId: 'child-2',
        attemptId: 'b1',
        attempts: [],
        event: 'finished',
        historyDeliveredAt: '2026-09-18T10:01:00.000Z',
        reportDeliveredAt: '2026-09-18T10:01:01.000Z',
        report: 'All good',
      }),
      record(1, 'delegation', {
        id: 'job-2',
        status: 'queued',
        childChatId: 'child-2',
        attemptId: 'stale',
        event: 'started',
      }),
    ]);
    const reconnected = page.locator('[data-delegation-id="job-2"]');
    await expect(reconnected).toContainText('Completed');
    await expect(reconnected).toContainText('All good');
    await expect(reconnected).toContainText('Delivery: delivered');
    await expect(reconnected.locator('button', { hasText: 'Retry' })).toBeVisible();
    await expect(reconnected.locator('button', { hasText: 'Mark as reviewed' })).toBeVisible();
    await expect(reconnected.locator('button', { hasText: 'Stop' })).toHaveCount(0);

    await reconnected.locator('button', { hasText: 'Mark as reviewed' }).click();
    await expect.poll(async () => (await harnessState(page)).calls.some((row) => row.type === 'ack' && row.id === 'job-2')).toBe(true);

    await replay(page, [record(4, 'mailbox', {
      id: 'mail-1',
      kind: 'reply',
      status: 'uncertain',
      fromChatId: 'child-2',
      fromTitle: 'Executor',
      body: 'Unconfirmed delivery',
    })]);
    const mailbox = page.locator('[data-mailbox-id="mail-1"]');
    await expect(mailbox).toBeVisible();
    await expect(mailbox).toContainText('Unconfirmed delivery');
    await mailbox.locator('button', { hasText: 'Retry delivery' }).click();
    await expect.poll(async () => (
      await harnessState(page)
    ).calls.some((row) => row.type === 'mailbox-retry' && row.id === 'mail-1')).toBe(true);
  });
});
