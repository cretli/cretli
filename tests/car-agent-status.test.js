import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CAR_AGENT_STATUSES, deriveCarAgentStatus } from '../app_front/features/car/agentStatus.js';

const STATES = ['busy', 'waiting', 'attention', 'idle', undefined];
const DELEGATIONS = ['', 'completed', 'failed', 'interrupted', 'waiting_for_input'];
const RECOVERIES = ['', 'unknown', 'interrupted', 'interrupted_restart', 'resuming', 'waiting'];
const COUNTS = [0, 2];
const FLAGS = [false, true];

/**
 * Independent reference: an ordered rule table instead of the nested ifs in the module. The first
 * entry whose test holds decides.
 */
const RULES = [
  [(p, cards) => cards > 0 || p.inputRequested === true, 'needs_decision'],
  [(p) => p.recoveryStatus === 'unknown', 'unknown'],
  [(p) => ['interrupted', 'interrupted_restart'].includes(p.recoveryStatus), 'error'],
  [(p) => p.recoveryStatus === 'resuming', 'working'],
  [(p) => p.state === 'busy', 'working'],
  [(p) => p.waitingAgentCount > 0 || p.inFlightChildCount > 0, 'working'],
  [(p) => p.state === 'attention' && ['failed', 'interrupted'].includes(p.delegationStatus), 'error'],
  [(p) => p.state === 'attention' && p.delegationStatus === 'completed', 'done'],
  [(p) => p.state === 'attention', 'unknown'],
  [(p) => p.state === 'idle', 'idle'],
];
function reference(presence, cardCount) {
  if (!presence) return cardCount > 0 ? 'needs_decision' : 'idle';
  for (const [test_, result] of RULES) if (test_(presence, cardCount)) return result;
  return 'unknown';
}

test('the cartesian product of presence fields matches the reference and stays in the set', () => {
  let cases = 0;
  for (const state of STATES) {
    for (const delegationStatus of DELEGATIONS) {
      for (const recoveryStatus of RECOVERIES) {
        for (const waitingAgentCount of COUNTS) {
          for (const inFlightChildCount of COUNTS) {
            for (const inputRequested of FLAGS) {
              for (const cardCount of [0, 1]) {
                const presence = state === undefined
                  ? null
                  : { state, delegationStatus, recoveryStatus, waitingAgentCount, inFlightChildCount, inputRequested };
                const cards = Array.from({ length: cardCount }, () => ({ status: 'pending' }));
                const actual = deriveCarAgentStatus(presence, cards);
                const label = JSON.stringify({ presence, cardCount });
                cases += 1;
                assert.ok(CAR_AGENT_STATUSES.includes(actual), `${label} -> ${actual}`);
                assert.equal(actual, reference(presence, cardCount), label);
                if (cardCount > 0 || presence?.inputRequested === true) assert.equal(actual, 'needs_decision', label);
              }
            }
          }
        }
      }
    }
  }
  assert.equal(cases, 5 * 5 * 6 * 2 * 2 * 2 * 2);
});

test('only pending cards count as open', () => {
  assert.equal(deriveCarAgentStatus(null, [{ status: 'decided' }, { status: 'stale' }]), 'idle');
  assert.equal(deriveCarAgentStatus(null, [{ status: 'decided' }, { status: 'pending' }]), 'needs_decision');
  assert.equal(deriveCarAgentStatus(null, [{ id: 'no-status' }]), 'needs_decision');
  assert.equal(deriveCarAgentStatus(null, 2), 'needs_decision');
  assert.equal(deriveCarAgentStatus(null), 'idle');
});

test('explicit cases from the plan', () => {
  const p = (extra) => ({ state: 'idle', delegationStatus: '', recoveryStatus: '', waitingAgentCount: 0, inFlightChildCount: 0, ...extra });
  // Current work beats an old terminal delegation (only combinations the summarizer produces).
  for (const delegationStatus of ['completed', 'failed', 'interrupted']) {
    assert.equal(deriveCarAgentStatus(p({ state: 'busy', delegationStatus }), []), 'working');
    assert.equal(deriveCarAgentStatus(p({ state: 'busy', delegationStatus, recoveryStatus: 'resuming' }), []), 'working');
  }
  assert.equal(deriveCarAgentStatus(p({ state: 'busy', recoveryStatus: 'unknown' }), []), 'unknown');
  assert.equal(deriveCarAgentStatus(p({ state: 'busy', recoveryStatus: 'interrupted' }), []), 'error');
  assert.equal(deriveCarAgentStatus(p({ state: 'waiting', inputRequested: true }), []), 'needs_decision');
  assert.equal(deriveCarAgentStatus(p({ state: 'waiting', inputRequested: true, waitingAgentCount: 2, inFlightChildCount: 1 }), []), 'needs_decision');
  assert.equal(deriveCarAgentStatus(p({ state: 'waiting', waitingAgentCount: 2, inFlightChildCount: 1 }), []), 'working');
  assert.equal(deriveCarAgentStatus(p({ state: 'attention', inFlightChildCount: 1 }), []), 'working');
  assert.equal(deriveCarAgentStatus(p({ state: 'idle', inFlightChildCount: 1 }), []), 'working');
  assert.equal(deriveCarAgentStatus(p({ state: 'attention', recoveryStatus: 'unknown', delegationStatus: 'failed' }), []), 'unknown');
  assert.equal(deriveCarAgentStatus(p({ state: 'attention', delegationStatus: 'interrupted' }), []), 'error');
  assert.equal(deriveCarAgentStatus(p({ state: 'attention', delegationStatus: '' }), []), 'unknown');
  assert.equal(deriveCarAgentStatus(p({ state: 'attention', delegationStatus: 'completed' }), []), 'done');
  assert.equal(deriveCarAgentStatus(undefined, []), 'idle');
});
