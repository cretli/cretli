/**
 * Per-chat/per-turn "no spoken version" hint (the send bar's handler) and the manual
 * "listen to the short version" action.
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
class FakeWindow {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) || []), fn]); }
  dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
}
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const win = new FakeWindow();
globalThis.window = win;

const { createChatSpeaker } = await import('../app_front/features/voice/chatSpeaker.js');
const { createVoiceReplyHint } = await import('../app_front/features/voice/voiceReplyHint.js');

function setup(loadLastVoiceReply) {
  localStorage.setItem('cretli-voice-read-mode', 'agent');
  const spoken = [];
  const speaker = createChatSpeaker({
    queue: { enqueue: (t) => spoken.push(t), cancel() {}, isBusy: () => false },
    ...(loadLastVoiceReply ? { loadLastVoiceReply } : {}),
  });
  const bars = {};
  for (const chatId of ['X', 'Y']) {
    const bar = { changes: 0 };
    bar.hint = createVoiceReplyHint({ getChatId: () => chatId, onChange: () => { bar.changes += 1; }, speaker, target: win });
    bars[chatId] = bar;
  }
  return { speaker, spoken, bars };
}

// A hint in chat X does not mark chat Y; the click reads the flagged turn's answer.
{
  const { speaker, spoken, bars } = setup();
  speaker.issueVoiceTurn('X', 'A');
  speaker.handleAssistantText('Full answer of A. ', 'X');
  speaker.endAnswer('X');
  assert.equal(bars.X.hint.isMissing(), true);
  assert.equal(bars.Y.hint.isMissing(), false);
  assert.equal(bars.Y.changes, 0);
  assert.equal(bars.Y.hint.handleClick(), false, 'chat Y click is not consumed');
  assert.equal(bars.X.hint.handleClick(), true);
  assert.deepEqual(spoken, ['Full answer of A.']);
  assert.equal(bars.X.hint.isMissing(), false);
}

// A missing, then B answered with a voice reply: the flag is cleared and the click is a normal click.
{
  const { speaker, spoken, bars } = setup();
  speaker.issueVoiceTurn('X', 'A');
  speaker.handleAssistantText('Answer A. ', 'X');
  speaker.endAnswer('X');
  assert.equal(bars.X.hint.isMissing(), true);
  speaker.issueVoiceTurn('X', 'B'); // next send retires the hint
  assert.equal(bars.X.hint.isMissing(), false, 'cleared on the next send');
  assert.equal(bars.X.hint.handleClick(), false);

  speaker.endAnswer('X'); // B ended too: hint for the oldest unflagged turn is B... then B replies
  speaker.handleVoiceReply('X', { turn: 'B', text: 'Short B.' });
  assert.equal(bars.X.hint.isMissing(), false, 'cleared when a voiceReply arrives');
  assert.deepEqual(spoken, ['Short B.']);
}

// The click acts on the flagged turn even when the last answer moved on.
{
  const { speaker, spoken, bars } = setup();
  speaker.issueVoiceTurn('X', 'A');
  speaker.handleAssistantText('Answer of A. ', 'X');
  speaker.endAnswer('X');
  speaker.handleAssistantText('Unrelated later answer. ', 'X');
  speaker.onAssistantBlockEnd();
  assert.equal(bars.X.hint.handleClick(), true);
  assert.deepEqual(spoken, ['Answer of A.']);
}

// Manual "listen to the short version": live state, stored history, then the full answer.
{
  const { speaker, spoken } = setup(async (chatId) => (chatId === 'H' ? { text: 'From history.', turn: 't' } : null));
  speaker.issueVoiceTurn('X', 'A');
  speaker.handleVoiceReply('X', { turn: 'A', text: 'Live short.' });
  speaker.handleVoiceReply('X', { turn: 'A', text: 'Newest short.' });
  assert.equal(await speaker.speakLastVoiceReply('X'), 'reply');
  assert.equal(spoken.at(-1), 'Newest short.');
  assert.equal(await speaker.speakLastVoiceReply('H'), 'reply');
  assert.equal(spoken.at(-1), 'From history.');
  assert.equal(await speaker.speakLastVoiceReply('none'), 'none');
  speaker.handleAssistantText('Full text. ', 'Z');
  speaker.endAnswer('Z');
  // Z's own full answer is the fallback; a chat without an answer hears nothing.
  const before = spoken.length;
  assert.equal(await speaker.speakLastVoiceReply('none'), 'none');
  assert.equal(spoken.length, before, 'an empty chat does not read another chat\'s answer');
  assert.equal(await speaker.speakLastVoiceReply('Z'), 'answer');
  assert.equal(spoken.at(-1), 'Full text.');
  assert.equal(speaker.getLastAnswerText(), 'Full text.', 'the voice agent read-back stays global');
}

// X -> empty Y: no cross-chat speech; X keeps its own fallback.
{
  const { speaker, spoken } = setup(async () => null);
  speaker.handleAssistantText('Full answer from X. ', 'X');
  speaker.endAnswer('X');
  assert.equal(await speaker.speakLastVoiceReply('Y'), 'none');
  assert.deepEqual(spoken, []);
  speaker.speakLastAnswer('t', 'Y');
  assert.deepEqual(spoken, [], 'speakLastAnswer is scoped per chat too');
  assert.equal(await speaker.speakLastVoiceReply('X'), 'answer');
  assert.deepEqual(spoken, ['Full answer from X.']);
}

// The stored-history reader finds the newest voiceReply record.
{
  const records = [
    { rec: { kind: 'meta', variant: 'voiceReply', payload: JSON.stringify({ text: 'Old.', turn: 'a' }) } },
    { rec: { kind: 'localUser', text: 'hi' } },
    { rec: { kind: 'meta', variant: 'voiceReply', payload: JSON.stringify({ text: 'Newest stored.', turn: 'b' }) } },
    { rec: { kind: 'localUser', text: 'later' } },
  ];
  const { findLastVoiceReply } = await import('../app_front/features/voice/voiceReplyMarker.js');
  assert.deepEqual(findLastVoiceReply(records), { text: 'Newest stored.', turn: 'b' });
  assert.deepEqual(findLastVoiceReply(records.map((r) => r.rec)), { text: 'Newest stored.', turn: 'b' });
  assert.equal(findLastVoiceReply([{ rec: { kind: 'localUser', text: 'x' } }]), null);
}

console.log('voice-reply-hint: ok');
