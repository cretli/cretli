import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SEND_UNDO_MS, createSendUndoWindow } from '../app_front/features/voice/sendUndoWindow.js';
import { createStopHold } from '../app_front/features/car/carStopHold.js';

/** A manual clock: timers fire only when the test advances time. */
function makeClock() {
  let time = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) { timers.delete(id); timer.fn(); }
      }
    },
    pendingTimers: () => timers.size,
  };
}

function makeWindow(extra = {}) {
  const clock = makeClock();
  const sent = [];
  const changes = [];
  const win = createSendUndoWindow({
    ...clock,
    onSend: (pending) => { sent.push(pending); return { ok: true }; },
    onChange: (pending, reason) => changes.push(reason),
    ...extra,
  });
  return { clock, win, sent, changes };
}

test('the default window is about five seconds', () => {
  assert.equal(DEFAULT_SEND_UNDO_MS, 5000);
});

test('a prompt is sent only after the window closes, to the chat remembered at begin()', () => {
  const { clock, win, sent } = makeWindow();
  win.begin({ text: 'run the tests', chatId: 'c1', chatTitle: 'Shop' });
  clock.advance(4999);
  assert.equal(sent.length, 0);
  assert.equal(win.remainingMs(), 1);
  clock.advance(1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'c1');
  assert.equal(sent[0].text, 'run the tests');
  assert.equal(win.getPending(), null);
});

test('cancel inside the window sends nothing', () => {
  const { clock, win, sent } = makeWindow();
  win.begin({ text: 'oops', chatId: 'c1' });
  clock.advance(2000);
  assert.equal(win.cancel().text, 'oops');
  clock.advance(10000);
  assert.equal(sent.length, 0);
  assert.equal(clock.pendingTimers(), 0);
  assert.equal(win.cancel(), null, 'nothing left to cancel');
});

test('sendNow sends once and the timer does not send again', async () => {
  const { clock, win, sent } = makeWindow();
  win.begin({ text: 'go', chatId: 'c1' });
  const result = await win.sendNow();
  assert.deepEqual(result, { ok: true });
  clock.advance(10000);
  assert.equal(sent.length, 1);
  assert.equal(await win.sendNow(), null);
});

test('a follow-up for the same chat is merged and restarts the countdown', () => {
  const { clock, win, sent } = makeWindow();
  win.begin({ text: 'add a test', chatId: 'c1' });
  clock.advance(3000);
  win.begin({ text: 'for the parser', chatId: 'c1' });
  clock.advance(3000);
  assert.equal(sent.length, 0, 'the merge restarted the window');
  clock.advance(2000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'add a test for the parser');
});

test('a prompt for another chat replaces the old one instead of mixing them', () => {
  const { clock, win, sent, changes } = makeWindow();
  win.begin({ text: 'first', chatId: 'c1' });
  win.begin({ text: 'second', chatId: 'c2' });
  assert.equal(changes.at(-1), 'replace');
  clock.advance(5000);
  assert.deepEqual(sent.map((entry) => [entry.chatId, entry.text]), [['c2', 'second']]);
});

test('hold pauses the countdown (read-back playing); release grants a full window', () => {
  const { clock, win, sent } = makeWindow();
  win.begin({ text: 'hello', chatId: 'c1' });
  clock.advance(1000);
  win.hold();
  assert.equal(win.getPending().held, true);
  clock.advance(60000);
  assert.equal(sent.length, 0, 'no send while the read-back plays');
  assert.equal(win.remainingMs(), DEFAULT_SEND_UNDO_MS);
  win.release();
  clock.advance(4999);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(sent.length, 1);
});

test('empty text never opens a window; windowMs is configurable', () => {
  const { clock, win, sent } = makeWindow({ windowMs: 1200 });
  win.begin({ text: '   ', chatId: 'c1' });
  assert.equal(win.getPending(), null);
  win.begin({ text: 'short', chatId: 'c1' });
  clock.advance(1200);
  assert.equal(sent.length, 1);
});

test('stop hold: a full hold stops, an early release does not', () => {
  const clock = makeClock();
  const stops = [];
  const phases = [];
  const hold = createStopHold({ ...clock, onStop: () => stops.push(1), onChange: (phase) => phases.push(phase) });
  hold.press();
  clock.advance(500);
  hold.release();
  clock.advance(5000);
  assert.equal(stops.length, 0, 'a short tap or early release never stops');
  assert.equal(hold.getPhase(), 'idle');
  hold.press();
  hold.press(); // key repeat
  clock.advance(999);
  assert.equal(stops.length, 0);
  clock.advance(1);
  assert.equal(stops.length, 1);
  assert.equal(hold.getPhase(), 'idle');
  assert.deepEqual(phases, ['holding', 'idle', 'holding', 'idle']);
});

test('stop hold: assistive activation arms, a second one confirms inside the window only', () => {
  const clock = makeClock();
  const stops = [];
  const hold = createStopHold({ ...clock, onStop: () => stops.push(1) });
  hold.activate();
  assert.equal(hold.getPhase(), 'armed');
  assert.equal(stops.length, 0);
  clock.advance(3000);
  assert.equal(hold.getPhase(), 'idle', 'the arming expired');
  hold.activate();
  hold.activate();
  assert.equal(stops.length, 1);
  assert.equal(hold.getPhase(), 'idle');
});

test('S3: a hold that is never released expires after maxHoldMs and the countdown resumes', () => {
  const { clock, win, sent } = makeWindow({ maxHoldMs: 4000 });
  win.begin({ text: 'stuck tts', chatId: 'c1' });
  win.hold();
  clock.advance(3999);
  assert.equal(win.getPending().held, true);
  clock.advance(1);
  assert.equal(win.getPending().held, false);
  clock.advance(5000);
  assert.equal(sent.length, 1);
});

test('S5: replacing a pending prompt reports the previous one', () => {
  const previousSeen = [];
  const { win } = makeWindow({ onChange: (pending, reason, previous) => { if (reason === 'replace') previousSeen.push(previous.chatTitle); } });
  win.begin({ text: 'a', chatId: 'c1', chatTitle: 'Shop' });
  win.begin({ text: 'b', chatId: 'c2', chatTitle: 'Blog' });
  assert.deepEqual(previousSeen, ['Shop']);
});

test('FU4: a queued read-back keeps the window shut past the normal hold limit; the limit restarts when speech starts', () => {
  const { clock, win, sent } = makeWindow({ maxHoldMs: 15000, maxQueueHoldMs: 60000 });
  win.begin({ text: 'queued', chatId: 'c1' });
  win.hold({ queued: true });
  clock.advance(40000); // a long answer is still being read
  assert.equal(win.getPending().held, true);
  assert.equal(sent.length, 0);
  win.hold(); // the read-back itself starts: the limit counts from here
  clock.advance(14999);
  assert.equal(win.getPending().held, true);
  assert.equal(sent.length, 0);
  clock.advance(1);
  assert.equal(win.getPending().held, false, 'failsafe from the start of the read-back');
  clock.advance(5000);
  assert.equal(sent.length, 1);
});

test('FU4: a queued hold that never gets speech still expires at the queue limit', () => {
  const { clock, win, sent } = makeWindow({ maxQueueHoldMs: 30000 });
  win.begin({ text: 'muted', chatId: 'c1' });
  win.hold({ queued: true });
  clock.advance(30000);
  clock.advance(5000);
  assert.equal(sent.length, 1);
});

test('F5: the real speech queue reports the start of each item, so the hold restarts at the read-back', async () => {
  const { createSpeechQueue } = await import('../app_front/features/voice/speechQueue.js');
  const finishers = [];
  const states = [];
  const queue = createSpeechQueue({
    getEngineId: () => 'fake',
    getLang: () => 'en-US',
    getRate: () => 1,
    getVoiceName: () => '',
    onStateChange: (speaking) => states.push(speaking),
    resolveEngine: () => ({
      id: 'fake',
      speak: (utterance) => new Promise((resolve) => finishers.push({ text: utterance.text, resolve })),
      cancel: () => {},
    }),
  });
  const { clock, win, sent } = makeWindow({ maxHoldMs: 15000, maxQueueHoldMs: 60000 });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  win.begin({ text: 'queued', chatId: 'c1' });
  queue.enqueue('A very long answer.'); // already playing: the drain started
  await tick();
  win.hold({ queued: true });
  queue.enqueue('Sending to Shop in five seconds.', 'car-announce', { onStart: () => win.hold() });
  await tick();
  assert.equal(finishers.length, 1, 'read-back waits behind the answer');
  clock.advance(40000);
  assert.equal(win.getPending().held, true);
  finishers.shift().resolve(); // the answer ends, the read-back starts
  await tick();
  assert.equal(finishers.length, 1);
  clock.advance(14999);
  assert.equal(win.getPending().held, true, 'limit counts from the real read-back start');
  clock.advance(1);
  assert.equal(win.getPending().held, false);
  clock.advance(5000);
  assert.equal(sent.length, 1);
  finishers.shift().resolve();
  await tick();
  assert.deepEqual(states, [true, false]);
});
