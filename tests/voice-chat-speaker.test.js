import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { createChatSpeaker } = await import('../app_front/features/voice/chatSpeaker.js');
const { findUnstableTailStart, takeCompleteSentences, toSpeakableText } = await import(
  '../app_front/features/voice/speakableText.js'
);
const { installSdkEventApply } = await import('../app_front/features/chat/history/services/sdkEventApply.js');

/** @param {'stream'|'final'} mode */
function makeSpeaker(mode) {
  localStorage.setItem('cretli-voice-read-mode', mode);
  /** @type {string[]} */
  const spoken = [];
  const speaker = createChatSpeaker({
    queue: { enqueue: (t) => spoken.push(t), cancel() {}, isBusy: () => false },
  });
  return { speaker, spoken };
}

// 1. Sentences are queued once, in order.
{
  const { speaker, spoken } = makeSpeaker('stream');
  speaker.handleAssistantText('Pierwsze zdanie. ');
  speaker.handleAssistantText('Pierwsze zdanie. Drugie zdanie. ');
  speaker.handleAssistantText('Pierwsze zdanie. Drugie zdanie. Trzecie.');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['Pierwsze zdanie.', 'Drugie zdanie.', 'Trzecie.']);
}

// 2. Revised constructs never replay or leak markers.
for (const chunks of [
  ['[Hello. Next', '[Hello. Next](https://example.com) tail. '],
  ['A. **B', 'A. **B zdanie** dalej. '],
  ['<!--Hello. Next', '<!--Hello. Next--> Done. More'],
]) {
  const { speaker, spoken } = makeSpeaker('stream');
  for (const chunk of chunks) speaker.handleAssistantText(chunk);
  speaker.endAnswer();
  for (const text of spoken) assert.ok(!/[[*]|<!--|https?:/.test(text), `marker leaked: ${text}`);
  assert.equal(spoken.filter((t) => t === 'A.').length <= 1, true);
  assert.equal(new Set(spoken).size, spoken.length, `replayed: ${JSON.stringify(spoken)}`);
}

// 3. Deferred tail is finalized with exact prose.
for (const [input, prose] of [
  ['Important **unfinished answer', 'Important unfinished answer'],
  ['Zobacz [doc', 'Zobacz doc'],
  ['Uruchom `kod', 'Uruchom kod'],
]) {
  const stream = makeSpeaker('stream');
  stream.speaker.handleAssistantText(input);
  stream.speaker.endAnswer();
  assert.deepEqual(stream.spoken, [prose]);
  assert.equal(stream.speaker.getLastAnswerText(), prose);
  const fin = makeSpeaker('final');
  fin.speaker.handleAssistantText(input);
  fin.speaker.endAnswer();
  assert.deepEqual(fin.spoken, [prose]);
}

// 4. Block transitions through the hook path.
{
  const stream = makeSpeaker('stream');
  stream.speaker.handleAssistantText('First sentence.');
  stream.speaker.onAssistantBlockEnd();
  stream.speaker.handleAssistantText('Second. ');
  stream.speaker.endAnswer();
  assert.deepEqual(stream.spoken, ['First sentence.', 'Second.']);
  const fin = makeSpeaker('final');
  fin.speaker.handleAssistantText('First sentence.');
  fin.speaker.onAssistantBlockEnd();
  fin.speaker.handleAssistantText('Second. ');
  fin.speaker.endAnswer();
  assert.deepEqual(fin.spoken, ['First sentence.\nSecond.']);
}

// 4b. sdkEventApply fires the hook once per ended live block only.
{
  const priorHTMLElement = globalThis.HTMLElement;
  const priorDocument = globalThis.document;
  class FakeEl {
    constructor() {
      this.dataset = {};
      this.children = [];
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.style = {};
      this.isConnected = true;
    }
    replaceChildren() {}
    appendChild(c) { this.children.push(c); return c; }
    closest() { return { remove() {} }; }
    querySelector() { return null; }
  }
  globalThis.HTMLElement = FakeEl;
  globalThis.document = { createElement: () => new FakeEl() };

  /** Strict view scope: touching a member the stub does not define fails the test. */
  function makeStrictRv(chat, hooks) {
    const noop = () => {};
    const base = {
      chat,
      hooks,
      suppressHistoryPersist: false,
      suppressHooksPlain: true,
      mdRenderImmediate: true,
      toolByCallId: new Map(),
      runningToolCallsByRun: new Map(),
      activeKind: 'idle',
      assistantMdEl: null,
      thinkingDetails: null,
      thinkingPre: null,
      activeThinkingRunKey: '',
      snapshotAdoptCandidate: null,
      thinkingAdoptCandidate: null,
      renderedRecordCreatedAt: '',
      renderedRecordHistorySeq: 0,
      renderedRecordRoomEventSeq: 0,
      renderedRecordEventStreamId: '',
      stopTimeoutProgressSeries: noop,
      scrollToBottom: noop,
      stickScrollToBottom: noop,
      isScrollableNearBottom: () => false,
      persistThisSdkEvent: noop,
      persistSdkStreamSnapshot: noop,
      applyMessageSourceActions: noop,
      flushMarkdown: noop,
      scheduleMd: noop,
      closeLiveTurn: noop,
      findStreamChildByOrderKey: () => null,
      resolveAssistantBlockAfterReset: () => null,
      createAssistantBlock: () => new FakeEl(),
      adoptAssistantBlock: (el) => { base.assistantMdEl = el; },
      resolveThinkingBlockForRun: () => null,
      adoptThinkingBlock: noop,
      rememberThinkingBlock: noop,
      syncThinkingBlockRunning: noop,
      setThinkingRunning: noop,
      getEventRunKey: () => 'run',
      createSdkBlock: () => new FakeEl(),
      appendStreamChild: noop,
      clearSegmentPointers: noop,
      uiMode: 'full',
      fullToolBlocks: new Set(),
      createCompactToolRecord: (callId, block) => ({ callId, fullBlock: block, event: {} }),
      resolveToolBlockVariant: () => 'run',
      createToolBody: () => new FakeEl(),
      updateCompactToolTile: noop,
    };
    const rv = new Proxy(base, {
      get(target, key) {
        if (typeof key === 'symbol' || key in target) return target[key];
        throw new Error(`rv.${String(key)} is not stubbed`);
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    installSdkEventApply(rv);
    return { rv, base };
  }

  /** @returns {{ rv: any, base: any, chat: any, ends: () => number }} */
  function setup() {
    let ends = 0;
    const chat = { id: 'c' };
    const { rv, base } = makeStrictRv(chat, { onAssistantBlockEnd: () => { ends += 1; }, appendPlain() {} });
    return { rv, base, chat, ends: () => ends };
  }
  const assistantEvent = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const events = {
    thinking: { type: 'thinking', text: 'hmm' },
    tool: { type: 'tool_call', name: 'Read', status: 'running', callId: 't1', args: { a: 1 } },
    other: { type: 'mystery_event' },
  };

  for (const [name, event] of Object.entries(events)) {
    const h = setup();
    h.rv.applySdkEvent(assistantEvent('Hello there.'));
    assert.equal(h.chat._sdkAssistantAcc, 'Hello there.', `${name}: live block open`);
    assert.equal(h.ends(), 0, `${name}: no signal while streaming`);
    h.rv.applySdkEvent(event);
    assert.equal(h.ends(), 1, `${name}: hook fires once at block end`);
    assert.equal(h.chat._sdkAssistantAcc, undefined);
    // Repeating the event after the block is closed must not signal again.
    h.rv.applySdkEvent(event);
    assert.equal(h.ends(), 1, `${name}: repeated event stays silent`);

    const quiet = setup();
    quiet.base.suppressHistoryPersist = true;
    quiet.rv.applySdkEvent(assistantEvent('Replayed.'));
    quiet.rv.applySdkEvent(event);
    assert.equal(quiet.ends(), 0, `${name}: replayed history stays silent`);

    const empty = setup();
    empty.rv.applySdkEvent(event);
    assert.equal(empty.ends(), 0, `${name}: empty accumulator stays silent`);
  }

  // Snapshot adoption (the stale accumulator is dropped without ending a block).
  {
    const h = setup();
    const candidate = new FakeEl();
    candidate.dataset.rawMd = 'Hello';
    h.base.snapshotAdoptCandidate = candidate;
    h.chat._sdkAssistantAcc = 'stale';
    h.rv.applySdkEvent(assistantEvent('Hello there.'));
    assert.equal(h.ends(), 0, 'snapshot adoption does not signal');
  }
  // Block reuse after a stream reset.
  {
    const h = setup();
    h.base.resolveAssistantBlockAfterReset = () => new FakeEl();
    h.chat._sdkAssistantAcc = 'stale';
    h.rv.applySdkEvent(assistantEvent('Hello there.'));
    assert.equal(h.ends(), 0, 'block reuse does not signal');
  }

  // F4: a queued run that starts with thinking / tool_call (no answer text yet) is running.
  for (const [name, startEvent] of [['thinking', events.thinking], ['tool_call', events.tool]]) {
    localStorage.setItem('cretli-voice-read-mode', 'agent');
    const spoken = [];
    const speaker = createChatSpeaker({
      queue: { enqueue: (t) => spoken.push(t), cancel() {}, isBusy: () => false },
    });
    const chat = { id: 'c' };
    const { rv } = makeStrictRv(chat, {
      onAssistantBlockEnd() {},
      appendPlain() {},
      onRunActivity: () => speaker.noteRunActivity('c'),
    });
    speaker.issueVoiceTurn('c', 'A');
    speaker.issueVoiceTurn('c', 'B');
    speaker.endAnswer('c'); // A ended without an entry
    rv.applySdkEvent(startEvent); // B starts silently
    speaker.handleVoiceReply('c', { turn: 'A', text: 'Late A.' });
    assert.deepEqual(spoken, [], `${name}: late entry of A waits while B runs`);
    speaker.handleVoiceReply('c', { turn: 'B', text: 'Answer B.' });
    speaker.endAnswer('c');
    assert.deepEqual(spoken, ['Answer B.'], `${name}: the latest-arrived turn wins at the end of B`);
    // Replayed history must not flip the state: the late entry then speaks at once.
    const quietSpoken = [];
    const quiet = createChatSpeaker({ queue: { enqueue: (t) => quietSpoken.push(t), cancel() {}, isBusy: () => false } });
    const q = makeStrictRv(chat, { onAssistantBlockEnd() {}, appendPlain() {}, onRunActivity: () => quiet.noteRunActivity('c') });
    q.base.suppressHistoryPersist = true;
    quiet.issueVoiceTurn('c', 'X');
    quiet.endAnswer('c');
    q.rv.applySdkEvent(startEvent);
    quiet.handleVoiceReply('c', { turn: 'X', text: 'Late X.' });
    assert.deepEqual(quietSpoken, ['Late X.'], `${name}: replayed events are not run activity`);
  }

  globalThis.HTMLElement = priorHTMLElement;
  globalThis.document = priorDocument;
}

// F1. A forced flush owes the complete sentences and the trailing fragment.
for (const [input, prose] of [
  ['Important **unfinished answer. More words', 'Important unfinished answer. More words'],
  ['Zobacz [doc. Dalej tekst', 'Zobacz doc. Dalej tekst'],
  ['Uruchom `kod. Potem reszta', 'Uruchom kod. Potem reszta'],
]) {
  for (const finish of ['endAnswer', 'onAssistantBlockEnd']) {
    const stream = makeSpeaker('stream');
    stream.speaker.handleAssistantText(input);
    stream.speaker[finish]();
    assert.deepEqual(stream.spoken, [prose], `${finish}: ${input}`);
    stream.speaker.endAnswer();
    assert.equal(stream.speaker.getLastAnswerText(), prose);
    assert.deepEqual(stream.spoken, [prose]);
  }
  const fin = makeSpeaker('final');
  fin.speaker.handleAssistantText(input);
  fin.speaker.endAnswer();
  assert.deepEqual(fin.spoken, [prose]);
  assert.equal(fin.speaker.getLastAnswerText(), prose);
}
{
  // A committed sentence is not repeated when the open construct is finalized.
  const { speaker, spoken } = makeSpeaker('stream');
  speaker.handleAssistantText('Ready. ');
  speaker.handleAssistantText('Ready. Important **unfinished answer. More');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['Ready.', 'Important unfinished answer. More']);
  assert.equal(speaker.getLastAnswerText(), 'Ready. Important unfinished answer. More');
}

// F2. A repeated sentence is new text; a plain append is never a divergence.
{
  const { speaker, spoken } = makeSpeaker('stream');
  speaker.handleAssistantText('Hello. pending ');
  speaker.handleAssistantText('Hello. Hello. pending ');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['Hello.', 'Hello.', 'pending']);
}
/** Streams `chunks`, ends the answer and returns what was enqueued. */
function run(chunks) {
  const { speaker, spoken } = makeSpeaker('stream');
  chunks.forEach((md) => speaker.handleAssistantText(md));
  speaker.endAnswer();
  return spoken;
}
/** Streams `chunks` without ending the answer: only the speech enqueued while streaming. */
function runStreaming(chunks) {
  const { speaker, spoken } = makeSpeaker('stream');
  chunks.forEach((md) => speaker.handleAssistantText(md));
  return spoken;
}

// Mute on first rewrite: any non-append change silences the rest of the block
// (streaming and finalize alike). Every expectation is exactly the speech
// enqueued BEFORE the first rewrite.
// Rewritten stable text: nothing after the rewrite, 'Gamma.' included.
assert.deepEqual(run(['Alpha one. Beta two. pending ', 'Alpha uno. Beta two. pending Gamma. ']), ['Alpha one. Beta two.']);
// Prepended 'Intro.': the whole rewrite, 'pending' included, is skipped.
assert.deepEqual(run(['Hello. pending ', 'Intro. Hello. pending ']), ['Hello.']);
// Reorder: nothing of the moved text is replayed and the tail is skipped too.
assert.deepEqual(run(['Alpha one. Beta two. pending ', 'Beta two. Alpha one. pending ']), ['Alpha one. Beta two.']);
// Reorder inside an open construct: finalize speaks nothing for a muted block.
assert.deepEqual(run(['Alpha one. Beta two. pending ', '**Beta two. Alpha one. pending']), ['Alpha one. Beta two.']);
// F2a: the repeated sentence in the rewrite is not replayed.
assert.deepEqual(run(['Hello. pending ', '**Say Hello. Hello. pending']), ['Hello.']);
// F2b: ambiguous repeated sentence; the rewrite is skipped as a whole.
assert.deepEqual(run(['Alpha one. Beta two. pending ', 'Beta two. New. Beta two. pending ']), ['Alpha one. Beta two.']);
// Shrinking replaces text: the rewritten sentences are skipped.
assert.deepEqual(run(['Alpha one. Beta two. ', 'Beta two. Gamma three. ']), ['Alpha one. Beta two.']);
// Missing anchor: the diverged text is skipped.
assert.deepEqual(run(['Alpha one. pending ', 'Completely different tail. ']), ['Alpha one.']);
// Text appended after a rewrite stays silent: the block is muted until it ends.
assert.deepEqual(
  run(['Alpha one. pending ', 'Completely different tail. ', 'Completely different tail. Fresh one. ']),
  ['Alpha one.']
);
// Repro A: substring counting used to find 'Hello.' inside 'Say Hello.' and replay it.
assert.deepEqual(run(['Hello. pending ', 'Say Hello. ', 'Say Hello. Hello. pending ']), ['Hello.']);
assert.deepEqual(run(['Hello. pending ', 'Say Hello. ', '**Say Hello. Hello. pending']), ['Hello.']);
{
  const prose = 'word '.repeat(100) + 'tail';
  // Length-fallback chunk is not replayed by a rewrite, however the text changes.
  assert.deepEqual(run([`${prose} `, `New. ${prose} `]), [prose]);
  assert.deepEqual(run([`${prose} `, `**New. ${prose}`]), [prose]);
  assert.deepEqual(run([`${prose} `, `New. ${prose} `, `New. ${prose} Fresh one. `]), [prose]);
  assert.deepEqual(run([`${prose} `, `**New. ${prose}`, `**New. ${prose} Fresh one. `]), [prose]);
  // Repro B: the chunk re-keyed after a rewrite and an extension used to replay.
  assert.deepEqual(run([`${prose} `, 'New ', `New ${prose} extra. `]), [prose]);
  assert.deepEqual(run([`${prose} `, 'New ', `**New ${prose} extra.`]), [prose]);
}
// Shrink then restore: the block is muted at the shrink, so nothing is replayed.
assert.deepEqual(run(['Alpha one. Beta two. ', 'Alpha one. ', 'Alpha one. Beta two. ']), ['Alpha one. Beta two.']);
assert.deepEqual(run(['Alpha one. Beta two. ', 'Alpha one. ', '**Alpha one. Beta two.']), ['Alpha one. Beta two.']);
// Shrink, restore and a genuine append: the append stays silent (muted block).
assert.deepEqual(
  run(['Alpha one. Beta two. ', 'Alpha one. ', 'Alpha one. Beta two. ', 'Alpha one. Beta two. Gamma three. ']),
  ['Alpha one. Beta two.']
);
{
  // A block after a muted one speaks normally.
  const { speaker, spoken } = makeSpeaker('stream');
  speaker.handleAssistantText('Alpha one. pending ');
  speaker.handleAssistantText('Different. text ');
  speaker.handleAssistantText('Different. text more. ');
  speaker.onAssistantBlockEnd();
  assert.deepEqual(spoken, ['Alpha one.']);
  speaker.handleAssistantText('Next one. tail');
  speaker.handleAssistantText('Next one. tail more. ');
  speaker.endAnswer();
  assert.deepEqual(spoken, ['Alpha one.', 'Next one.', 'tail more.']);
  assert.equal(speaker.getLastAnswerText(), 'Different. text more.\nNext one. tail more.');
}
{
  // final mode and read-back still use the full finalized text of a rewritten block.
  const fin = makeSpeaker('final');
  fin.speaker.handleAssistantText('Alpha one. Beta two. ');
  fin.speaker.handleAssistantText('Beta two. Alpha one. ');
  fin.speaker.endAnswer();
  assert.deepEqual(fin.spoken, ['Beta two. Alpha one.']);
  assert.equal(fin.speaker.getLastAnswerText(), 'Beta two. Alpha one.');
}

{
  // Property: no enqueued string contains or repeats text enqueued before it,
  // punctuated or not (length-fallback chunks included).
  const assertNoReplay = (chunks) => {
    const { speaker, spoken } = makeSpeaker('stream');
    const seen = [];
    const check = () => {
      for (const t of spoken.splice(0)) {
        for (const e of seen) {
          assert.ok(!t.includes(e), `replayed ${JSON.stringify(e)} in ${JSON.stringify(chunks)}`);
        }
        seen.push(t);
      }
    };
    chunks.forEach((md) => {
      speaker.handleAssistantText(md);
      check();
    });
    speaker.endAnswer();
    check();
  };
  const prose = 'word '.repeat(100) + 'tail';
  const sequences = [
    ['Hello. pending ', '**Say Hello. Hello. pending'],
    ['Alpha one. Beta two. pending ', 'Beta two. New. Beta two. pending '],
    ['Alpha one. Beta two. pending ', 'Alpha uno. Beta two. pending Gamma. '],
    ['Hello. pending ', 'Intro. Hello. pending '],
    ['Alpha one. pending ', 'Completely different tail. Alpha one. Next. '],
    ['One. Two. Three. x ', 'Zero. Two. Three. Four. x '],
    ['Alpha one. Beta two. pending ', 'Beta two. Alpha one. pending '],
    ['Alpha one. Beta two. pending ', '**Beta two. Alpha one. pending'],
    [`${prose} `, `New. ${prose} `],
    [`${prose} `, `**New. ${prose}`],
    [`${prose} `, `New. ${prose} `, `New. ${prose} Fresh one. `],
    ['Hello. pending ', 'Say Hello. ', 'Say Hello. Hello. pending '],
    [`${prose} `, 'New ', `New ${prose} extra. `],
  ];
  sequences.forEach(assertNoReplay);

  // Randomized: shuffle committed sentences (fallback-length unpunctuated runs
  // among them), then append new ones. A real reorder is a rewrite, so the
  // answer is exactly the speech of the first chunk.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const shuffle = (a) => {
    const out = [...a];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const fixtures = [
    ['Alpha one.', 'Beta two.', 'Gamma three.', 'Delta four.'],
    ['Hello.', 'World again.', 'Third thing here.'],
    ['One more.', 'Two more.', 'Three more.', 'Four more.', 'Five more.'],
    ['Lead in.', `${'unpunctuated '.repeat(40)}run`, 'Closing words.'],
  ];
  for (const sents of fixtures) {
    for (let n = 0; n < 40; n += 1) {
      const shuffled = shuffle(sents);
      const open = rand() < 0.5 ? '**' : '';
      const chunks = [
        `${sents.join(' ')} pending `,
        `${open}${shuffled.join(' ')} Extra new. pending more `,
        `${open}${shuffled.join(' ')} Extra new. pending more. Final bit. `,
      ];
      assertNoReplay(chunks);
      if (shuffled.join(' ') !== sents.join(' ')) {
        assert.deepEqual(run(chunks), runStreaming(chunks.slice(0, 1)), JSON.stringify(chunks));
      }
    }
  }
}

{
  // Sequence enumeration. Reference: the speech of the append-only prefix of the
  // sequence (up to the first version that does not extend its predecessor).
  // After a rewrite nothing is enqueued, finalize included. A fully append-only
  // sequence still speaks every unit of its last version exactly once.
  const norm = (t) => t.replace(/\s+/g, ' ').trim();
  const unitsOf = (t) => {
    const out = [];
    const re = /(?:[.!?…]["')\]]*\s)|(?:\n\s*\n)/g;
    let from = 0;
    for (let m = re.exec(t); m !== null; m = re.exec(t)) {
      out.push(t.slice(from, m.index + m[0].length));
      from = m.index + m[0].length;
    }
    out.push(t.slice(from));
    return out.map(norm).filter(Boolean);
  };
  const prose = 'word '.repeat(100) + 'tail';
  const versions = [
    'A one. ', // after a longer version this is a shrink
    'A one. B two. ',
    'A one. B two. C three. ',
    'B two. A one. ', // reorder
    'New. A one. B two. ', // prepend
    `${prose} `, // fallback-length unpunctuated chunk
  ];
  const check = (seq) => {
    const cut = seq.findIndex((v, i) => i > 0 && !v.startsWith(seq[i - 1]));
    const { speaker, spoken } = makeSpeaker('stream');
    seq.forEach((v) => speaker.handleAssistantText(v));
    speaker.endAnswer();
    if (cut < 0) {
      assert.deepEqual(spoken.flatMap(unitsOf), unitsOf(seq[seq.length - 1]), JSON.stringify(seq));
    } else {
      assert.deepEqual(spoken, runStreaming(seq.slice(0, cut)), JSON.stringify(seq));
    }
  };
  const walk = (seq) => {
    if (seq.length) check(seq);
    if (seq.length < 4) versions.forEach((v) => walk([...seq, v]));
  };
  walk([]);
}

// 5. Committed-prefix invariant over every prefix of a rich fixture.
{
  const F = [
    '## Wynik',
    '',
    '- pierwszy punkt. Dalej **pogrubione zdanie.** Potem *kursywa tutaj.* Kolejne.',
    '1. numerowany punkt jest tutaj. Drugi.',
    '',
    'Zobacz [dokumentację](https://example.com/docs) oraz ![obraz](http://x/y.png) tutaj. Użyj `ls` teraz. Ścieżka src/app/main.js jest ważna.',
    '',
    '```js',
    'const x = 1. ;',
    '```',
    '<!-- ukryty. komentarz -->',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'Adres https://example.com/path to koniec. Policz 2 * 3 = 6. Ostatnie zdanie. ',
    '{"title": "Tytuł"}',
  ].join('\n');
  const commit = (md) => takeCompleteSentences(toSpeakableText(md.slice(0, findUnstableTailStart(md)))).ready;
  const full = commit(F);
  assert.equal(findUnstableTailStart('abc '), 4);
  for (let i = 0; i <= F.length; i += 1) {
    const p = F.slice(0, i);
    const c = commit(p);
    assert.ok(full.startsWith(c), `prefix ${i} not stable: ${JSON.stringify(c)} vs ${JSON.stringify(full)}`);
  }
}

// 7. Long unpunctuated input still flushes through the length fallback.
{
  const { speaker, spoken } = makeSpeaker('stream');
  const long = `${'słowo '.repeat(100)}koniec `;
  speaker.handleAssistantText(long);
  assert.ok(spoken.length >= 1 && spoken[0].length >= 100, 'fallback flush');
}

console.log('voice-chat-speaker: OK');
