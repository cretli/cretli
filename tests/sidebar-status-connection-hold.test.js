import assert from 'node:assert/strict';
import { createSidebarStatusStabilizer } from '../app_front/features/sidebar/sidebarChatStatusStability.js';

let now = 0;
const stabilizer = createSidebarStatusStabilizer({
  now: () => now,
  setTimeout: () => 1,
  clearTimeout: () => {},
});
const working = { tone: 'active', label: 'Agent working' };
const connecting = { tone: 'connecting', label: 'Connecting…' };
const resetSources = { serverBusy: false, localActive: false, serverKnown: true };

stabilizer.stabilize('c1', working, { serverBusy: true, localActive: true, serverKnown: true });
now = 1000;
// Socket re-opening with flags reset: the cog must stay.
assert.equal(stabilizer.stabilize('c1', connecting, resetSources).tone, 'active');
now = 7000;
assert.equal(stabilizer.stabilize('c1', connecting, resetSources).tone, 'active');
now = 9500;
assert.equal(stabilizer.stabilize('c1', connecting, resetSources).tone, 'connecting');

// A plain idle with both sources agreeing is still released immediately.
now = 20000;
stabilizer.stabilize('c2', working, { serverBusy: true, localActive: true, serverKnown: true });
now = 20010;
assert.equal(stabilizer.stabilize('c2', { tone: 'idle', label: 'Ready' }, resetSources).tone, 'idle');
console.log('sidebar-status-connection-hold ok');
