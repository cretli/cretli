/**
 * Live turn vs the mounted history window: agent replies must never vanish while the
 * user's own prompt stays on screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } from '../app_front/lib/uiFreezeRenderBudgets.js';
import { runRichViewScenario } from './helpers/rich-view-chromium.js';

/**
 * Shared page-side setup: a full window of notices, then a live turn.
 * Stringified into the page, so it must stay self-contained.
 */
const LIVE_TURN_SCENARIO = async ({ viewUrl, parkingUrl, args }) => {
  const viewMod = await import(viewUrl);
  const parking = await import(parkingUrl);
  const mount = document.getElementById('mount');
  const notice = (seq) => ({
    kind: 'meta',
    variant: 'notice',
    historySeq: seq,
    payload: `notice ${seq}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  });
  const chat = { id: `live-turn-${args.scrollTo}` };
  const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
  const harness = rich.mountedWindowHarness;
  const cap = args.cap;
  const records = [];
  for (let seq = 1; seq <= cap; seq += 1) records.push(notice(seq));
  await rich.replayHistoryRecords(records, { instant: true, source: 'test' });
  harness.enforceMountedHistoryWindowBudget();
  mount.scrollTop = args.scrollTo === 'top' ? 0 : mount.scrollHeight;
  // The bug: stick is lost (keyboard, address bar, 64px threshold) while the user
  // is still looking at the bottom of the chat.
  rich.appendUserPrompt('please answer', { silent: true });
  // Sending re-pins the view; the bug starts when stick is lost right after (keyboard
  // closing, address bar, a 64px threshold) while the user still looks at the bottom.
  if (args.scrollTo === 'top') mount.scrollTop = 0;
  harness.setStickToBottom(false);
  const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-live' });
  rich.applyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here is the answer.' }] } }, meta(cap + 1));
  rich.applyEvent(
    { type: 'tool_call', name: 'Bash', status: 'running', call_id: 'toolu_live', args: { command: 'ls' } },
    meta(cap + 2),
  );
  rich.applyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Second answer.' }] } }, meta(cap + 3));
  const stream = harness.getRealStream();
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await frame();
  const snapshot = () => {
    const cards = [...stream.children];
    const userIndex = cards.findIndex((el) => el.textContent.includes('please answer'));
    const answerIndex = cards.findIndex((el) => el.textContent.includes('Here is the answer.'));
    const secondIndex = cards.findIndex((el) => el.textContent.includes('Second answer.'));
    return { userIndex, answerIndex, secondIndex, last: cards.length - 1 };
  };
  const live = snapshot();
  const parkedLive = parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
  // Scrolling back to the bottom must bring every parked answer back in order.
  mount.scrollTop = mount.scrollHeight;
  harness.setStickToBottom(true);
  await harness.restoreParkedNewerTailIfNeeded();
  await frame();
  const restored = snapshot();
  rich.destroy();
  return { live, parkedLive, restored };
};

test('live answers stay visible after the user prompt when stick is lost at the bottom (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(LIVE_TURN_SCENARIO, {
    args: { cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP, scrollTo: 'bottom' },
  });
  assert.deepEqual(pageErrors, []);
  const { live } = result;
  assert.ok(live.userIndex >= 0, 'user prompt is mounted');
  assert.ok(live.answerIndex > live.userIndex, `first answer must follow the prompt: ${JSON.stringify(live)}`);
  assert.ok(live.secondIndex > live.answerIndex, `second answer must be mounted: ${JSON.stringify(live)}`);
  assert.deepEqual(result.parkedLive, [], 'cards in view must not be parked');
});

test('answers parked while the user reads older history come back after the prompt (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(LIVE_TURN_SCENARIO, {
    args: { cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP, scrollTo: 'top' },
  });
  assert.deepEqual(pageErrors, []);
  const { live, restored } = result;
  // Never a window that ends with the prompt while its answers are parked behind it.
  if (live.answerIndex < 0) {
    assert.ok(live.userIndex < 0 || live.userIndex === live.last, `prompt must not sit above a gap: ${JSON.stringify(live)}`);
  }
  assert.ok(restored.userIndex >= 0, `prompt restored: ${JSON.stringify(restored)}`);
  assert.ok(restored.answerIndex > restored.userIndex, `answer restored after prompt: ${JSON.stringify(restored)}`);
  assert.ok(restored.secondIndex > restored.answerIndex, `second answer restored: ${JSON.stringify(restored)}`);
});

test('an evicted answer built from several stream records comes back whole (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl, parkingUrl, args }) => {
    const viewMod = await import(viewUrl);
    const parking = await import(parkingUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'merged-answer' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const harness = rich.mountedWindowHarness;
    const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-merge' });
    rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }, meta(1));
    // Snapshot-style assistant events: the second one grows the card the first opened.
    rich.applyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }, meta(2));
    rich.applyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from the agent' }] } }, meta(3));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const stream = harness.getRealStream();
    const before = stream.textContent.includes('Hello from the agent');
    harness.setStickToBottom(false);
    // Park the two newest cards (the answer and its prompt) as a tail eviction would.
    harness.evictTailCards(2);
    const parked = parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
    harness.setStickToBottom(true);
    await harness.restoreParkedNewerTailIfNeeded();
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const after = stream.textContent.includes('Hello from the agent');
    rich.destroy();
    return { before, parked, after, args };
  }, { args: { cap: UI_FREEZE_CHAT_MOUNTED_RECORD_CAP } });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.before, true);
  assert.deepEqual(result.parked, [1, 2, 3], 'every record merged into the card is parked');
  assert.equal(result.after, true, 'restored answer keeps its full text');
});

test('an older answer record inserted out of order is not tied to the live answer card (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl, parkingUrl }) => {
    const viewMod = await import(viewUrl);
    const parking = await import(parkingUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'isolated-link' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const harness = rich.mountedWindowHarness;
    const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const user = (text) => ({ type: 'user', message: { content: [{ type: 'text', text }] } });
    const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-iso' });
    rich.applyEvent(user('first question'), meta(10));
    rich.applyEvent(answer('first answer'), meta(11));
    rich.applyEvent(user('second question'), meta(20));
    rich.applyEvent(answer('live answer'), meta(21));
    // A recovered snapshot of the first answer arrives late and lands in the older card.
    harness.applyHistoryRecord({ kind: 'sdk', historySeq: 12, roomEventSeq: 12, eventStreamId: 'room-iso', event: answer('first answer, completed') });
    harness.setStickToBottom(false);
    harness.evictTailCards(1);
    const parked = parking.getHistoryParkedNewerLocal(chat).map((r) => r.historySeq);
    rich.destroy();
    return { parked };
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result.parked, [21], `only the live answer's own record is parked: ${JSON.stringify(result)}`);
});
