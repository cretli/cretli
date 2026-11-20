import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserSpeechInput,
  getSpeechRecognitionCtor,
  isBrowserSpeechAvailable,
  nextFinalSegment,
} from '../app_front/features/voice/browserSpeechInput.js';
import { decideEmit } from '../app_front/features/voice/utteranceDedupe.js';

/** Manual timers so the tests never wait on a clock. */
function makeClock() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    /** Fires every pending timer once (timers they create stay pending). */
    flush() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
    },
    pending: () => timers.size,
  };
}

/** Minimal SpeechRecognition double. */
function makeFakeApi({ startError } = {}) {
  const instances = [];
  class FakeRecognition {
    constructor() {
      this.starts = 0;
      this.stops = 0;
      instances.push(this);
    }
    start() {
      this.starts += 1;
      if (startError) throw startError;
    }
    stop() {
      this.stops += 1;
      this.onend?.();
    }
    say(text, isFinal = true) {
      this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
    }
  }
  return { win: { webkitSpeechRecognition: FakeRecognition }, instances };
}

test('detects the API under either name and reports its absence', () => {
  assert.equal(isBrowserSpeechAvailable({}), false);
  assert.equal(isBrowserSpeechAvailable(undefined), false);
  assert.equal(isBrowserSpeechAvailable({ SpeechRecognition: function Fake() {} }), true);
  assert.equal(typeof getSpeechRecognitionCtor({ webkitSpeechRecognition: function Fake() {} }), 'function');
});

test('nextFinalSegment drops the cumulative prefix and repeats', () => {
  assert.deepEqual(nextFinalSegment([], '', 'hello'), { segment: 'hello', lastCumulative: 'hello' });
  assert.deepEqual(nextFinalSegment(['hello'], 'hello', 'hello world'), { segment: 'world', lastCumulative: 'hello world' });
  assert.equal(nextFinalSegment(['hello'], 'hello', 'hello').segment, '');
  assert.equal(nextFinalSegment([], '', '  ').segment, '');
});

test('CAR2: cumulative final results accumulate only their new suffix', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', true);
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests please']);
});

test('CAR2: an identical cumulative final before silence is delivered once', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', true);
  instances[0].say('run the tests', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests']);
});

test('an utterance is delivered once, after the silence timer', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  assert.deepEqual(input.start(), { ok: true });
  instances[0].say('run the', false);
  instances[0].say('run the tests');
  assert.deepEqual(utterances, []);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests']);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests'], 'no second delivery');
});

test('CAR2: an interim extension after a silence flush emits only its new suffix', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', false);
  clock.flush();
  instances[0].say('run the tests please', false);
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests', 'please']);
});

test('pause drops what was heard and stays quiet; resume listens again', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const states = [];
  const input = createBrowserSpeechInput({
    win, ...clock, onUtterance: (text) => utterances.push(text), onState: (state) => states.push(state),
  });
  input.start();
  const recognition = instances[0];
  recognition.say('half a sentence', false);
  input.pause();
  assert.equal(input.isPaused(), true);
  // The app's own voice arriving while paused must not become a prompt.
  recognition.say('text read aloud by the app');
  clock.flush();
  assert.deepEqual(utterances, []);
  const startsBefore = recognition.starts;
  input.resume();
  clock.flush();
  assert.equal(input.isListening(), true);
  assert.equal(recognition.starts, startsBefore + 1);
  recognition.say('and now the user');
  clock.flush();
  assert.deepEqual(utterances, ['and now the user']);
  assert.equal(states.at(-1).listening, true);
});

test('the recognizer is restarted when it ends on its own', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const input = createBrowserSpeechInput({ win, ...clock });
  input.start();
  instances[0].onend();
  clock.flush();
  assert.equal(instances[0].starts, 2);
  input.stop();
  instances[0].onend();
  clock.flush();
  assert.equal(instances[0].starts, 2, 'a stopped input never restarts');
});

test('a missing API reports unsupported', () => {
  const errors = [];
  const input = createBrowserSpeechInput({ win: {}, onError: (error) => errors.push(error.code) });
  assert.deepEqual(input.start(), { ok: false, code: 'unsupported' });
  assert.deepEqual(errors, ['unsupported']);
});

test('a denied microphone reports denied and stops for good', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const errors = [];
  const input = createBrowserSpeechInput({ win, ...clock, onError: (error) => errors.push(error.code) });
  input.start();
  instances[0].onerror({ error: 'not-allowed' });
  instances[0].onend();
  clock.flush();
  assert.deepEqual(errors, ['denied']);
  assert.equal(input.isWanted(), false);
  assert.equal(instances[0].starts, 1);
});

test('no-speech is routine and not reported', () => {
  const { win, instances } = makeFakeApi();
  const errors = [];
  const input = createBrowserSpeechInput({ win, ...makeClock(), onError: (error) => errors.push(error.code) });
  input.start();
  instances[0].onerror({ error: 'no-speech' });
  assert.deepEqual(errors, []);
});

test('CAR1: speech that starts again inside the resume window cancels the restart', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const input = createBrowserSpeechInput({ win, ...clock });
  input.start();
  const recognition = instances[0];
  input.pause();
  input.resume(); // TTS ended: restart scheduled
  input.pause(); // TTS started again before the timer fired
  const startsBefore = recognition.starts;
  clock.flush();
  assert.equal(recognition.starts, startsBefore, 'the pending restart must not fire during speech');
  assert.equal(input.isPaused(), true);
  input.resume();
  clock.flush();
  assert.equal(input.isListening(), true);
  assert.equal(recognition.starts, startsBefore + 1);
});

test('CAR1: a restart timer that fires while the app is speaking does nothing', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  let speaking = false;
  const input = createBrowserSpeechInput({ win, ...clock, isSpeaking: () => speaking });
  input.start();
  input.pause();
  input.resume();
  speaking = true;
  const before = instances[0].starts;
  clock.flush();
  assert.equal(instances[0].starts, before);
});

test('CAR1: starting to listen while the app already speaks waits for the speech to end', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  let speaking = true;
  const input = createBrowserSpeechInput({ win, ...clock, isSpeaking: () => speaking });
  input.start();
  assert.equal(instances[0].starts, 0, 'no recognition while speaking');
  assert.equal(input.isPaused(), true);
  speaking = false;
  input.resume();
  clock.flush();
  assert.equal(instances[0].starts, 1);
  assert.equal(input.isListening(), true);
});

test('CAR2: a late final after the silence flush does not send the utterance twice', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', false);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests']);
  instances[0].say('run the tests', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests'], 'the same final is dropped');
});

test('CAR2: a late final that extends the flushed text sends only the new part', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', false);
  clock.flush();
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests', 'please']);
  // New, unrelated speech is unaffected.
  instances[0].say('something else', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests', 'please', 'something else']);
});

test('CAR2: interim extension then a final of the same text does not resend it', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the tests', false);
  clock.flush();
  instances[0].say('run the tests please', false);
  clock.flush();
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the tests', 'please']);
});

test('CAR2: three interim flushes before the final send each word once', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  for (const text of ['run', 'run the tests', 'run the tests please']) {
    instances[0].say(text, false);
    clock.flush();
  }
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run', 'the tests', 'please']);
});

for (const withRestart of [false, true]) {
  test(`REG4: a new utterance after a flushed one is sent, restart=${withRestart}`, () => {
    const { win, instances } = makeFakeApi();
    const clock = makeClock();
    const utterances = [];
    const input = createBrowserSpeechInput({ win, ...clock, now: () => 0, onUtterance: (text) => utterances.push(text) });
    input.start();
    instances[0].say('run the tests', false);
    clock.flush();
    if (withRestart) {
      instances[0].onend();
      clock.flush();
    }
    instances[0].say('stop', false);
    clock.flush();
    instances[0].say('stop', true);
    clock.flush();
    assert.deepEqual(utterances, ['run the tests', 'stop']);
  });
}

test('REG4: a revision within one utterance is not sent twice', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, now: () => 0, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the test', false);
  clock.flush();
  instances[0].say('run the tests please', false);
  clock.flush();
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the test']);
});

test('CAR2: an interim flush followed by a final revision does not resend the revised transcript', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the test', false);
  clock.flush();
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the test']);
});

test('CAR2: the latest interim before a final is covered by the final decision', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  instances[0].say('run the test', false);
  clock.flush();
  instances[0].say('run the tests please', false);
  instances[0].say('run the tests please', true);
  clock.flush();
  assert.deepEqual(utterances, ['run the test']);
});

test('utterance dedupe preserves its word emission invariant across short event sequences', () => {
  const vocabulary = ['run', 'run the', 'run the test', 'run the tests', 'run the tests please', 'stop', 'stop now'];
  const sequences = [[]];
  for (let length = 1; length <= 4; length += 1) {
    const build = (prefix) => {
      if (prefix.length === length) {
        sequences.push(prefix);
        return;
      }
      for (const candidate of vocabulary) for (const isFinal of [false, true]) {
        build([...prefix, { candidate, isFinal }]);
      }
    };
    build([]);
  }
  for (const sequence of sequences) {
    let covered = '';
    let emittedWordCount = 0;
    let maximumCandidateLength = 0;
    for (const { candidate, isFinal } of sequence) {
      const previous = covered;
      const decision = decideEmit(covered, candidate);
      const previousWords = previous ? previous.split(' ') : [];
      const candidateWords = candidate.toLowerCase().split(/\s+/).filter(Boolean);
      const coveredWords = decision.covered ? decision.covered.split(' ') : [];
      const emittedWords = decision.emit ? decision.emit.toLowerCase().split(/\s+/) : [];
      const isNewUtterance = Boolean(previous)
        && candidateWords[0] !== previousWords[0];

      if (isNewUtterance) {
        emittedWordCount = 0;
        maximumCandidateLength = 0;
        assert.equal(decision.emit, candidate, 'new utterances emit in full');
      } else {
        const candidateExtends = previousWords.length <= candidateWords.length
          && previousWords.every((word, index) => word === candidateWords[index]);
        const candidateShrinks = candidateWords.length <= previousWords.length
          && candidateWords.every((word, index) => word === previousWords[index]);
        if (candidateExtends) {
          assert.deepEqual(emittedWords, candidateWords.slice(previousWords.length));
        } else {
          assert.deepEqual(emittedWords, []);
        }
        assert.ok(coveredWords.length >= previousWords.length, 'coverage never shrinks');
        if (candidateShrinks) assert.equal(decision.covered, previous);
      }

      maximumCandidateLength = Math.max(maximumCandidateLength, candidateWords.length);
      emittedWordCount += emittedWords.length;
      assert.ok(emittedWordCount <= maximumCandidateLength, 'emitted positions stay within utterance coverage');
      covered = isFinal ? '' : decision.covered;
      if (isFinal) {
        emittedWordCount = 0;
        maximumCandidateLength = 0;
      }
    }
  }
});

test('browser speech controller preserves word positions for every short event sequence', () => {
  const vocabulary = ['run', 'run the', 'run the test', 'run the tests', 'run the tests please', 'stop', 'stop now'];
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({
    win,
    ...clock,
    now: () => 0,
    onUtterance: (text) => utterances.push(text),
  });
  input.start();
  let activeSequence = [];

  function verifyChunks(pools, fromIndex) {
    for (let index = fromIndex; index < utterances.length; index += 1) {
      const words = utterances[index].toLowerCase().split(/\s+/).filter(Boolean);
      assert.ok(words.length, 'controller must not emit empty chunks');
      let assigned = false;
      for (const pool of pools) {
        for (const transcript of pool.transcripts) {
          for (let start = 0; start <= transcript.length - words.length; start += 1) {
            const positions = words.map((_, offset) => start + offset);
            if (!words.every((word, offset) => transcript[start + offset] === word)) continue;
            if (positions.some((position) => pool.emittedPositions.has(position))) continue;
            positions.forEach((position) => pool.emittedPositions.add(position));
            assert.ok(pool.emittedPositions.size <= pool.maxLength, 'no utterance word position is emitted twice');
            assigned = true;
            break;
          }
          if (assigned) break;
        }
        if (assigned) break;
      }
      assert.equal(assigned, true, `emitted chunk must be a fresh transcript word slice: ${utterances[index]} in ${JSON.stringify(activeSequence)}`);
    }
    return utterances.length;
  }

  function runSequence(sequence) {
    activeSequence = sequence;
    input.stop();
    clock.flush();
    input.start();
    utterances.length = 0;
    let pools = [];
    let currentPool = null;
    let outputIndex = 0;
    let previousWasFinal = false;
    for (const { transcript, isFinal, flushAfter } of sequence) {
      const words = transcript.toLowerCase().split(/\s+/).filter(Boolean);
      if (!currentPool || currentPool.firstWord !== words[0] || (previousWasFinal && !isFinal)) {
        currentPool = { firstWord: words[0], transcripts: [], emittedPositions: new Set(), maxLength: 0 };
        pools.push(currentPool);
      }
      currentPool.transcripts.push(words);
      currentPool.maxLength = Math.max(currentPool.maxLength, words.length);
      instances[0].say(transcript, isFinal);
      if (flushAfter) {
        clock.flush();
        outputIndex = verifyChunks(pools, outputIndex);
      }
      previousWasFinal = isFinal;
    }
    clock.flush();
    verifyChunks(pools, outputIndex);
  }

  for (let length = 0; length <= 4; length += 1) {
    const build = (prefix) => {
      if (prefix.length === length) {
        runSequence(prefix);
        return;
      }
      for (const transcript of vocabulary) {
        for (const isFinal of [false, true]) {
          for (const flushAfter of [false, true]) {
            build([...prefix, { transcript, isFinal, flushAfter }]);
          }
        }
      }
    };
    build([]);
  }
});

test('browser speech controller emits a pure-append cumulative final once in total', () => {
  const { win, instances } = makeFakeApi();
  const clock = makeClock();
  const utterances = [];
  const input = createBrowserSpeechInput({ win, ...clock, onUtterance: (text) => utterances.push(text) });
  input.start();
  for (const transcript of ['run', 'run the', 'run the test', 'run the tests', 'run the tests please']) {
    instances[0].say(transcript, true);
  }
  clock.flush();
  assert.equal(utterances.join(' '), 'run the tests please');
});
