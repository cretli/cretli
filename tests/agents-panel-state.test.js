import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentsState } from '../app_front/features/agents/agentsState.js';

const t = (k) => ({ 'agents.finished': ' (done)', 'agents.connecting': ' (…)' })[k] || k;

test('syncRuns keeps row views alive and updates only the changed label', () => {
  const s = createAgentsState(() => false, t);
  const a = { id: 'a', agentName: 'alpha', runId: null, status: 'running', displayTitle: null };
  const b = { id: 'b', agentName: 'beta', runId: 'r', status: 'running', displayTitle: null };
  s.syncRuns([a, b]);
  const [va, vb] = s.runViews.get();
  assert.equal(va.label.get(), 'alpha (…)');
  assert.equal(vb.label.get(), 'beta');
  const listBefore = s.runViews.get();
  a.displayTitle = 'Report';
  a.runId = 'x';
  s.syncRuns([a, b]);
  assert.equal(s.runViews.get(), listBefore, 'list identity unchanged');
  assert.equal(va.label.get(), 'Report');
  assert.equal(vb.label.get(), 'beta');
  b.status = 'finished';
  s.syncRuns([a, b]);
  assert.equal(vb.label.get(), 'beta (done)');
});

test('available agents exclude running names; favorites sort first', () => {
  const fav = new Set(['gamma']);
  const s = createAgentsState((n) => fav.has(n), t);
  s.agents.set([{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }]);
  s.syncRuns([{ id: 'a', agentName: 'alpha', status: 'running' }]);
  assert.deepEqual(s.orderedAvailable.get().map((x) => x.name), ['gamma', 'beta']);
  fav.add('beta');
  fav.delete('gamma');
  s.favoritesTick.set(1);
  assert.deepEqual(s.orderedAvailable.get().map((x) => x.name), ['beta', 'gamma']);
});

test('schedule drafts override stored values and collect clamps interval', () => {
  const s = createAgentsState(() => false, t);
  const agents = [{ name: 'alpha' }, { name: 'beta' }];
  s.setSchedule(agents, [{ agentName: 'alpha', enabled: true, intervalMinutes: 15 }]);
  s.editSchedule('beta', { enabled: true, intervalMinutes: '0' });
  assert.deepEqual(s.collectSchedules(agents), [
    { agentName: 'alpha', enabled: true, intervalMinutes: 15 },
    { agentName: 'beta', enabled: true, intervalMinutes: 60 },
  ]);
  s.setSchedule(agents, []);
  assert.equal(s.collectSchedules(agents)[1].enabled, false, 'reload discards drafts');
});
