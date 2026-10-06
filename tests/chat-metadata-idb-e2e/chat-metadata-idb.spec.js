import { test, expect } from '@playwright/test';

async function waitReady(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__chatMetadataIdb?.ready === true);
}

test.describe('chat metadata IndexedDB (5.1)', () => {
  test('round-trip chat row without runtime fields', async ({ page }) => {
    await waitReady(page);
    const ok = await page.evaluate(() =>
      window.__chatMetadataIdb.putChat({
        id: 'chat-1',
        title: 'Row',
        updatedAt: '2026-02-01T00:00:00.000Z',
        workspaceFile: 'ws.code-workspace',
        pane: { bad: true },
        ws: { send() {} },
      })
    );
    expect(ok).toBe(true);
    const rows = await page.evaluate(() => window.__chatMetadataIdb.listChats());
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('chat-1');
    expect(rows[0].pane).toBeUndefined();
    expect(rows[0].ws).toBeUndefined();
  });

  test('session boundary clears metadata but preserves SDK DB', async ({ page }) => {
    await waitReady(page);
    await page.evaluate(() => window.__chatMetadataIdb.putChat({ id: 'old', title: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' }));
    await page.evaluate(() => window.__chatMetadataIdb.putKv('k1', 'v1'));
    const sdkBefore = await page.evaluate(() => window.__chatMetadataIdb.sdkProbe());
    expect(sdkBefore?.events?.[0]?.t).toBe('sdk-seed');
    await page.evaluate(() => window.__chatMetadataIdb.clearBoundary());
    const rows = await page.evaluate(() => window.__chatMetadataIdb.listChats());
    expect(rows.length).toBe(0);
    const rawKv = await page.evaluate(() => window.__chatMetadataIdb.getRawMetaKey('k1'));
    expect(rawKv).toBeNull();
    const sdkAfter = await page.evaluate(() => window.__chatMetadataIdb.sdkProbe());
    expect(sdkAfter?.events?.[0]?.t).toBe('sdk-seed');
  });

  test('versionchange and module abort surface status', async ({ page }) => {
    await waitReady(page);
    await page.evaluate(() => window.__chatMetadataIdb.openDb());
    const abortStatus = await page.evaluate(() => window.__chatMetadataIdb.simulateModuleAbortTransaction());
    expect(abortStatus).toBe('aborted');
    await page.evaluate(() => window.__chatMetadataIdb.resetHarness());
    await page.evaluate(() => window.__chatMetadataIdb.openDb());
    const versionStatus = await page.evaluate(() => window.__chatMetadataIdb.simulateVersionChange());
    expect(versionStatus).toBe('versionchange');
  });

  test('blocked upgrade reports blocked while another tab holds the database', async ({ browser }) => {
    const context = await browser.newContext();
    const holder = await context.newPage();
    const challenger = await context.newPage();
    await waitReady(holder);
    await holder.evaluate(async () => {
      await window.__chatMetadataIdb.openDb();
      await window.__chatMetadataIdb.holdExtraLegacyConnection();
    });
    await challenger.goto('/?norest=1');
    await challenger.waitForFunction(() => window.__chatMetadataIdb?.ready === true);
    const blockedStatus = await challenger.evaluate(() =>
      window.__chatMetadataIdb.attemptUpgradeOpenWhilePeerConnected()
    );
    expect(blockedStatus).toBe('blocked');
    await context.close();
  });

  test('logout during write clears raw rows and does not resurrect stale session data', async ({ page }) => {
    await waitReady(page);
    await page.evaluate(() =>
      window.__chatMetadataIdb.putChat({ id: 'stale', title: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' })
    );
    const mid = await page.evaluate(() => window.__chatMetadataIdb.invalidateMidWrite());
    expect(mid.rawKv).toBeNull();
    expect(mid.staleKvRead).toBeNull();
    expect(mid.rowCount).toBe(0);
    await page.evaluate(() =>
      window.__chatMetadataIdb.putChat({ id: 'fresh', title: 'Fresh', updatedAt: '2026-02-01T00:00:00.000Z' })
    );
    const rows = await page.evaluate(() => window.__chatMetadataIdb.listChats());
    expect(rows.some((row) => row.id === 'stale')).toBe(false);
    expect(rows.some((row) => row.id === 'fresh')).toBe(true);
  });

  test('late kv read after auth boundary returns null with stale-session', async ({ page }) => {
    await waitReady(page);
    const result = await page.evaluate(() => window.__chatMetadataIdb.staleReadAfterEpochBump());
    expect(result.value).toBeNull();
    expect(result.status).toBe('stale-session');
  });
});
