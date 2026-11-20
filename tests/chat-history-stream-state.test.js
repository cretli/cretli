/**
 * Stream accumulator state in the rich view: an answer must not be swallowed by earlier
 * thinking, and paging older history mid-run must not corrupt the live answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runRichViewScenario } from './helpers/rich-view-chromium.js';

test('an answer that repeats earlier thinking after a tool call is still rendered (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'overlap' }, mount, { appendPlain() {} });
    const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-overlap' });
    const answer = 'The fix is to change foo in bar.js and rerun the tests';
    rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'fix it' }] } }, meta(1));
    rich.applyEvent({ type: 'thinking', text: `Plan: ${answer}` }, meta(2));
    rich.applyEvent(
      { type: 'tool_call', name: 'Bash', status: 'completed', call_id: 'toolu_1', args: { command: 'ls' } },
      meta(3),
    );
    rich.applyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }, meta(4));
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const md = [...mount.querySelectorAll('.sdk-rich-assistant-md')].map((el) => el.textContent.trim());
    rich.destroy();
    return { md, answer };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.md.some((text) => text.includes(result.answer)), `answer card missing: ${JSON.stringify(result.md)}`);
});

test('paging older history during a live answer keeps the streamed text (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'prepend-live' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const meta = (seq) => ({ historySeq: seq, roomEventSeq: seq, eventStreamId: 'room-prepend' });
    const delta = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, delta: true });
    await rich.replayHistoryRecords(
      [{ kind: 'sdk', historySeq: 50, event: { type: 'user', message: { content: [{ type: 'text', text: 'go' }] } } }],
      { instant: true, source: 'test' },
    );
    // Delta-style live answer: each event carries only the new text.
    rich.applyEvent(delta('Part one.'), meta(51));
    rich.applyEvent(delta(' Part two.'), meta(52));
    await rich.prependHistoryRecords([
      { kind: 'localUser', historySeq: 10, text: 'older question' },
      { kind: 'sdk', historySeq: 11, event: { type: 'thinking', text: 'older thinking Part three.' } },
      { kind: 'sdk', historySeq: 12, event: { type: 'assistant', message: { content: [{ type: 'text', text: 'older answer' }] } } },
    ]);
    rich.applyEvent(delta(' Part three.'), meta(53));
    await frame();
    const md = [...mount.querySelectorAll('.sdk-rich-assistant-md')].map((el) => el.textContent.trim());
    rich.destroy();
    return { md };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(
    result.md.some((text) => text.includes('Part one. Part two. Part three.')),
    `live answer corrupted: ${JSON.stringify(result.md)}`,
  );
  assert.ok(result.md.some((text) => text.includes('older answer')), 'older page rendered');
});

test('an older page groups consecutive tool calls into one Activity card (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'older-tools' }, mount, { appendPlain() {} });
    const rec = (seq, event) => ({ kind: 'sdk', historySeq: seq, eventStreamId: 'room-t', roomEventSeq: seq, event });
    const tool = (id, status) => ({ type: 'tool_call', name: 'shell', status, call_id: id, args: { command: `echo ${id}` } });
    await rich.replayHistoryRecords([rec(100, { type: 'user', message: { content: [{ type: 'text', text: 'latest' }] } })], { instant: true, source: 'test' });
    const page = [rec(1, { type: 'user', message: { content: [{ type: 'text', text: 'older' }] } })];
    let seq = 2;
    for (let i = 0; i < 4; i += 1) {
      page.push(rec(seq++, tool(`t${i}`, 'running')));
      page.push(rec(seq++, { type: 'context_usage', used: 10 }));
      page.push(rec(seq++, tool(`t${i}`, 'completed')));
    }
    await rich.prependHistoryRecords(page);
    const activity = [...mount.querySelectorAll('.sdk-compact-activity-block')]
      .filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
    const spinning = mount.querySelectorAll('.mdi-spin').length;
    rich.destroy();
    return { activityCards: activity.length, spinning };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.activityCards, 1, `one Activity card for the older turn: ${JSON.stringify(result)}`);
  assert.equal(result.spinning, 0);
});

test('after a reconnect a new answer does not continue inside an older answer block (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'reset-new-answer' }, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const meta = (seq) => ({ roomEventSeq: seq, eventStreamId: 'room-r' });
    const snap = (text) => ({ type: 'assistant', streamTextMode: 'snapshot', message: { content: [{ type: 'text', text }] } });
    rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'deploy it' }] } }, meta(1));
    rich.applyEvent(snap('Copying the shop code.'), meta(2));
    await frame();
    // WS hello after a reconnect, then a status-like notice that does not end the answer.
    rich.onStreamReset();
    rich.appendMetaNotice('[Claude] Background tasks still running: 1.');
    for (const text of ['Shop', 'Shop started', 'Shop started on Node 24.']) rich.applyEvent(snap(text), meta(10));
    await frame();
    const answers = [...mount.querySelectorAll('.sdk-rich-assistant-md')].map((el) => el.textContent.trim());
    rich.destroy();
    return { answers };
  });
  assert.deepEqual(pageErrors, []);
  assert.ok(result.answers.includes('Copying the shop code.'), `old answer untouched: ${JSON.stringify(result)}`);
  assert.ok(result.answers.includes('Shop started on Node 24.'), `new answer in its own block: ${JSON.stringify(result)}`);
});

test('a saved answer arriving again after its live snapshots does not add a second card (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const rich = viewMod.createSdkRichView({ id: 'dup-answer' }, mount, { appendPlain() {} });
    const harness = rich.mountedWindowHarness;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const snap = (text) => ({ type: 'assistant', streamTextMode: 'snapshot', message: { content: [{ type: 'text', text }] } });
    const finalText = 'Copying the shop code to the new server, about 700 MB.';
    rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'go' }] } }, { roomEventSeq: 1, eventStreamId: 'room-d' });
    ['Copying', 'Copying the shop code', finalText]
      .forEach((text, i) => rich.applyEvent(snap(text), { roomEventSeq: 2 + i, eventStreamId: 'room-d' }));
    rich.applyEvent({ type: 'tool_call', name: 'Bash', status: 'completed', call_id: 'u1', args: { command: 'ls' } }, { roomEventSeq: 5, eventStreamId: 'room-d' });
    rich.appendMetaNotice('[Claude] Background tasks still running: 1.');
    // The saved record of the same answer comes back through a catch-up.
    harness.applyHistoryRecord({ kind: 'sdk', historySeq: 625, event: snap(finalText), createdAt: '2026-11-18T22:06:20.000Z' });
    await frame();
    const answers = [...mount.querySelectorAll('.sdk-rich-assistant-md')].map((el) => el.textContent.trim());
    rich.destroy();
    return { answers };
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result.answers, ['Copying the shop code to the new server, about 700 MB.'], JSON.stringify(result));
});
