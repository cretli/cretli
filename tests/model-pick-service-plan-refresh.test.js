import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickModelForPurpose } from '../lib/model-pick-service.js';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const MIN = 60 * 1000;

const reading = (ageMs) => ({
  harness: 'codex',
  observedAt: new Date(NOW - ageMs).toISOString(),
});

// `history` is deliberately NOT injected so the refresh gate runs. Everything
// the history builder would read from disk (delegations, lockouts, outcomes,
// limit hits, purpose chats) is injected instead, the refresher is a stub, and
// dataDir is a throwaway tmp dir: no network and no global data/ access.
function run(planWindowConfig, planLimits) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-plan-refresh-'));
  const calls = [];
  try {
    pickModelForPurpose({
      purpose: '',
      role: 'implement',
      harnesses: [],
      costPolicy: false,
      explore: false,
      overrides: false,
      shadow: false,
      now: NOW,
      dataDir,
      delegations: [],
      lockouts: [],
      outcomes: { roles: {} },
      freshLimitHits: {},
      planLimits,
      planWindowConfig,
      planLimitsRefreshers: { codex: async (args) => { calls.push(args); } },
    });
  } catch { /* selection outcome is irrelevant here */ }
  finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  return calls;
}

test('refresh stub is not called when planWindowConfig.enabled is false', () => {
  assert.equal(run({ enabled: false }, [reading(60 * MIN)]).length, 0);
});

test('refresh stub is called exactly once for codex when the reading is older than 10 minutes', () => {
  assert.equal(run({ enabled: true }, [reading(11 * MIN)]).length, 1);
});

test('refresh stub is not called when the newest codex reading is fresh', () => {
  assert.equal(run({ enabled: true }, [reading(2 * MIN)]).length, 0);
});
