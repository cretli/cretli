/**
 * Speaker side of the `agent` read mode: turn correlation, latest-turn rule,
 * queue/steer scenarios, silence for unknown turns, and the unchanged other modes.
 */
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const events = [];
globalThis.window = {
  dispatchEvent: (event) => events.push(event),
  addEventListener() {},
};
globalThis.CustomEvent = class {
  constructor(type, init) { this.type = type; this.detail = init?.detail; }
};

const { createChatSpeaker, VOICE_REPLY_MISSING_EVENT } = await import('../app_front/features/voice/chatSpeaker.js');

function makeSpeaker(mode = 'agent', deps = {}) {
  localStorage.setItem('cretli-voice-read-mode', mode);
  /** @type {string[]} */
  const spoken = [];
  const speaker = createChatSpeaker({
    queue: { enqueue: (t) => spoken.push(t), cancel() {}, isBusy: () => false },
    ...deps,
  });
  return { speaker, spoken };
}
const C = 'chat-1';

// Stream and `final` text never reach the queue in agent mode.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 't1');
  speaker.handleAssistantText('Long answer. With many sentences. ', C);
  speaker.onAssistantBlockEnd();
  speaker.endAnswer(C);
  assert.deepEqual(spoken, []);
  assert.equal(speaker.getLastAnswerText(), 'Long answer. With many sentences.');
}

// Two entries of one turn: one utterance (the last), only after endAnswer.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 't1');
  speaker.handleVoiceReply(C, { turn: 't1', text: 'First version.' });
  speaker.handleVoiceReply(C, { turn: 't1', text: 'Second version.' });
  assert.deepEqual(spoken, []);
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Second version.']);
  speaker.handleVoiceReply(C, { turn: 't1', text: 'Third.' });
  assert.deepEqual(spoken, ['Second version.'], 'a handled turn stays silent');
}

// An entry after endAnswer with no run speaks once; a second one is silent.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 't1');
  speaker.endAnswer(C); // no entry yet: the hint fires but the turn stays open
  speaker.handleVoiceReply(C, { turn: 't1', text: 'Late one.' });
  speaker.handleVoiceReply(C, { turn: 't1', text: 'Late two.' });
  assert.deepEqual(spoken, ['Late one.']);
}

// Queue: A running, B queued. A's entry after A ends, B's after B ends.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 'A');
  speaker.issueVoiceTurn(C, 'B');
  speaker.handleVoiceReply(C, { turn: 'A', text: 'Answer A.' });
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Answer A.']);
  speaker.handleAssistantText('Run B output. ', C); // B's run starts
  speaker.handleVoiceReply(C, { turn: 'B', text: 'Answer B.' });
  assert.deepEqual(spoken, ['Answer A.'], 'B waits for its run to end');
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Answer A.', 'Answer B.']);
}

// Steer: A and steer C in one run, both entries: only the last delivered is spoken, both done.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 'A');
  speaker.issueVoiceTurn(C, 'C');
  speaker.handleVoiceReply(C, { turn: 'A', text: 'Answer A.' });
  speaker.handleVoiceReply(C, { turn: 'C', text: 'Answer C.' });
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Answer C.']);
  speaker.handleVoiceReply(C, { turn: 'A', text: 'Again A.' });
  speaker.handleVoiceReply(C, { turn: 'C', text: 'Again C.' });
  assert.deepEqual(spoken, ['Answer C.']);
}

// Mixed A/B/C: A running, B (steer with skill) queued, C steer delivered into A.
{
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 'A');
  speaker.issueVoiceTurn(C, 'B');
  speaker.issueVoiceTurn(C, 'C');
  speaker.handleVoiceReply(C, { turn: 'A', text: 'Answer A.' });
  speaker.handleVoiceReply(C, { turn: 'C', text: 'Answer C.' });
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Answer C.']);
  // B is still issued: its run starts and ends with its own entry.
  speaker.handleAssistantText('B starts. ', C);
  speaker.handleVoiceReply(C, { turn: 'B', text: 'Answer B.' });
  speaker.endAnswer(C);
  assert.deepEqual(spoken, ['Answer C.', 'Answer B.']);
}

// Unknown / missing turn, inactive chat, non-agent mode: silence.
{
  const { speaker, spoken } = makeSpeaker('agent', { isChatActive: (id) => id === C });
  speaker.issueVoiceTurn(C, 'T');
  speaker.issueVoiceTurn('other', 'O');
  speaker.handleVoiceReply(C, { turn: 'ghost', text: 'Hydrated entry.' });
  speaker.handleVoiceReply(C, { text: 'No turn.' });
  speaker.handleVoiceReply(C, { turn: 'T', text: '' });
  speaker.handleVoiceReply('other', { turn: 'O', text: 'Inactive chat.' });
  speaker.endAnswer(C);
  speaker.endAnswer('other');
  assert.deepEqual(spoken, []);
}
{
  const { speaker, spoken } = makeSpeaker('final');
  speaker.issueVoiceTurn(C, 'T');
  speaker.handleVoiceReply(C, { turn: 'T', text: 'Not in agent mode.' });
  speaker.endAnswer(C);
  assert.deepEqual(spoken, []);
}

// A turn that ends without an entry raises the hint once and keeps the turn open.
{
  events.length = 0;
  const { speaker, spoken } = makeSpeaker();
  speaker.issueVoiceTurn(C, 'T');
  speaker.handleAssistantText('Plain answer. ', C);
  speaker.endAnswer(C);
  assert.equal(events.filter((e) => e.type === VOICE_REPLY_MISSING_EVENT && e.detail.missing === true).length, 1);
  assert.equal(events[0].detail.turn, 'T');
  speaker.endAnswer(C);
  assert.equal(events.filter((e) => e.type === VOICE_REPLY_MISSING_EVENT && e.detail.missing === true).length, 1, 'hint is not repeated');
  assert.deepEqual(spoken, []);
  speaker.speakLastAnswer('fallback', C);
  assert.deepEqual(spoken, ['Plain answer.']);
}

// The existing modes are untouched.
{
  const { speaker, spoken } = makeSpeaker('stream');
  speaker.handleAssistantText('One. ');
  speaker.handleAssistantText('One. Two. ');
  speaker.handleAssistantText('One. Two. Three.');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['One.', 'Two.', 'Three.']);
}
{
  const { speaker, spoken } = makeSpeaker('final');
  speaker.handleAssistantText('One. Two. ');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['One. Two.']);
}

console.log('voice-reply-speaker: ok');
