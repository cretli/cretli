import './helpers/isolated-data-dir.js';
/**
 * Car v2 sound loop: announcement diff, repeat filter, rate limit, announcer wiring,
 * read-mode restore and the car-mode fallback of the `agent` read mode.
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { dispatchEvent() {}, addEventListener() {} };
globalThis.CustomEvent = class {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const {
  announcementText, createAnnouncementScheduler, diffAgentAnnouncements, dropRepeatedAnnouncements,
} = await import('../app_front/features/car/carAnnouncements.js');
const { createCarAnnouncer, withCardKeys } = await import('../app_front/features/car/carAnnouncer.js');
const { enterCarReadMode, getReadMode, leaveCarReadMode, setReadMode } = await import('../app_front/features/voice/voicePrefs.js');
const { createChatSpeaker } = await import('../app_front/features/voice/chatSpeaker.js');
const { firstSentences } = await import('../app_front/features/voice/replyFallback.js');
const { matchLocalCommand } = await import('../app_front/features/voice/localCommands.js');

const row = (chatId, status, extra = {}) => ({
  chatId, title: `Chat ${chatId}`, workspaceFile: 'w', workspaceLabel: 'shop', status, active: false, order: 0, ...extra,
});
const translate = (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ''}`;

// Initial snapshot announces nothing, even for waiting agents.
assert.deepEqual(diffAgentAnnouncements(null, [row('a', 'needs_decision'), row('b', 'error')]), []);
assert.deepEqual(diffAgentAnnouncements(undefined, [row('a', 'done')]), []);

// Transitions.
{
  const prev = [row('a', 'working'), row('b', 'working'), row('c', 'working'), row('d', 'idle')];
  const next = [row('a', 'done'), row('b', 'error'), row('c', 'needs_decision'), row('d', 'idle'), row('e', 'needs_decision')];
  const events = diffAgentAnnouncements(prev, next);
  assert.deepEqual(events.map((e) => [e.chatId, e.kind]), [['c', 'waiting'], ['e', 'waiting'], ['b', 'error'], ['a', 'finished']]);
  // No change, no events.
  assert.deepEqual(diffAgentAnnouncements(next, next), []);
}
// A new working/done chat from nowhere is silent; the active chat finishing is covered by its own reply.
assert.deepEqual(diffAgentAnnouncements([], [row('n', 'working'), row('m', 'done')]), []);
assert.deepEqual(diffAgentAnnouncements([row('a', 'working')], [row('a', 'done', { active: true })]), []);
// A second card of an already waiting chat is news; the same card is not.
assert.equal(diffAgentAnnouncements([row('a', 'needs_decision', { cardKey: 'k1' })], [row('a', 'needs_decision', { cardKey: 'k1,k2' })]).length, 1);
assert.equal(diffAgentAnnouncements([row('a', 'needs_decision', { cardKey: 'k1' })], [row('a', 'needs_decision', { cardKey: 'k1' })]).length, 0);
// F6: removing a card is not a new card; a really new id is.
assert.equal(diffAgentAnnouncements([row('a', 'needs_decision', { cardKey: 'k1,k2' })], [row('a', 'needs_decision', { cardKey: 'k2' })]).length, 0);
assert.equal(diffAgentAnnouncements([row('a', 'needs_decision', { cardKey: 'k2' })], [row('a', 'needs_decision', { cardKey: 'k2,k3' })]).length, 1);
// Card keys come from the open cards of the chat.
assert.deepEqual(withCardKeys([row('a', 'needs_decision')], [{ id: 'z', subject: { chatId: 'a' } }, { id: 'y', subject: { chatId: 'a' } }]).map((r) => r.cardKey), ['y,z']);

// Repeat filter: the same key inside the TTL is dropped, afterwards it is news again.
{
  const recent = new Map();
  const [event] = diffAgentAnnouncements([row('a', 'working')], [row('a', 'error')]);
  assert.equal(dropRepeatedAnnouncements([event], recent, 1000).length, 1);
  assert.equal(dropRepeatedAnnouncements([event], recent, 2000).length, 0);
  assert.equal(dropRepeatedAnnouncements([event], recent, 1000 + 61000).length, 1);
}

// Texts.
{
  const event = { kind: 'waiting', key: 'k', chatId: 'a', title: 'Fix', workspace: 'shop', active: false };
  assert.equal(announcementText(event, translate), 'car.announce.waiting{"workspace":"shop","chat":"Fix"}');
  assert.equal(announcementText({ ...event, kind: 'finished' }, translate, 'All green.'), 'car.announce.replied{"workspace":"shop","chat":"Fix"} All green.');
  const plain = (key, vars) => (key.endsWith('error') ? `${vars.workspace}: ${vars.chat} failed` : key);
  assert.equal(announcementText({ ...event, kind: 'error', workspace: '' }, plain), 'Fix failed');
}

// Scheduler: one per interval, the rest merged into a count, timer releases the backlog.
{
  let clock = 100000;
  const spoken = [];
  const timers = [];
  const scheduler = createAnnouncementScheduler({
    speak: (event, more) => spoken.push([event.chatId, more]),
    now: () => clock,
    intervalMs: 5000,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer() {},
  });
  const ev = (chatId, kind) => ({ kind, key: chatId, chatId, title: chatId, workspace: '', active: false });
  scheduler.push([ev('a', 'finished')]);
  assert.deepEqual(spoken, [['a', 0]], 'first one is immediate');
  clock += 1000;
  scheduler.push([ev('b', 'finished'), ev('c', 'waiting'), ev('d', 'error')]);
  assert.equal(spoken.length, 1, 'rate limited');
  assert.equal(timers.at(-1).ms, 4000);
  clock += 4000;
  timers.at(-1).fn();
  assert.deepEqual(spoken[1], ['c', 2], 'most urgent first, two merged');
  assert.equal(scheduler.pendingCount(), 0);
}

// Announcer: snapshot first, then spoken text, repeat, switch target, reset.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function makeAnnouncer(overrides = {}) {
  const said = [];
  const state = { head: 10, replies: [] }; // replies: [{ seq, text }] written to the "server"
  const announcer = createCarAnnouncer({
    say: (text, isCurrent) => { if (isCurrent()) said.push(text); },
    translate,
    readMark: async () => state.head,
    readReplySince: async (_id, mark) => state.replies.filter((r) => r.seq > mark).at(-1)?.text || '',
    now: () => 1000,
    ...overrides,
  });
  return { announcer, said, state };
}
{
  const { announcer, said, state } = makeAnnouncer();
  assert.deepEqual(announcer.ingest([row('a', 'working')]), []);
  await tick();
  state.replies.push({ seq: 12, text: 'Tests pass.' });
  assert.equal(announcer.ingest([row('a', 'done')]).length, 1);
  await tick();
  assert.equal(said.length, 1);
  assert.match(said[0], /car\.announce\.replied.*Tests pass\./);
  assert.equal(announcer.getLast().chatId, 'a');
  announcer.repeat();
  assert.equal(said[1], said[0]);
  announcer.reset();
  assert.equal(announcer.getLast(), null);
  assert.match(announcer.repeat().message, /car\.announce\.nothing/);
}

// F1/F4: a reply from before the run is never read; consecutive runs get their own mark.
{
  const { announcer, said, state } = makeAnnouncer();
  state.replies.push({ seq: 5, text: 'Old answer.' });
  announcer.ingest([row('b', 'working')]);
  await tick();
  announcer.ingest([row('b', 'done')]);
  await tick();
  assert.match(said.at(-1), /car\.announce\.finished/);
  assert.equal(said.at(-1).includes('Old answer.'), false, 'stale reply');
  // Second run: a new mark is taken when the chat starts working again (60 s later, past the repeat TTL).
  let clock = 1000;
  const second = makeAnnouncer({ now: () => clock });
  second.state.replies.push({ seq: 5, text: 'Run one.' });
  second.announcer.ingest([row('c', 'working')]);
  await tick();
  second.state.head = 20;
  second.state.replies.push({ seq: 15, text: 'Run one reply.' });
  second.announcer.ingest([row('c', 'done')]);
  await tick();
  assert.match(second.said.at(-1), /Run one reply\./);
  clock += 120000;
  second.state.head = 30; // run two starts at head 30
  second.announcer.ingest([row('c', 'working')]);
  await tick();
  second.announcer.ingest([row('c', 'done')]);
  await tick();
  assert.equal(second.said.at(-1).includes('Run one reply.'), false, 'run two must not read run one');
}
// F4: a slow mark read finishing after the announcement is requested still decides correctly.
{
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { announcer, said, state } = makeAnnouncer({ readMark: async () => { await gate; return 10; } });
  state.replies.push({ seq: 11, text: 'Fresh.' });
  announcer.ingest([row('d', 'working')]);
  announcer.ingest([row('d', 'done')]);
  release();
  await tick();
  await tick();
  assert.match(said.at(-1), /Fresh\./);
  // No mark at all (read failed): only the news, never a reply.
  const unknown = makeAnnouncer({ readMark: async () => null });
  unknown.state.replies.push({ seq: 99, text: 'Maybe stale.' });
  unknown.announcer.ingest([row('e', 'working')]);
  await tick();
  unknown.announcer.ingest([row('e', 'done')]);
  await tick();
  assert.equal(unknown.said.at(-1).includes('Maybe stale.'), false);
}

// F3: closing the view silences announcements pending in the scheduler, in async reads and in the speech queue.
{
  let cancelled = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { announcer, said } = makeAnnouncer({
    cancelSpeech: () => { cancelled += 1; },
    readReplySince: async () => { await gate; return 'Late.'; },
  });
  announcer.ingest([row('f', 'working')]);
  await tick();
  announcer.ingest([row('f', 'done')]);
  await tick();
  announcer.reset(); // view closed while the reply was loading
  assert.equal(cancelled, 1);
  release();
  await tick();
  assert.deepEqual(said, [], 'nothing spoken after close');
  // Quick close/open: the new session does not inherit the old one's pending announcement.
  announcer.ingest([row('f', 'working')]);
  announcer.reset();
  announcer.ingest([row('f', 'working')]);
  assert.deepEqual(announcer.ingest([row('f', 'done')]).length, 1, 'fresh session announces on its own');
  // The view closes (without a reset) while the reply loads: still silent.
  let open = true;
  let free;
  const slow = new Promise((resolve) => { free = resolve; });
  const closed = makeAnnouncer({ isOpen: () => open, readReplySince: async () => { await slow; return 'Late.'; } });
  closed.announcer.ingest([row('g', 'working')]);
  await tick();
  closed.announcer.ingest([row('g', 'done')]);
  open = false;
  free();
  await tick();
  await tick();
  assert.deepEqual(closed.said, []);
}
// The speaker/queue side: only tagged announcements are dropped.
{
  const played = [];
  const tagged = [];
  const speaker = createChatSpeaker({
    queue: {
      enqueue: (text, tag) => played.push([text, tag || '']),
      cancel() {},
      isBusy: () => false,
      cancelTagged: (tag) => tagged.push(tag),
    },
  });
  speaker.speakAnnouncement('Shop: Fix is waiting');
  speaker.cancelAnnouncements();
  assert.deepEqual(played, [['Shop: Fix is waiting', 'car-announce']]);
  assert.deepEqual(tagged, ['car-announce']);
}
// Speech queue: cancelTagged drops queued announcements and stops a playing one, never untagged speech.
{
  const { createSpeechQueue } = await import('../app_front/features/voice/speechQueue.js');
  const spoken = [];
  const live = [];
  globalThis.window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.window.speechSynthesis = {
    speak: (utterance) => { spoken.push(utterance.text); live.push(utterance); },
    cancel: () => { while (live.length) live.shift().onerror?.({ error: 'canceled' }); },
  };
  const queue = createSpeechQueue({ getEngineId: () => 'browser', getLang: () => 'en-US', getRate: () => 1, getVoiceName: () => '' });
  queue.enqueue('Answer.');
  queue.enqueue('News one.', 'car-announce');
  queue.enqueue('News two.', 'car-announce');
  queue.cancelTagged('car-announce');
  live.shift().onend();
  await tick();
  assert.deepEqual(spoken, ['Answer.'], 'queued announcements dropped, the answer was kept');
  // A playing announcement is stopped; what is queued behind it (untagged) still plays.
  queue.enqueue('News three.', 'car-announce');
  await tick();
  queue.enqueue('Next answer.');
  queue.cancelTagged('car-announce');
  await tick();
  assert.deepEqual(spoken.slice(1), ['News three.', 'Next answer.']);
  live.shift()?.onend();
  await tick();
  assert.equal(queue.isBusy(), false);
  delete globalThis.window.speechSynthesis;
}

// F3 (round 3): a paid engine that rejects after a cancel must not fall back to the browser voice.
{
  const { createSpeechQueue } = await import('../app_front/features/voice/speechQueue.js');
  const make = () => {
    const log = [];
    const pendingCalls = [];
    const remote = {
      id: 'openai', isAvailable: () => true,
      speak: (u) => new Promise((resolve, reject) => { log.push(`openai:${u.text}`); pendingCalls.push({ resolve, reject }); }),
      cancel: () => { log.push('openai:cancel'); pendingCalls.shift()?.reject(new Error('Audio playback failed')); },
    };
    const browser = {
      id: 'browser', isAvailable: () => true,
      speak: async (u) => { log.push(`browser:${u.text}`); },
      cancel() {},
    };
    const queue = createSpeechQueue({
      getEngineId: () => 'openai', getLang: () => 'en-US', getRate: () => 1, getVoiceName: () => '',
      resolveEngine: (id) => (id === 'openai' ? remote : browser),
      onError: () => log.push('onError'),
    });
    return { queue, log, pendingCalls };
  };
  // Tagged cancel of the playing announcement: silence, the untagged answer behind it still plays.
  {
    const { queue, log, pendingCalls } = make();
    queue.enqueue('News.', 'car-announce');
    await tick();
    queue.enqueue('Answer.');
    queue.cancelTagged('car-announce');
    await tick();
    assert.equal(log.includes('browser:News.'), false, 'no fallback for the cancelled announcement');
    assert.equal(log.includes('onError'), false);
    assert.ok(log.includes('openai:Answer.'));
    pendingCalls.shift()?.resolve();
    await tick();
    assert.equal(queue.isBusy(), false);
  }
  // Plain cancel: no fallback either.
  {
    const { queue, log } = make();
    queue.enqueue('Answer.');
    await tick();
    queue.cancel();
    await tick();
    assert.deepEqual(log.filter((entry) => entry.startsWith('browser:')), []);
  }
  // A real engine failure on an item nobody cancelled still falls back.
  {
    const { queue, log, pendingCalls } = make();
    queue.enqueue('Answer.');
    await tick();
    pendingCalls.shift().reject(new Error('rate limited'));
    await tick();
    assert.ok(log.includes('browser:Answer.'), 'fallback for a real failure');
    assert.ok(log.includes('onError'));
  }
}

// F1: server reader picks the newest voice_reply after the mark, ignores older ones.
{
  const { readHeadSeq, readShortReplySince } = await import('../app_front/features/car/carShortReply.js');
  const reply = (seq, text) => ({ seq, rec: { kind: 'meta', variant: 'voiceReply', payload: JSON.stringify({ text, turn: `t${seq}` }) } });
  const fetchHistory = async (_id, query) => (query.tail === 1
    ? { ok: true, headSeq: 42, events: [] }
    : { ok: true, headSeq: 42, events: [reply(5, 'old'), { seq: 6, rec: { kind: 'meta', variant: 'x' } }, reply(30, 'first new'), reply(40, 'newest')] });
  assert.equal(await readHeadSeq('c', fetchHistory), 42);
  assert.equal(await readHeadSeq('c', async () => { throw new Error('x'); }), null);
  assert.equal(await readShortReplySince('c', 20, fetchHistory), 'newest');
  assert.equal(await readShortReplySince('c', 40, fetchHistory), '', 'nothing after the mark');
  assert.equal(await readShortReplySince('c', null, fetchHistory), '', 'unknown mark reads nothing');
  assert.equal(await readShortReplySince('c', 1, async () => { throw new Error('x'); }), '');
}

// Read mode: car mode switches to agent and leaving restores the previous mode (also across reloads).
{
  setReadMode('stream');
  enterCarReadMode();
  assert.equal(getReadMode(), 'agent');
  enterCarReadMode();
  assert.equal(store.get('cretli-car-prev-read-mode') || localStorage.getItem('cretli-car-prev-read-mode'), 'stream', 'second enter keeps the first mode');
  leaveCarReadMode();
  assert.equal(getReadMode(), 'stream');
  leaveCarReadMode();
  assert.equal(getReadMode(), 'stream', 'leaving twice is a no-op');
  setReadMode('off');
  enterCarReadMode();
  leaveCarReadMode();
  assert.equal(getReadMode(), 'off');
  // F5: a manual change inside car mode wins over the remembered mode.
  setReadMode('stream');
  enterCarReadMode();
  setReadMode('final');
  leaveCarReadMode();
  assert.equal(getReadMode(), 'final');
  assert.equal(localStorage.getItem('cretli-car-prev-read-mode') || '', '', 'remembered mode dropped');
  // F5: re-entry after a reload (still `agent`) keeps the remembered mode, even twice.
  setReadMode('stream');
  enterCarReadMode();
  enterCarReadMode();
  leaveCarReadMode();
  assert.equal(getReadMode(), 'stream');
  // A reload after a manual change must not restore the stale remembered mode on the next exit.
  setReadMode('stream');
  enterCarReadMode();
  setReadMode('off');
  enterCarReadMode();
  leaveCarReadMode();
  assert.equal(getReadMode(), 'off');
}

// Fallback: no voice_reply -> opening of the answer, only in car mode.
{
  assert.equal(firstSentences('One. Two. Three.'), 'One. Two.');
  assert.equal(firstSentences('No punctuation here'), 'No punctuation here');
  assert.equal(firstSentences(''), '');
  assert.ok(firstSentences('x '.repeat(400)).length <= 280);
  for (const carMode of [true, false]) {
    setReadMode('agent');
    const spoken = [];
    const speaker = createChatSpeaker({
      queue: { enqueue: (text) => spoken.push(text), cancel() {}, isBusy: () => false },
      isCarMode: () => carMode,
    });
    speaker.issueVoiceTurn('c1', 't1');
    speaker.handleAssistantText('First point. Second point. Third point.', 'c1');
    speaker.endAnswer('c1');
    assert.deepEqual(spoken, carMode ? ['First point. Second point.'] : []);
  }
  // F2: an empty next run reads nothing, not the previous answer.
  {
    setReadMode('agent');
    const spoken = [];
    const speaker = createChatSpeaker({
      queue: { enqueue: (text) => spoken.push(text), cancel() {}, isBusy: () => false },
      isCarMode: () => true,
    });
    speaker.issueVoiceTurn('c2', 't1');
    speaker.handleAssistantText('Answer A. More A.', 'c2');
    speaker.endAnswer('c2');
    assert.deepEqual(spoken, ['Answer A. More A.']);
    speaker.issueVoiceTurn('c2', 't2');
    speaker.endAnswer('c2'); // cancelled / empty run
    assert.deepEqual(spoken, ['Answer A. More A.'], 'no fallback from the previous answer');
  }
  const queued = [];
  const speaker = createChatSpeaker({ queue: { enqueue: (text) => queued.push(text), cancel() {}, isBusy: () => false } });
  speaker.speakAnnouncement('  Shop: Fix is waiting  ');
  speaker.speakAnnouncement('   ');
  assert.deepEqual(queued, ['Shop: Fix is waiting']);
}

// Commands.
assert.deepEqual(matchLocalCommand('co nowego?').action, 'whats_new');
assert.equal(matchLocalCommand("What's new").action, 'whats_new');
assert.equal(matchLocalCommand('Powtórz').action, 'whats_new');
assert.equal(matchLocalCommand('repeat').action, 'whats_new');
assert.deepEqual(matchLocalCommand('przełącz').args, { announced: true });
assert.equal(matchLocalCommand('switch').action, 'switch_agent');
assert.equal(matchLocalCommand('powtórz test dla modułu auth'), null, 'a sentence is a prompt');

console.log('car-announcements: ok');
