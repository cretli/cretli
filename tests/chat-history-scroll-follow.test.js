/**
 * Chat scroll following: auto-follow keeps the bottom while the user is there and never
 * pulls a reader back down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { nextStickToBottom } from '../app_front/lib/scrollStickGeometry.js';
import { runRichViewScenario } from './helpers/rich-view-chromium.js';

test('stick follows the scroll direction, not the distance alone', () => {
  const base = { maxScroll: 1000, thresholdPx: 64 };
  // Content grew by 300px under a following view: scrollTop did not move up.
  assert.equal(nextStickToBottom({ ...base, stick: true, lastScrollTop: 700, scrollTop: 700 }), true);
  // The user scrolled up a little: released even within the threshold.
  assert.equal(nextStickToBottom({ ...base, stick: true, lastScrollTop: 1000, scrollTop: 970 }), false);
  // Content above shrank and the browser clamped scrollTop: still at the bottom.
  assert.equal(nextStickToBottom({ ...base, stick: true, lastScrollTop: 1100, scrollTop: 1000 }), true);
  // Scrolling down near the bottom takes it again; scrolling up near it does not.
  assert.equal(nextStickToBottom({ ...base, stick: false, lastScrollTop: 900, scrollTop: 950 }), true);
  assert.equal(nextStickToBottom({ ...base, stick: false, lastScrollTop: 990, scrollTop: 950 }), false);
  // No history yet: plain distance check.
  assert.equal(nextStickToBottom({ ...base, stick: false, scrollTop: 990 }), true);
  assert.equal(nextStickToBottom({ ...base, stick: true, maxScroll: 0, lastScrollTop: 5, scrollTop: 0 }), true);
});

/**
 * Page-side helpers shared by the scenarios below. Kept inside each scenario because
 * the function is stringified into the page.
 */
const SCROLL_SCENARIO = async ({ viewUrl, args }) => {
  const viewMod = await import(viewUrl);
  const mount = document.getElementById('mount');
  const chat = { id: `scroll-${args.name}` };
  const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await frame();
  };
  const notice = (seq) => ({ kind: 'meta', variant: 'notice', historySeq: seq, payload: `notice ${seq}` });
  const records = [];
  for (let seq = 1; seq <= 30; seq += 1) records.push(notice(seq));
  await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
  rich.scrollToBottom({ force: true });
  await settle();
  const distance = () => mount.scrollHeight - mount.clientHeight - mount.scrollTop;
  const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-scroll' });
  const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const out = { startDistance: distance() };
  if (args.name === 'user-scrolls-up-mid-stream') {
    rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }, meta(31));
    rich.applyEvent(answer('streaming '.repeat(40)), meta(32));
    // The user flicks up in the same frame the follow scroll was queued.
    mount.scrollTop = 100;
    await settle();
    rich.applyEvent(answer('streaming '.repeat(80)), meta(33));
    await settle();
    out.scrollTop = mount.scrollTop;
  } else if (args.name === 'content-grows-without-scroll-call') {
    const tall = document.createElement('div');
    tall.style.height = '300px';
    tall.textContent = 'late image';
    mount.querySelector('.sdk-rich-stream')?.appendChild(tall);
    await settle();
    out.distance = distance();
  } else if (args.name === 'keyboard-shrinks-viewport') {
    mount.style.height = '120px';
    await settle();
    out.distance = distance();
  } else if (args.name === 'queued-prompt-starts-while-reading') {
    rich.appendQueuedPrompt('later please', 1, { silent: true });
    await settle();
    mount.scrollTop = 50;
    await settle();
    rich.promoteQueuedPrompt('later please');
    await settle();
    out.scrollTop = mount.scrollTop;
  }
  rich.destroy();
  return out;
};

test('a user scrolling up mid-stream is not pulled back down (g, Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(SCROLL_SCENARIO, { args: { name: 'user-scrolls-up-mid-stream' } });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.startDistance <= 2, `starts at the bottom: ${JSON.stringify(result)}`);
  assert.ok(result.scrollTop <= 110, `reader stays put: ${JSON.stringify(result)}`);
});

test('content growing without a scroll call keeps a following view at the bottom (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(SCROLL_SCENARIO, { args: { name: 'content-grows-without-scroll-call' } });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.distance <= 2, `still at the bottom: ${JSON.stringify(result)}`);
});

test('a shrinking viewport (mobile keyboard) keeps the bottom in view (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(SCROLL_SCENARIO, { args: { name: 'keyboard-shrinks-viewport' } });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.distance <= 2, `still at the bottom: ${JSON.stringify(result)}`);
});

test('a queued prompt starting on the server does not move a reader (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(SCROLL_SCENARIO, { args: { name: 'queued-prompt-starts-while-reading' } });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.scrollTop <= 60, `reader stays put: ${JSON.stringify(result)}`);
});

test('scrolling down into a parked tail restores it step by step without a jump (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl, parkingUrl }) => {
    const viewMod = await import(viewUrl);
    const parking = await import(parkingUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'parked-scroll-down' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const harness = rich.mountedWindowHarness;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      for (let i = 0; i < 6; i += 1) await frame();
    };
    const notice = (seq) => ({ kind: 'meta', variant: 'notice', historySeq: seq, payload: `notice ${seq}` });
    const records = [];
    for (let seq = 1; seq <= 80; seq += 1) records.push(notice(seq));
    await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
    await settle();
    mount.scrollTop = 0;
    await settle();
    // The reader is up in the history while 60 newer cards sit parked.
    harness.evictTailCards(60);
    await settle();
    const parkedSeqs = () => parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
    const parkedBefore = parkedSeqs().length;
    const seqs = () => [...harness.getRealStream().children].map((el) => Number(el.dataset.historySeq) || 0);
    const lastMounted = harness.getRealStream().lastElementChild;
    // Scroll down to the bottom of what is mounted.
    mount.scrollTop = mount.scrollHeight;
    await settle();
    const anchorTop = lastMounted.getBoundingClientRect().top;
    const viewBottom = mount.getBoundingClientRect().bottom;
    const step = {
      parked: parkedSeqs().length,
      anchorVisible: anchorTop < viewBottom && anchorTop > mount.getBoundingClientRect().top - 60,
      distance: mount.scrollHeight - mount.clientHeight - mount.scrollTop,
    };
    // Keep scrolling down until everything is back.
    for (let i = 0; i < 6 && parkedSeqs().length > 0; i += 1) {
      mount.scrollTop = mount.scrollHeight;
      await settle();
    }
    mount.scrollTop = mount.scrollHeight;
    await settle();
    const finalSeqs = seqs().filter((s) => s > 0);
    const out = {
      parkedBefore,
      step,
      parkedAfter: parkedSeqs().length,
      ordered: finalSeqs.every((s, i) => i === 0 || s > finalSeqs[i - 1]),
      last: finalSeqs[finalSeqs.length - 1],
    };
    rich.destroy();
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.parkedBefore, 60);
  assert.ok(result.step.parked > 0 && result.step.parked < 60, `one step restored: ${JSON.stringify(result)}`);
  assert.ok(result.step.anchorVisible, `the card the reader saw stays in view: ${JSON.stringify(result)}`);
  assert.ok(result.step.distance > 64, `no jump to the live end mid-way: ${JSON.stringify(result)}`);
  assert.equal(result.parkedAfter, 0);
  assert.equal(result.ordered, true);
  assert.equal(result.last, 80);
});

test('switching away and back keeps a reader in place and a follower at the bottom (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'switch-back' }, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const settle = async () => {
      for (let i = 0; i < 4; i += 1) await frame();
    };
    const records = [];
    for (let seq = 1; seq <= 30; seq += 1) records.push({ kind: 'meta', variant: 'notice', historySeq: seq, payload: `notice ${seq}` });
    await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
    rich.scrollToBottom({ force: true });
    await settle();
    const hideAndShow = async () => {
      mount.style.display = 'none';
      mount.dispatchEvent(new Event('scroll'));
      await settle();
      mount.style.display = '';
      await settle();
      rich.restoreViewportAfterShow();
      await settle();
    };
    mount.scrollTop = 120;
    await settle();
    await hideAndShow();
    const reader = mount.scrollTop;
    mount.scrollTop = 0;
    await settle();
    await hideAndShow();
    const readerAtTop = mount.scrollTop;
    rich.scrollToBottom({ force: true });
    await settle();
    await hideAndShow();
    const follower = mount.scrollHeight - mount.clientHeight - mount.scrollTop;
    rich.destroy();
    return { reader, readerAtTop, follower };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.readerAtTop, 0, `a reader at the very top stays there: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.reader - 120) <= 2, `reader position kept: ${JSON.stringify(result)}`);
  assert.ok(result.follower <= 2, `follower back at the bottom: ${JSON.stringify(result)}`);
});

test('a long chunked history replay stays at the bottom while it renders (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'chunked-open' }, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const records = [];
    for (let seq = 1; seq <= 300; seq += 1) {
      records.push({ kind: 'meta', variant: 'notice', historySeq: seq, payload: `notice ${seq}` });
    }
    const replay = rich.replayHistoryRecords(records, { source: 'test' });
    const distances = [];
    let settled = false;
    void replay.then(() => { settled = true; });
    for (let i = 0; i < 120 && !settled; i += 1) {
      await frame();
      if (mount.scrollHeight > mount.clientHeight) {
        distances.push(Math.round(mount.scrollHeight - mount.clientHeight - mount.scrollTop));
      }
    }
    await replay;
    for (let i = 0; i < 3; i += 1) await frame();
    const finalDistance = mount.scrollHeight - mount.clientHeight - mount.scrollTop;
    rich.destroy();
    return { samples: distances.length, worst: Math.max(0, ...distances), finalDistance };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.samples > 0, 'replay was sampled while rendering');
  assert.ok(result.worst <= 2, `view left the bottom during replay: ${JSON.stringify(result)}`);
  assert.ok(result.finalDistance <= 2);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`reading anchor survives late layout, prepend, transforms and snapshots (${viewport.width}px Chromium)`, { timeout: 180_000 }, async () => {
    const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
      const { createSdkRichView } = await import(viewUrl);
      const mount = document.getElementById('mount');
      const rich = createSdkRichView({ id: 'anchor-layout' }, mount, { appendPlain() {} });
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
      const records = Array.from({ length: 40 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 81, payload: `notice ${i + 81}` }));
      await rich.replayHistoryRecords(records, { instant: true });
      await settle();
      mount.scrollTop = 350;
      await settle();
      const stream = mount.querySelector('.sdk-rich-stream');
      const card = [...stream.children].find((el) => el.getBoundingClientRect().bottom > mount.getBoundingClientRect().top);
      const offset = () => card.getBoundingClientRect().top - mount.getBoundingClientRect().top;
      const original = offset();
      const errors = [];
      const check = () => errors.push(Math.abs(offset() - original));
      // A late image/diagram above the reading card changes the stream's measured height.
      const image = document.createElement('div');
      image.style.height = '300px';
      stream.prepend(image);
      await settle(); check();
      mount.style.height = '120px';
      await settle(); check();
      // The resume banner is a sibling of the stream, above the reader.
      const banner = document.createElement('div');
      banner.style.height = '100px';
      mount.insertBefore(banner, stream);
      await settle(); check();
      image.style.height = '100px';
      await settle(); check();
      // Pull-up transforms move the scroller and its content together.
      mount.style.transform = 'translateY(-60px)';
      image.style.height = '200px';
      await settle(); check();
      mount.style.transform = '';
      const saved = JSON.parse(JSON.stringify(rich.getViewportSnapshot()));
      mount.style.display = 'none';
      mount.dispatchEvent(new Event('scroll'));
      await settle();
      mount.style.display = '';
      rich.restoreViewportSnapshot(saved);
      await settle(); check();
      const older = Array.from({ length: 80 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `older ${i}` }));
      rich.prependHistoryRecords(older);
      await settle(); check();
      rich.scrollToBottom();
      await settle(); check();
      const following = rich.getViewportSnapshot().following;
      rich.scrollToBottom({ force: true });
      await settle();
      const distance = mount.scrollHeight - mount.clientHeight - mount.scrollTop;
      rich.destroy();
      return { errors, following, distance };
    }, { viewport });
    assert.deepEqual(pageErrors, []);
    assert.ok(result.errors.every((error) => error <= 2), JSON.stringify(result));
    assert.equal(result.following, false);
    assert.ok(result.distance <= 2, JSON.stringify(result));
  });
}

test('background replay, queue and context changes preserve reading; local send takes following (k, Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = createSdkRichView({ id: 'background-scroll' }, mount, { appendPlain() {} });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
    const records = Array.from({ length: 40 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `notice ${i}` }));
    await rich.replayHistoryRecords(records, { instant: true });
    await settle();
    mount.scrollTop = 120;
    await settle();
    const positions = [];
    const note = async () => { await settle(); positions.push(mount.scrollTop); };
    rich.appendQueuedPrompt('background queue', 1, { silent: true }); await note();
    rich.promoteQueuedPrompt('background queue'); await note();
    rich.promoteQueuedPrompt('missing queued block'); await note();
    rich.markUserPromptQueued('missing queued block'); await note();
    rich.appendContextSeedBlock('context', { silent: true }); await note();
    await rich.appendHistoryRecords([{ kind: 'meta', variant: 'notice', historySeq: 41, payload: 'new history' }], { instant: true }); await note();
    await rich.replayHistoryRecords(records, { instant: true }); await note();
    const followingBeforeSend = rich.getViewportSnapshot().following;
    // The alternate replay API has no history seqs; its safe fallback is scrollTop.
    rich.applyAgentMessagesHistory(Array.from({ length: 30 }, (_, i) => ({ type: 'user', message: { content: [{ type: 'text', text: `prompt ${i}` }] } })));
    await note();
    rich.appendUserPrompt('my explicit send');
    await settle();
    const distance = mount.scrollHeight - mount.clientHeight - mount.scrollTop;
    const followingAfterSend = rich.getViewportSnapshot().following;
    rich.destroy();
    return { positions, followingBeforeSend, followingAfterSend, distance };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.positions.every((top) => Math.abs(top - 120) <= 2), JSON.stringify(result));
  assert.equal(result.followingBeforeSend, false);
  assert.equal(result.followingAfterSend, true);
  assert.ok(result.distance <= 2, JSON.stringify(result));
});

test('delayed own scroll events and pointer focus do not release follow (h, Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = createSdkRichView({ id: 'delayed-own-scroll' }, mount, { appendPlain() {} });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
    await rich.replayHistoryRecords(Array.from({ length: 30 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `notice ${i}` })), { instant: true });
    await settle();
    mount.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    mount.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    const late = document.createElement('div'); late.style.height = '300px';
    mount.querySelector('.sdk-rich-stream').append(late);
    await settle();
    mount.dispatchEvent(new Event('scroll'));
    await settle();
    const out = { following: rich.getViewportSnapshot().following, distance: mount.scrollHeight - mount.clientHeight - mount.scrollTop };
    rich.destroy();
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.following, true);
  assert.ok(result.distance <= 2, JSON.stringify(result));
});

test('scroll intent belongs to the conversation, excluding editors and nested scrollers (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = createSdkRichView({ id: 'scroll-intent' }, mount, { appendPlain() {} });
    const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); };
    await rich.replayHistoryRecords(Array.from({ length: 40 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `notice ${i}` })), { instant: true });
    await settle();
    const nested = document.createElement('div');
    nested.style.cssText = 'height:40px;overflow:auto';
    nested.innerHTML = '<div style="height:200px"></div>';
    const editor = document.createElement('textarea');
    mount.querySelector('.sdk-rich-stream').append(nested, editor);
    await settle();
    nested.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true, composed: true }));
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, composed: true }));
    await settle();
    const nestedFollowing = rich.getViewportSnapshot().following;
    rich.scrollToBottom();
    mount.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }));
    await settle();
    const wheelFollowing = rich.getViewportSnapshot().following;
    rich.scrollToBottom({ force: true }); await settle();
    rich.scrollToBottom();
    mount.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    await settle();
    const keyFollowing = rich.getViewportSnapshot().following;
    // Removing the visible card falls back to its next neighbour at the same offset.
    mount.scrollTop = 300; await settle();
    const stream = mount.querySelector('.sdk-rich-stream');
    const card = [...stream.children].find((el) => el.getBoundingClientRect().bottom > mount.getBoundingClientRect().top);
    const neighbour = card.nextElementSibling;
    const before = neighbour.getBoundingClientRect().top;
    card.remove(); await settle();
    const removalError = Math.abs(neighbour.getBoundingClientRect().top - before);
    rich.scrollToBottom({ force: true });
    rich.destroy();
    mount.scrollTop = 0;
    await settle();
    return { nestedFollowing, wheelFollowing, keyFollowing, removalError, afterDestroy: mount.scrollTop };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.nestedFollowing, true);
  assert.equal(result.wheelFollowing, false);
  assert.equal(result.keyFollowing, false);
  assert.ok(result.removalError <= 2, JSON.stringify(result));
  assert.equal(result.afterDestroy, 0);
});

test('chunked background replacement restores a reading card beyond the sync head (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const { createSdkRichView } = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = createSdkRichView({ id: 'chunked-reading' }, mount, { appendPlain() {} });
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(requestAnimationFrame); };
    const records = Array.from({ length: 200 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 81, payload: `notice ${i + 81}` }));
    await rich.replayHistoryRecords(records);
    await settle();
    mount.scrollTop = 1500; await settle();
    const stream = mount.querySelector('.sdk-rich-stream');
    const card = [...stream.children].find((el) => el.getBoundingClientRect().bottom > mount.getBoundingClientRect().top);
    const seq = card.dataset.historySeq;
    const before = card.getBoundingClientRect().top - mount.getBoundingClientRect().top;
    const older = Array.from({ length: 80 }, (_, i) => ({ kind: 'meta', variant: 'notice', historySeq: i + 1, payload: `older ${i}` }));
    await rich.replayHistoryRecords([...older, ...records]);
    await settle();
    const restored = [...stream.children].find((el) => el.dataset.historySeq === seq);
    const after = restored.getBoundingClientRect().top - mount.getBoundingClientRect().top;
    const following = rich.getViewportSnapshot().following;
    rich.destroy();
    return { before, after, following };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.following, false);
  assert.ok(Math.abs(result.before - result.after) <= 2, JSON.stringify(result));
});
