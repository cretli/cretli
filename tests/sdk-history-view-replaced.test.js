/**
 * A full history replay wipes live-rendered cards. The room watermark must drop with
 * them, or the next catch-up skips those agent events as "already shown".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beginSdkOpenTerminalHydration,
  finishSdkHistoryHydration,
  noteSdkHistoryViewReplaced,
  selectMissingSdkHistoryRecords,
  shouldApplySdkRoomEvent,
  syncSdkEventStream,
  takeMissingSdkHistoryRecords,
} from '../app_front/features/chat/sdkEventReplayGuard.js';
import { runRichViewScenario } from './helpers/rich-view-chromium.js';

/** @param {number} seq @param {string} [streamId] */
function sdkRecord(seq, streamId = 'room-a') {
  return {
    kind: 'sdk',
    historySeq: 100 + seq,
    eventStreamId: streamId,
    roomEventSeq: seq,
    event: { type: 'assistant', message: { content: [{ type: 'text', text: `answer ${seq}` }] } },
  };
}

test('live event wiped by a local-cache replay during hydration is fetched again', () => {
  const chat = { _sdkReplayTagged: true };
  syncSdkEventStream(chat, 'room-a');
  beginSdkOpenTerminalHydration(chat);
  // Live frame renders while IndexedDB is still being read.
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 5, eventStreamId: 'room-a' }), true);
  // The local snapshot replay clears the stream; it ends before seq 5.
  noteSdkHistoryViewReplaced(chat, [sdkRecord(3), sdkRecord(4)]);
  const missing = selectMissingSdkHistoryRecords(chat, [sdkRecord(4), sdkRecord(5)]);
  assert.deepEqual(missing.map((r) => r.roomEventSeq), [5]);
});

test('HTTP replace without the current stream drops the stale live watermark', () => {
  const chat = { _sdkReplayTagged: true };
  syncSdkEventStream(chat, 'room-new');
  beginSdkOpenTerminalHydration(chat);
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 7, eventStreamId: 'room-new' }), true);
  // The 80-record tail only has the previous room: the live answer was not flushed yet.
  const tail = [sdkRecord(40, 'room-old')];
  noteSdkHistoryViewReplaced(chat, tail);
  finishSdkHistoryHydration(chat, tail);
  const missing = takeMissingSdkHistoryRecords(chat, [sdkRecord(7, 'room-new')]);
  assert.deepEqual(missing.map((r) => r.roomEventSeq), [7]);
});

test('a replay that holds the live seqs keeps them covered', () => {
  const chat = {};
  syncSdkEventStream(chat, 'room-a');
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 6, eventStreamId: 'room-a' }), true);
  noteSdkHistoryViewReplaced(chat, [sdkRecord(5), sdkRecord(6)]);
  assert.deepEqual(selectMissingSdkHistoryRecords(chat, [sdkRecord(6)]), []);
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 6, eventStreamId: 'room-a' }), false);
  assert.equal(shouldApplySdkRoomEvent(chat, { roomEventSeq: 7, eventStreamId: 'room-a' }), true);
});

test('rich view history replay resets the room watermark to the replayed records (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'watermark', _sdkEventStreamId: 'room-a', _sdkLastRoomEventSeq: 9, _sdkHydratedRoomEventSeqByStream: { 'room-a': 9 } };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    await rich.replayHistoryRecords(
      [{ kind: 'sdk', historySeq: 1, eventStreamId: 'room-a', roomEventSeq: 4, event: { type: 'user', message: { content: [{ type: 'text', text: 'q' }] } } }],
      { instant: true, source: 'test' },
    );
    const out = { last: chat._sdkLastRoomEventSeq, byStream: chat._sdkHydratedRoomEventSeqByStream };
    rich.destroy();
    return out;
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.last, 4);
  assert.deepEqual(result.byStream, { 'room-a': 4 });
});

test('live answers the server has not flushed yet survive a history replay, once (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'carry-over', _sdkEventStreamId: 'room-a' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const tool = (id) => ({ type: 'tool_call', name: 'Bash', status: 'completed', call_id: id, args: { command: `echo ${id}` } });
    const userRec = { kind: 'sdk', historySeq: 1, eventStreamId: 'room-a', roomEventSeq: 1, event: { type: 'user', message: { content: [{ type: 'text', text: 'question' }] } } };
    const count = (needle) => mount.textContent.split(needle).length - 1;
    // Live: prompt, a persisted answer, then a tool and a final answer not flushed yet.
    rich.applyEvent(userRec.event, { roomEventSeq: 1, eventStreamId: 'room-a' });
    rich.applyEvent(answer('first part'), { roomEventSeq: 2, eventStreamId: 'room-a' });
    rich.applyEvent(tool('t1'), { roomEventSeq: 3, eventStreamId: 'room-a' });
    rich.applyEvent(answer('unflushed final answer'), { roomEventSeq: 4, eventStreamId: 'room-a' });
    await frame();
    // HTTP replace with the persisted tail only (seq 1-2).
    await rich.replayHistoryRecords([
      userRec,
      { kind: 'sdk', historySeq: 2, eventStreamId: 'room-a', roomEventSeq: 2, event: answer('first part') },
    ], { instant: true, source: 'test' });
    for (let i = 0; i < 3; i += 1) await frame();
    const afterReplace = { first: count('first part'), final: count('unflushed final answer'), last: chat._sdkLastRoomEventSeq };
    // A later replay that now holds the answer must not duplicate it.
    await rich.replayHistoryRecords([
      userRec,
      { kind: 'sdk', historySeq: 2, eventStreamId: 'room-a', roomEventSeq: 2, event: answer('first part') },
      { kind: 'sdk', historySeq: 3, eventStreamId: 'room-a', roomEventSeq: 3, event: tool('t1') },
      { kind: 'sdk', historySeq: 4, eventStreamId: 'room-a', roomEventSeq: 4, event: answer('unflushed final answer') },
    ], { instant: true, source: 'test' });
    for (let i = 0; i < 3; i += 1) await frame();
    const afterFull = { first: count('first part'), final: count('unflushed final answer') };
    // A local snapshot without stream ids cannot tell what it holds: nothing is carried.
    rich.applyEvent(answer('another live line'), { roomEventSeq: 5, eventStreamId: 'room-a' });
    await rich.replayHistoryRecords([
      { kind: 'localUser', historySeq: 1, text: 'question' },
      { kind: 'sdk', historySeq: 4, event: answer('unflushed final answer') },
    ], { instant: true, source: 'test' });
    for (let i = 0; i < 3; i += 1) await frame();
    const afterLocal = { final: count('unflushed final answer'), another: count('another live line') };
    rich.destroy();
    return { afterReplace, afterFull, afterLocal };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.afterReplace.first, 1);
  assert.equal(result.afterReplace.final, 1, `unflushed answer carried over: ${JSON.stringify(result)}`);
  assert.equal(result.afterReplace.last, 4, 'watermark covers the carried events');
  assert.deepEqual(result.afterFull, { first: 1, final: 1 });
  assert.equal(result.afterLocal.final, 1);
  assert.equal(result.afterLocal.another, 0);
});

test('carried live events render without persisting, plain buffer or read-aloud again (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const calls = { record: 0, plain: 0, speak: 0 };
    const chat = { id: 'carry-hooks', _sdkEventStreamId: 'room-a' };
    const rich = viewMod.createSdkRichView(chat, mount, {
      appendPlain() { calls.plain += 1; },
      onHistoryRecord() { calls.record += 1; },
      onAssistantText() { calls.speak += 1; },
    });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const userEvent = { type: 'user', message: { content: [{ type: 'text', text: 'question' }] } };
    rich.applyEvent(userEvent, { roomEventSeq: 1, eventStreamId: 'room-a' });
    rich.applyEvent(answer('unflushed answer'), { roomEventSeq: 2, eventStreamId: 'room-a' });
    await frame();
    const before = { ...calls };
    await rich.replayHistoryRecords([
      { kind: 'sdk', historySeq: 1, eventStreamId: 'room-a', roomEventSeq: 1, event: userEvent },
    ], { instant: true, source: 'test' });
    for (let i = 0; i < 3; i += 1) await frame();
    const shown = mount.textContent.includes('unflushed answer');
    rich.destroy();
    return { before, after: calls, shown };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.shown, true);
  assert.deepEqual(result.after, result.before, `hooks fired again: ${JSON.stringify(result)}`);
});

test('a replay superseded mid-way still leaves the live tail to the next replay (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'carry-superseded', _sdkEventStreamId: 'room-a' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const answer = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const notice = (seq) => ({ kind: 'sdk', historySeq: seq, eventStreamId: 'room-a', roomEventSeq: seq, event: answer(`old ${seq}`) });
    rich.applyEvent(answer('unflushed tail'), { roomEventSeq: 500, eventStreamId: 'room-a' });
    await frame();
    const records = [];
    for (let seq = 1; seq <= 300; seq += 1) records.push(notice(seq));
    // A: a long chunked replay; B replaces it before it finishes.
    const replayA = rich.replayHistoryRecords(records, { source: 'test' });
    await frame();
    const replayB = rich.replayHistoryRecords(records.slice(-20), { instant: true, source: 'test' });
    const [outcomeA] = await Promise.all([replayA, replayB]);
    for (let i = 0; i < 3; i += 1) await frame();
    const count = mount.textContent.split('unflushed tail').length - 1;
    rich.destroy();
    return { count, outcomeA: outcomeA?.reason };
  });
  assert.deepEqual(pageErrors, []);
  assert.notEqual(result.outcomeA, 'complete', `replay A must be superseded for this scenario: ${JSON.stringify(result)}`);
  assert.equal(result.count, 1, `live tail kept once: ${JSON.stringify(result)}`);
});

test('carried events keep the turn state in event order: a finished run stays finished (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const run = async (withFinish) => {
      const mount = document.getElementById('mount');
      const chat = { id: `carry-turn-${withFinish}`, _sdkEventStreamId: 'room-a' };
      const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
      const meta = (seq) => ({ roomEventSeq: seq, eventStreamId: 'room-a' });
      const older = { kind: 'sdk', historySeq: 1, eventStreamId: 'room-a', roomEventSeq: 1, event: { type: 'user', message: { content: [{ type: 'text', text: 'old' }] } } };
      rich.applyEvent(older.event, meta(1));
      rich.applyEvent({ type: 'user', message: { content: [{ type: 'text', text: 'new turn' }] } }, meta(2));
      rich.applyEvent({ type: 'thinking', text: 'working on it' }, meta(3));
      if (withFinish) rich.applyEvent({ type: 'status', status: 'FINISHED' }, meta(4));
      await frame();
      await rich.replayHistoryRecords([older], { instant: true, source: 'test' });
      for (let i = 0; i < 3; i += 1) await frame();
      const thinking = [...mount.querySelectorAll('cr-sdk-block')].find((el) => el.textContent.includes('working on it'));
      const out = { found: Boolean(thinking), running: thinking?.running === true };
      rich.destroy();
      return out;
    };
    return { live: await run(false), finished: await run(true) };
  });
  assert.deepEqual(pageErrors, []);
  assert.equal(result.live.found, true);
  assert.equal(result.finished.found, true);
  assert.equal(result.finished.running, false, `finished run must not spin: ${JSON.stringify(result)}`);
});

test('streamed snapshots of an answer the replay already holds are not rendered twice (Chromium)', { timeout: 180_000 }, async () => {
  const { result, pageErrors } = await runRichViewScenario(async ({ viewUrl }) => {
    const viewMod = await import(viewUrl);
    const mount = document.getElementById('mount');
    const chat = { id: 'carry-snapshots', _sdkEventStreamId: 'room-a' };
    const rich = viewMod.createSdkRichView(chat, mount, { appendPlain() {} });
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const snap = (text) => ({ type: 'assistant', streamTextMode: 'snapshot', message: { content: [{ type: 'text', text }] } });
    const userEvent = { type: 'user', message: { content: [{ type: 'text', text: 'go' }] } };
    const finalText = 'Copying the shop code to the new server.';
    rich.applyEvent(userEvent, { roomEventSeq: 1, eventStreamId: 'room-a' });
    // Live: one answer streamed as growing snapshots, room seqs 2..5.
    ['Copying', 'Copying the shop', 'Copying the shop code', finalText]
      .forEach((text, i) => rich.applyEvent(snap(text), { roomEventSeq: 2 + i, eventStreamId: 'room-a' }));
    await frame();
    // The server coalesced them into one record that keeps the first room seq.
    await rich.replayHistoryRecords([
      { kind: 'sdk', historySeq: 1, eventStreamId: 'room-a', roomEventSeq: 1, event: userEvent },
      { kind: 'sdk', historySeq: 2, eventStreamId: 'room-a', roomEventSeq: 2, event: snap(finalText) },
    ], { instant: true, source: 'test' });
    for (let i = 0; i < 3; i += 1) await frame();
    const answers = [...mount.querySelectorAll('.sdk-rich-assistant-md')].map((el) => el.textContent.trim());
    rich.destroy();
    return { answers };
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(result.answers, ['Copying the shop code to the new server.'], JSON.stringify(result));
});
