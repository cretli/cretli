import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import test from 'node:test';
import { recordUsage, summarizeUsage } from '../lib/usage/usage-ledger.js';
import { readUsageEvents } from '../lib/persist/usage-persist.js';

test('records priced events to a daily jsonl file', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cretli-usage-'));
  const openai = recordUsage(
    {
      provider: 'openai',
      feature: 'voice-live',
      model: 'gpt-realtime-2.1',
      tokens: { audioInput: 1_000_000 },
      at: '2026-08-28T10:00:00.000Z',
    },
    { dataDir }
  );
  const google = recordUsage(
    {
      provider: 'google',
      feature: 'voice-live',
      model: 'gemini-3.1-flash-live-preview',
      tokens: { audioInput: 1_000_000 },
      at: '2026-08-28T11:00:00.000Z',
    },
    { dataDir }
  );
  assert.equal(openai.usd, 32);
  assert.ok(google.usd > 0 && google.usd < 10);
  const events = readUsageEvents({
    from: '2026-08-28',
    to: '2026-08-28',
    dataDir,
  });
  assert.equal(events.length, 2);
  const summary = summarizeUsage(events);
  assert.ok(summary.totalUsd > 32);
  assert.equal(summary.byProvider.openai.usd, 32);
  assert.equal(summary.byFeature['voice-live'].events, 2);
  assert.equal(summary.byDay['2026-08-28'].events, 2);
});

test('Cursor tokens count but do not become zero dollars', () => {
  const events = [
    {
      provider: 'cursor',
      feature: 'chat',
      usd: null,
      tokens: { textInput: 100, textOutput: 20, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
    },
    {
      provider: 'openai',
      feature: 'voice-tts',
      usd: 0.5,
      tokens: { textInput: 0, textOutput: 0, audioInput: 0, audioOutput: 0, cachedInput: 0, reasoning: 0 },
    },
  ];
  const summary = summarizeUsage(events);
  assert.equal(summary.totalUsd, 0.5);
  assert.equal(summary.unpricedEvents, 1);
  assert.equal(summary.tokens.textInput, 100);
});
