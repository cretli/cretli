import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceCostTracker, formatUsd } from '../app_front/features/voice/voiceCost.js';

/**
 * @param {{ audioIn?: number, textIn?: number, cached?: number, cachedAudio?: number, audioOut?: number, textOut?: number }} counts
 */
function makeUsage(counts) {
  return {
    input_token_details: {
      audio_tokens: counts.audioIn || 0,
      text_tokens: counts.textIn || 0,
      cached_tokens: counts.cached || 0,
      cached_tokens_details: { audio_tokens: counts.cachedAudio || 0, text_tokens: 0 },
    },
    output_token_details: {
      audio_tokens: counts.audioOut || 0,
      text_tokens: counts.textOut || 0,
    },
  };
}

test('accumulates usage across responses', () => {
  const tracker = createVoiceCostTracker({ model: 'gpt-realtime' });
  tracker.addUsage(makeUsage({ audioIn: 1_000_000 }));
  assert.equal(tracker.getTotalUsd(), 32);
  tracker.addUsage(makeUsage({ audioOut: 1_000_000 }));
  assert.equal(tracker.getTotalUsd(), 96);
});

test('bills cached input once, at the cached rate', () => {
  const tracker = createVoiceCostTracker({ model: 'gpt-realtime' });
  tracker.addUsage(makeUsage({ audioIn: 1_000_000, cached: 1_000_000, cachedAudio: 1_000_000 }));
  assert.equal(tracker.getTotalUsd(), 0.4, 'cached audio must not be charged twice');
});

test('warns once and then caps the session', () => {
  /** @type {number[]} */
  const warned = [];
  /** @type {number[]} */
  const capped = [];
  const tracker = createVoiceCostTracker({
    model: 'gpt-realtime',
    warnUsd: 1,
    capUsd: 2,
    onWarn: (usd) => warned.push(usd),
    onCap: (usd) => capped.push(usd),
  });

  // 20k audio input tokens cost $0.64 at the gpt-realtime rate.
  tracker.addUsage(makeUsage({ audioIn: 20_000 }));
  assert.deepEqual(warned, [], 'below the warn threshold nothing fires');

  tracker.addUsage(makeUsage({ audioIn: 20_000 }));
  assert.equal(warned.length, 1, 'the warning fires once');
  assert.equal(capped.length, 0);

  tracker.addUsage(makeUsage({ audioIn: 20_000 }));
  assert.equal(warned.length, 1, 'the warning does not repeat');
  assert.equal(capped.length, 0, 'still under the cap');

  tracker.addUsage(makeUsage({ audioIn: 20_000 }));
  assert.equal(capped.length, 1, 'the cap fires when crossed');
  assert.ok(tracker.isCapped());
});

test('bills the mini model at the cheaper audio rate', () => {
  const tracker = createVoiceCostTracker({ model: 'gpt-realtime-2.1-mini' });
  tracker.addUsage(makeUsage({ audioIn: 1_000_000 }));
  assert.equal(tracker.getTotalUsd(), 10);
});

test('bills Gemini Live at its own audio rate', () => {
  const tracker = createVoiceCostTracker({ model: 'gemini-2.5-flash-native-audio-preview-12-2025' });
  tracker.addUsage(makeUsage({ audioIn: 1_000_000, audioOut: 1_000_000 }));
  assert.equal(tracker.getTotalUsd(), 15);
});

test('unknown models fall back to realtime rates instead of billing zero', () => {
  const tracker = createVoiceCostTracker({ model: 'some-future-model' });
  tracker.addUsage(makeUsage({ audioIn: 1_000_000 }));
  assert.ok(tracker.getTotalUsd() > 0);
});

test('ignores malformed usage payloads', () => {
  const tracker = createVoiceCostTracker({ model: 'gpt-realtime' });
  tracker.addUsage(null);
  tracker.addUsage({});
  tracker.addUsage(makeUsage({ audioIn: -5 }));
  assert.equal(tracker.getTotalUsd(), 0);
});

test('formats small amounts without pretending to be precise', () => {
  assert.equal(formatUsd(0), '<$0.01');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(1.239), '$1.24');
});
