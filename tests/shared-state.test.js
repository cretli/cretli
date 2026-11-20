import assert from 'node:assert/strict';
import test from 'node:test';
import { createSharedState } from '../app_front/state/sharedState.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('watcher bumps notify subscribers once per change, not for the initial value', async () => {
  const s = createSharedState();
  let calls = 0;
  const off = s.onWatcherChanged(() => { calls += 1; });
  await tick();
  assert.equal(calls, 0);
  s.bumpWatcher();
  await tick();
  assert.equal(calls, 1);
  s.bumpWatcher();
  await tick();
  assert.equal(calls, 2);
  off();
  s.bumpWatcher();
  await tick();
  assert.equal(calls, 2);
});

test('publish ignores failed payloads and keeps the last good value', () => {
  const s = createSharedState();
  s.publishSettings({ ok: true, a: 1 });
  s.publishSettings({ ok: false });
  assert.equal(s.settings.get().a, 1);
});

test('many panels reading the signal cost one fetch', async () => {
  const s = createSharedState();
  let fetches = 0;
  const load = async () => { fetches += 1; s.publishChats({ chats: [1] }); };
  const panelRead = async () => { if (!s.chatsList.get()) await load(); return s.chatsList.get(); };
  await Promise.all([panelRead(), panelRead()]);
  await panelRead();
  await panelRead();
  // The first reader fetched and published; every later reader hit the signal.
  assert.equal(fetches, 1);
  assert.equal(s.chatsList.get().chats.length, 1);
});

test('listener runs exactly once per tick across many bumps (no re-arm leak)', async () => {
  const s = createSharedState();
  let calls = 0;
  const off = s.onWatcherChanged(() => { calls += 1; });
  for (let i = 1; i <= 200; i += 1) {
    s.bumpWatcher();
    s.bumpWatcher(); // coalesced into one notification
    await tick();
    assert.equal(calls, i);
  }
  off();
});
