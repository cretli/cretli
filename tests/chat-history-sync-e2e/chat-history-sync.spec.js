import { test, expect } from '@playwright/test';

function userRecord(seq, text, at) {
  return {
    kind: 'localUser',
    historySeq: seq,
    text,
    createdAt: at,
  };
}

function assistantRecord(seq, text, roomSeq, at, streamId = 'room-sync') {
  return {
    kind: 'sdk',
    historySeq: seq,
    eventStreamId: streamId,
    roomEventSeq: roomSeq,
    createdAt: at,
    event: {
      type: 'assistant',
      message: { content: [{ type: 'text', text }] },
    },
  };
}

function mailboxRecord(seq, status = 'delivered') {
  return {
    kind: 'meta',
    variant: 'mailbox',
    historySeq: seq,
    createdAt: '2026-09-19T10:00:02.000Z',
    payload: JSON.stringify({
      id: 'mail-gap',
      status,
      kind: 'final_report',
      body: 'child finished',
    }),
  };
}

function delegationRecord(seq) {
  return {
    kind: 'meta',
    variant: 'delegation',
    historySeq: seq,
    createdAt: '2026-09-19T10:00:03.000Z',
    payload: JSON.stringify({
      id: 'job-gap',
      status: 'completed',
      childChatId: 'child-1',
      attemptId: 'a1',
      attempts: [],
      sourceKind: 'text',
      executor: { transport: 'sdk', model: 'test' },
      startedAt: '2026-09-19T10:00:00.000Z',
      finishedAt: '2026-09-19T10:00:03.000Z',
    }),
  };
}

function indexOfCard(order, needle) {
  return order.findIndex((row) => String(row.text || '').includes(needle));
}

async function waitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__chatSync?.ready === true);
}

test.describe('chat history transport store DOM', () => {
  test('hidden fetch, restore, gap live card, render retry, replay, pane reset', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.seed([record]), userRecord(100, 'question', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('question')).toBeVisible();

    await page.evaluate(() => window.__chatSync.hide());
    const hiddenResult = await page.evaluate((record) => (
      window.__chatSync.fetchFromServer([record], 101)
    ), assistantRecord(101, 'missing answer', 1, '2026-09-19T10:00:01.000Z'));
    expect(hiddenResult.status).toBe('deferred');
    await expect(page.getByText('missing answer')).toHaveCount(0);

    await page.evaluate(() => window.__chatSync.show());
    const restored = await page.evaluate(() => window.__chatSync.converge());
    expect(restored.status).toBe('success');
    await expect(page.getByText('missing answer')).toBeVisible();

    const liveSeq = await page.evaluate((record) => window.__chatSync.liveCard(record), mailboxRecord(103));
    expect(liveSeq).toBe(101);
    await expect(page.locator('[data-mailbox-id="mail-gap"]')).toHaveCount(1);

    const gap = await page.evaluate((record) => (
      window.__chatSync.fetchFromServer([record], 103)
    ), delegationRecord(102));
    expect(gap.seqs).toContain(102);
    await expect(page.locator('[data-delegation-id="job-gap"]')).toBeVisible();
    await expect(page.getByText('missing answer')).toBeVisible();

    await page.evaluate(() => window.__chatSync.failNextAppend());
    const failed = await page.evaluate((record) => (
      window.__chatSync.fetchFromServer([record], 104)
    ), assistantRecord(104, 'after failure', 2, '2026-09-19T10:00:04.000Z'));
    expect(failed.status).toBe('error');
    const retried = await page.evaluate(() => window.__chatSync.converge());
    expect(['success', 'unchanged', 'partial']).toContain(retried.status);
    await expect(page.getByText('after failure')).toBeVisible();

    await page.evaluate(() => window.__chatSync.replayExisting());
    await expect(page.getByText('question')).toBeVisible();
    await expect(page.getByText('missing answer')).toBeVisible();
    await expect(page.getByText('after failure')).toBeVisible();
    const afterReplay = await page.evaluate((record) => (
      window.__chatSync.fetchFromServer([record], 105)
    ), assistantRecord(105, 'post replay', 3, '2026-09-19T10:00:05.000Z'));
    expect(afterReplay.seqs).toContain(105);
    await expect(page.getByText('post replay')).toBeVisible();

    await page.evaluate(() => window.__chatSync.destroyView());
    await expect(page.getByText('question')).toHaveCount(0);
    const recreated = await page.evaluate(() => window.__chatSync.recreateView());
    expect(recreated.status === 'success' || recreated.status === 'partial').toBeTruthy();
    await expect(page.getByText('question')).toBeVisible();
    await expect(page.getByText('missing answer')).toBeVisible();
    await expect(page.getByText('after failure')).toBeVisible();
    await expect(page.getByText('post replay')).toBeVisible();
  });

  test('production resume uses IndexedDB, HTTP catch-up, and view generation guards', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('seeded question')).toBeVisible();

    await page.evaluate(() => {
      window.__chatSync.liveSdkEvent({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'live answer' }] },
      }, 1);
    });
    await expect(page.getByText('live answer')).toBeVisible();

    const promptAndCovered = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      userRecord(101, 'other device prompt', '2026-09-19T10:00:01.000Z'),
      assistantRecord(102, 'live answer', 1, '2026-09-19T10:00:02.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 102), promptAndCovered);
    const resumed = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(resumed.viewAppliedSeq).toBe(102);
    expect(resumed.storeAckSeq).toBe(102);
    await expect(page.getByText('other device prompt')).toBeVisible();
    await expect(page.getByText('seeded question')).toBeVisible();
    await expect(page.getByText('live answer')).toBeVisible();

    await page.evaluate(() => window.__chatSync.setSession('sess-next'));
    const afterSession = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(afterSession.viewAppliedSeq).toBe(0);

    const afterSwapRecords = [
      ...promptAndCovered,
      userRecord(103, 'after swap', '2026-09-19T10:00:03.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 103), afterSwapRecords);
    await page.evaluate(() => window.__chatSync.holdFetch());
    const held = page.evaluate(() => window.__chatSync.productionResume('visibility'));
    await page.evaluate(() => window.__chatSync.swapView());
    await page.evaluate(() => window.__chatSync.releaseFetch());
    const swapped = await held;
    expect(swapped.deferReason).toBe('view_replaced');
    expect(swapped.viewAppliedSeq).toBe(0);
    expect(swapped.notified).toBe(false);
    await expect(page.getByText('after swap')).toHaveCount(0);
  });

  test('transport replay survives HTTP failure and renders the reply once', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'already on screen', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('already on screen')).toBeVisible();

    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.beginHydration());
    const pendingCount = await page.evaluate(() => (
      window.__chatSync.replayViaTransport({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'transport reply' }] },
      }, 1)
    ));
    expect(pendingCount).toBe(1);
    await expect(page.getByText('transport reply')).toHaveCount(0);

    await page.evaluate(() => window.__chatSync.failNextHistory());
    const failed = await page.evaluate(() => window.__chatSync.productionResume('replay_complete'));
    expect(failed.status).toBe('error');
    await expect(page.getByText('transport reply')).toBeVisible();

    const afterRetryRecords = [
      userRecord(100, 'already on screen', '2026-09-19T10:00:00.000Z'),
      assistantRecord(101, 'transport reply', 1, '2026-09-19T10:00:01.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 101), afterRetryRecords);
    await page.evaluate(() => window.__chatSync.beginHydration());
    const retried = await page.evaluate(() => window.__chatSync.productionResume('replay_complete'));
    expect(['success', 'unchanged', 'partial']).toContain(retried.status);
    await expect(page.getByText('transport reply')).toHaveCount(1);
    await expect(page.getByText('already on screen')).toBeVisible();
  });

  test('missing replay end and partial HTTP still show the buffered reply once', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('seeded question')).toBeVisible();

    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.beginHydration());
    await page.evaluate(() => (
      window.__chatSync.replayViaTransport({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'late replay' }] },
      }, 1)
    ));
    await expect(page.getByText('late replay')).toHaveCount(0);

    await page.evaluate(() => window.__chatSync.partialNextHistory());
    const partial = await page.evaluate(() => window.__chatSync.productionResume('replay_fallback'));
    expect(partial.status).toBe('partial');
    await expect(page.getByText('late replay')).toBeVisible();

    const afterPartial = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      assistantRecord(101, 'late replay', 1, '2026-09-19T10:00:01.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 101), afterPartial);
    await page.evaluate(() => window.__chatSync.beginHydration());
    const caughtUp = await page.evaluate(() => window.__chatSync.productionResume('replay_fallback'));
    expect(['success', 'unchanged', 'partial']).toContain(caughtUp.status);
    await expect(page.getByText('late replay')).toHaveCount(1);
  });

  test('live applyEvent failure is retried after seq 102 without duplicating 102', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('seeded question')).toBeVisible();

    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.failNextApplyEvent());
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    expect(await page.evaluate(() => window.__chatSync.hasUnrenderedRoomSeq(101))).toBe(true);
    await expect(page.getByText('response 101')).toHaveCount(0);

    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkRunFinished',
      eventStreamId: 'room-sync',
      roomEventSeq: 102,
      status: 'finished',
      runId: 'run-102',
    }));
    expect(await page.evaluate(() => window.__chatSync.roomSeq())).toBe(102);
    expect(await page.evaluate(() => window.__chatSync.hasUnrenderedRoomSeq(101))).toBe(true);
    await expect(page.getByText('response 101')).toHaveCount(0);

    const catchUpRecords = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      assistantRecord(101, 'response 101', 101, '2026-09-19T10:00:01.000Z'),
      assistantRecord(102, 'status 102', 102, '2026-09-19T10:00:02.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 102), catchUpRecords);
    const caughtUp = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(['success', 'unchanged', 'partial']).toContain(caughtUp.status);
    await expect(page.getByText('response 101')).toHaveCount(1);
    expect(await page.evaluate(() => window.__chatSync.hasUnrenderedRoomSeq(101))).toBe(false);
    const afterHttp = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(afterHttp, 'response 101')).toBeGreaterThanOrEqual(0);
    expect(indexOfCard(afterHttp, 'Run finished')).toBeGreaterThan(indexOfCard(afterHttp, 'response 101'));

    const retried = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(['success', 'unchanged', 'partial']).toContain(retried.status);
    await expect(page.getByText('response 101')).toHaveCount(1);
    await expect(page.getByText('status 102')).toHaveCount(0);

    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      replay: true,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    await expect(page.getByText('response 101')).toHaveCount(1);
    const afterReplay = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(afterReplay, 'response 101')).toBeGreaterThanOrEqual(0);
    expect(indexOfCard(afterReplay, 'Run finished')).toBeGreaterThan(indexOfCard(afterReplay, 'response 101'));
  });

  test('HTTP catch-up inserts 101 before live 102 and keeps draft plus visible scroll', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    await expect(page.getByText('seeded question')).toBeVisible();

    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.failNextApplyEvent());
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 102,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 102' }] },
      },
    }));
    await expect(page.getByText('response 101')).toHaveCount(0);
    await expect(page.getByText('response 102')).toHaveCount(1);

    await page.evaluate(() => window.__chatSync.setDraft('keep this draft'));
    await page.evaluate(() => window.__chatSync.prepareScrollMount());
    await page.evaluate(() => window.__chatSync.scrollNeedleIntoView('response 102'));
    const beforeAnchor = await page.evaluate(() => window.__chatSync.anchorMetrics('response 102'));
    expect(beforeAnchor).toBeTruthy();

    const catchUpRecords = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      assistantRecord(101, 'response 101', 101, '2026-09-19T10:00:01.000Z'),
      assistantRecord(102, 'response 102', 102, '2026-09-19T10:00:02.000Z'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 102), catchUpRecords);
    const caughtUp = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(['success', 'unchanged', 'partial']).toContain(caughtUp.status);
    await expect(page.getByText('response 101')).toHaveCount(1);
    await expect(page.getByText('response 102')).toHaveCount(1);
    const order = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(order, 'response 101')).toBeGreaterThanOrEqual(0);
    expect(indexOfCard(order, 'response 102')).toBeGreaterThan(indexOfCard(order, 'response 101'));
    expect(await page.evaluate(() => window.__chatSync.getDraft())).toBe('keep this draft');
    const afterAnchor = await page.evaluate(() => window.__chatSync.anchorMetrics('response 102'));
    expect(Math.abs((afterAnchor?.top || 0) - (beforeAnchor?.top || 0))).toBeLessThanOrEqual(3);
  });

  test('WS retry inserts 101 before live 102 without a full replay', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.failNextApplyEvent());
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 102,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 102' }] },
      },
    }));
    await expect(page.getByText('response 102')).toHaveCount(1);
    await page.evaluate(() => window.__chatSync.setDraft('typed while waiting'));
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      replay: true,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    await expect(page.getByText('response 101')).toHaveCount(1);
    await expect(page.getByText('response 102')).toHaveCount(1);
    const order = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(order, 'response 102')).toBeGreaterThan(indexOfCard(order, 'response 101'));
    expect(await page.evaluate(() => window.__chatSync.getDraft())).toBe('typed while waiting');
  });

  test('recovered 101 sits before a live delegation card 102', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.failNextApplyEvent());
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'room-sync',
      roomEventSeq: 101,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'response 101' }] },
      },
    }));
    await page.evaluate((record) => window.__chatSync.liveCard(record), delegationRecord(102));
    await expect(page.locator('[data-delegation-id="job-gap"]')).toHaveCount(1);
    await expect(page.getByText('response 101')).toHaveCount(0);

    const catchUpRecords = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      assistantRecord(101, 'response 101', 101, '2026-09-19T10:00:01.000Z'),
      delegationRecord(102),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 102), catchUpRecords);
    const caughtUp = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(['success', 'unchanged', 'partial']).toContain(caughtUp.status);
    await expect(page.getByText('response 101')).toHaveCount(1);
    await expect(page.locator('[data-delegation-id="job-gap"]')).toHaveCount(1);
    const order = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(order, 'Delegated execution')).toBeGreaterThan(indexOfCard(order, 'response 101'));
  });

  test('new stream B1 stays after old stream A102', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'stream-a',
      roomEventSeq: 102,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'old A102' }] },
      },
    }));
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'stream-b',
      roomEventSeq: 1,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'new B1' }] },
      },
    }));
    await expect(page.getByText('old A102')).toHaveCount(1);
    await expect(page.getByText('new B1')).toHaveCount(1);
    const order = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(order, 'new B1')).toBeGreaterThan(indexOfCard(order, 'old A102'));
  });

  test('recovered B1 sits before live B2; both stay after A102', async ({ page }) => {
    await waitReady(page);

    await page.evaluate((record) => window.__chatSync.productionSeed([record]), userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'));
    const connected = await page.evaluate(() => window.__chatSync.connectTransport());
    expect(connected).toBe(true);
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'stream-a',
      roomEventSeq: 102,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'old A102' }] },
      },
    }));
    await page.evaluate(() => window.__chatSync.failNextApplyEvent());
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'stream-b',
      roomEventSeq: 1,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'new B1' }] },
      },
    }));
    await page.evaluate(() => window.__chatSync.emitViaTransport({
      type: 'sdkEvent',
      eventStreamId: 'stream-b',
      roomEventSeq: 2,
      event: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'new B2' }] },
      },
    }));
    await expect(page.getByText('old A102')).toHaveCount(1);
    await expect(page.getByText('new B1')).toHaveCount(0);
    await expect(page.getByText('new B2')).toHaveCount(1);
    const beforeRecover = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(beforeRecover, 'new B2')).toBeGreaterThan(indexOfCard(beforeRecover, 'old A102'));

    const catchUpRecords = [
      userRecord(100, 'seeded question', '2026-09-19T10:00:00.000Z'),
      assistantRecord(200, 'old A102', 102, '2026-09-19T10:00:02.000Z', 'stream-a'),
      assistantRecord(201, 'new B1', 1, '2026-09-19T10:00:03.000Z', 'stream-b'),
      assistantRecord(202, 'new B2', 2, '2026-09-19T10:00:04.000Z', 'stream-b'),
    ];
    await page.evaluate((records) => window.__chatSync.productionPublish(records, 202), catchUpRecords);
    const caughtUp = await page.evaluate(() => window.__chatSync.productionResume('visibility'));
    expect(['success', 'unchanged', 'partial']).toContain(caughtUp.status);
    await expect(page.getByText('new B1')).toHaveCount(1);
    await expect(page.getByText('new B2')).toHaveCount(1);
    const order = await page.evaluate(() => window.__chatSync.cardOrder());
    expect(indexOfCard(order, 'new B1')).toBeGreaterThan(indexOfCard(order, 'old A102'));
    expect(indexOfCard(order, 'new B2')).toBeGreaterThan(indexOfCard(order, 'new B1'));
  });
});
