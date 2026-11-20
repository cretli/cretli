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
  rich.scrollToBottom();
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

test('a user scrolling up mid-stream is not pulled back down (Chromium)', { timeout: 180_000 }, async () => {
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
    rich.scrollToBottom();
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
    rich.scrollToBottom();
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
