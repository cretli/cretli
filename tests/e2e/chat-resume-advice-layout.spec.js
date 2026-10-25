import fs from 'node:fs';
import { test, expect } from '@playwright/test';

for (const width of [390, 1440]) {
  test(`inline resume advice preserves composer and context position at ${width}px`, async ({ page }) => {
    const bannerSource = fs.readFileSync(new URL('../../app_front/features/chat/chatResumeAdviceBanner.js', import.meta.url), 'utf8');
    const utilsSource = fs.readFileSync(new URL('../../app_front/features/chat/chatHtmlUtils.js', import.meta.url), 'utf8');
    await page.route('**/resume-advice-fixture.js', (route) => route.fulfill({
      contentType: 'text/javascript', body: bannerSource.replace('./chatHtmlUtils.js', './resume-advice-utils.js'),
    }));
    await page.route('**/resume-advice-utils.js', (route) => route.fulfill({ contentType: 'text/javascript', body: utilsSource }));
    const layoutSource = fs.readFileSync(new URL('../../app_front/features/chat/chatSendBarLayout.js', import.meta.url), 'utf8');
    await page.route('**/send-bar-layout-fixture.js', (route) => route.fulfill({ contentType: 'text/javascript', body: layoutSource }));
    await page.setViewportSize({ width, height: 844 });
    // Login loads the real UI primitives without opening or changing a user chat.
    await page.goto('/login');
    await page.addStyleTag({ url: '/dist/app/index.css' });
    await page.evaluate(async () => {
      await Promise.all(['cr-bar-button', 'cr-icon-button'].map((tag) => customElements.whenDefined(tag)));
      document.body.innerHTML = `<section id="chat-panel" class="active" style="display:flex;height:100dvh;padding:0">
        <div class="chat-tab-pane active" style="display:flex;flex-direction:column;flex:1;min-height:0">
          <div class="terminal-viewport-wrap"><div class="sdk-rich-chat-mount">
            <div class="sdk-rich-stream">${'<p>Earlier message</p>'.repeat(50)}<p id="last-message">Last message</p></div>
            <div class="chat-resume-advice-host" hidden></div>
          </div></div>
          <div class="chat-pane-toolbar chat-send-bar">
            <div class="send-keys-context-stack"><div class="send-keys-todo-chip">Current task</div></div>
            <div class="send-keys-wrap"><input class="send-keys-input" aria-label="Message"><button class="send-keys-btn">Send</button></div>
          </div>
        </div></section>`;
      const { syncChatSendBarReserveNow } = await import('/send-bar-layout-fixture.js');
      syncChatSendBarReserveNow();
      const host = document.querySelector('.chat-resume-advice-host');
      const { createResumeAdviceController } = await import('/resume-advice-fixture.js');
      const labels = {
        'chat.resumeAdviceDismiss': 'Dismiss notice',
        'chat.resumeAdviceText': 'Prompt cache has likely expired. Sending now re-processes about 597k tokens at full input price.',
        'chat.resumeAdviceReference': 'New chat with reference',
        'chat.resumeAdviceSendAnyway': 'Send anyway',
        'chat.resumeAdviceSummary': 'New chat with summary',
        'chat.resumeAdviceSummaryCost': 'Optional summary: one cheap-model call on about 12k tokens. Runs only on click.',
      };
      window.adviceController = createResumeAdviceController({
        api: { getUsageResumeAdvice: async () => ({ ok: true, advice: { show: true, contextTokens: 597000, lastCachedTurnAt: 1000, estimatedSummaryTokens: 12000, estimatedSummaryUsd: 0.01 } }) },
        t: (key) => labels[key] || key, formatUsd: String, getHost: () => host,
        onReference: async () => ({ ok: true }),
      });
      host.parentElement.scrollTop = host.parentElement.scrollHeight;
    });
    const bar = page.locator('.chat-send-bar');
    const chip = page.locator('.send-keys-todo-chip');
    const beforeBar = await bar.boundingBox();
    const beforeChip = await chip.boundingBox();
    await page.evaluate(() => window.adviceController.check({ id: 'fixture' }));
    const notice = page.locator('[data-resume-advice]');
    await expect(notice).toBeVisible();
    await expect.poll(async () => {
      const box = await notice.boundingBox();
      return box.y + box.height;
    }).toBeLessThanOrEqual(beforeChip.y);
    const noticeBox = await notice.boundingBox();
    const lastMessageBox = await page.locator('#last-message').boundingBox();
    expect(lastMessageBox.y + lastMessageBox.height).toBeLessThanOrEqual(noticeBox.y);
    expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(beforeChip.y);
    expect(await bar.boundingBox()).toEqual(beforeBar);
    expect(await chip.boundingBox()).toEqual(beforeChip);
    expect(await notice.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    // The summary estimate is its own row, never stacked on top of the main notice text.
    const textBox = await notice.locator('.chat-resume-advice-text').boundingBox();
    const estimateBox = await notice.locator('[data-resume-advice-summary-estimate]').boundingBox();
    expect(textBox.y + textBox.height).toBeLessThanOrEqual(estimateBox.y);
    await page.getByRole('button', { name: 'Dismiss notice' }).click();
    await expect(notice).toHaveCount(0);
    expect(await bar.boundingBox()).toEqual(beforeBar);
    await page.evaluate(() => window.adviceController.check({ id: 'fixture' }));
    await expect(notice).toHaveCount(0);
  });
}
