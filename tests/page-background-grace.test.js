import assert from 'node:assert/strict';
import { getReconnectModalDelayMs } from '../app_front/lib/pageBackgroundGrace.js';
import { BG_DISCONNECT_GRACE_MS } from '../app_front/config.js';

assert.equal(
  getReconnectModalDelayMs({ hidden: true, recentBackgroundMs: 0, graceMs: BG_DISCONNECT_GRACE_MS }),
  null,
  'Modal should not appear while the tab is in the background'
);

assert.equal(
  getReconnectModalDelayMs({ hidden: false, recentBackgroundMs: 3000, graceMs: BG_DISCONNECT_GRACE_MS }),
  BG_DISCONNECT_GRACE_MS,
  'After a short return from the background the modal should get a grace period'
);

assert.equal(
  getReconnectModalDelayMs({ hidden: false, recentBackgroundMs: 60000, graceMs: BG_DISCONNECT_GRACE_MS }),
  BG_DISCONNECT_GRACE_MS,
  'With a visible tab the modal still waits out the grace period before showing'
);

console.log('page-background-grace.test.js: ok');
