import test from 'node:test';
import assert from 'node:assert/strict';
import { runRichViewScenario } from './helpers/rich-view-chromium.js';

test('a touch drag 30–60px above the bottom scrolls content before revealing actions (390×844 Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const { mountChatMobileOverscrollActions } = await import(new URL('../features/chat/views/chatMobileActions.js', viewUrl));
    const mount = document.getElementById('mount');
    const pane = document.createElement('div');
    pane.className = 'active';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;height:242px;overflow:hidden';
    mount.before(pane); pane.append(wrap); wrap.append(mount);
    const style = document.createElement('style');
    style.textContent = '.chat-mobile-overscroll-actions { position:absolute;bottom:0;height:60px;width:100% }';
    document.head.append(style);
    const chat = { id: 'touch-pull-up' };
    const rich = createSdkRichView(chat, mount, { appendPlain() {} });
    chat._sdkRichView = rich;
    mountChatMobileOverscrollActions({ chat, pane, container: mount, viewportWrap: wrap });
    const events = [];
    wrap.addEventListener('touchmove', (event) => events.push(event.defaultPrevented));
    await rich.replayHistoryRecords(Array.from({ length: 40 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `notice ${i}` })), { instant: true });
    window.touchFixture = { mount, rich, wrap, events };
    return [];
  }, {
    viewport: { width: 390, height: 844 }, hasTouch: true,
    // Archive dialogs pull in the whole app. Keep this unrelated action boundary inert;
    // the gesture module, rich view, controller and browser scrolling are production code.
    beforeScenario: async (page) => {
      await page.route('**/features/chat/services/chatDeleteArchive.js', (route) => route.fulfill({
        contentType: 'text/javascript',
        body: `const unused = () => { throw new Error('Archive action outside touch test'); };
          export { unused as requestArchiveChatConfirmed, unused as requestDeleteChat, unused as requestRestoreChat };`,
      }));
    },
    interact: async (page) => {
      const session = await page.context().newCDPSession(page);
      const settle = () => page.evaluate(async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); });
      await settle();
      const samples = [];
      for (const distance of [30, 60]) {
        const before = await page.evaluate((distance) => {
          const { mount, rich, events } = window.touchFixture;
          mount.scrollTop = mount.scrollHeight - mount.clientHeight - distance;
          events.length = 0;
          return { top: mount.scrollTop, near: rich.isViewportNearBottom(), atBottom: rich.isViewportAtBottom() };
        }, distance);
        await settle();
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 180 }] });
        for (const y of [174, 168, 162, 156, 150]) {
          await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y }] });
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await settle();
        const after = await page.evaluate(() => {
          const { mount, wrap, events } = window.touchFixture;
          return { top: mount.scrollTop, transform: mount.style.transform, opened: wrap.classList.contains('chat-mobile-actions-open'), prevented: [...events] };
        });
        samples.push({ distance, before, after });
      }
      await session.detach();
      const opening = await page.evaluate(async () => {
        const { mount, rich, wrap } = window.touchFixture;
        const max = mount.scrollHeight - mount.clientHeight;
        rich.restoreViewportSnapshot({ following: false, scrollTop: max - 1, readingAnchor: null });
        const followingBefore = rich.getViewportSnapshot().following;
        const touch = (type, y) => {
          const point = new Touch({ identifier: 1, target: mount, clientX: 150, clientY: y });
          mount.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, changedTouches: [point] }));
        };
        touch('touchstart', 180); touch('touchmove', 20); touch('touchend', 20);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { followingBefore, followingAfter: rich.getViewportSnapshot().following,
          distance: mount.scrollHeight - mount.clientHeight - mount.scrollTop,
          opened: wrap.classList.contains('chat-mobile-actions-open') };
      });
      assert.equal(opening.followingBefore, false);
      assert.equal(opening.followingAfter, true);
      assert.equal(opening.opened, true);
      assert.ok(opening.distance <= 2, JSON.stringify(opening));
      const closing = await page.evaluate(async () => {
        const { mount, rich, wrap } = window.touchFixture;
        mount.scrollTop = mount.scrollHeight - mount.clientHeight - 3;
        await new Promise((resolve) => setTimeout(resolve, 250));
        return { opened: wrap.classList.contains('chat-mobile-actions-open'),
          atBottom: rich.isViewportAtBottom(), transform: mount.style.transform };
      });
      assert.equal(closing.opened, false);
      assert.equal(closing.atBottom, false);
      assert.equal(closing.transform, '');
      await page.evaluate(() => window.touchFixture.rich.destroy());
      return samples;
    },
  });
  assert.deepEqual(pageErrors, []);
  for (const sample of result) {
    assert.equal(sample.before.near, true, JSON.stringify(sample));
    assert.equal(sample.before.atBottom, false, JSON.stringify(sample));
    assert.ok(sample.after.top > sample.before.top, JSON.stringify(sample));
    assert.equal(sample.after.transform, '', JSON.stringify(sample));
    assert.equal(sample.after.opened, false, JSON.stringify(sample));
    assert.ok(sample.after.prevented.length > 0 && sample.after.prevented.every((prevented) => !prevented), JSON.stringify(sample));
  }
});
