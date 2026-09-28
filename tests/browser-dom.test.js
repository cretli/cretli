import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

test('DOM read is bounded, redacted and strips executable content', async () => {
  const manager = new BrowserSessionManager({ now: () => 1 });
  const page = {
    content: async () => '<html><script>alert(1)</script><style>body{}</style><body>token=secret-value <button onclick="run()">Go</button></body></html>',
  };
  const session = { id: 'session-1', tabs: new Map(), activeTabId: 'tab-1' };
  const tab = { id: 'tab-1', page };
  session.tabs.set(tab.id, tab);
  manager.sessions.set(session.id, session);
  manager.requireTab = () => ({ session, tab });
  manager.touch = () => {};

  const result = await manager.getDom(session.id, tab.id, 'owner', { workspaceFile: '/workspace' });
  assert.equal(result.browserSessionId, session.id);
  assert.doesNotMatch(result.html, /<script|<style|onclick|secret-value/);
  assert.match(result.html, /token=\[redacted\]/);
  assert.equal(result.truncated, false);
});

test('DOM read fails closed when page content is unavailable', async () => {
  const manager = new BrowserSessionManager();
  const session = { id: 'session-1' };
  const tab = { id: 'tab-1', page: { content: async () => { throw new Error('closed'); } } };
  manager.requireTab = () => ({ session, tab });
  await assert.rejects(
    () => manager.getDom('session-1', 'tab-1', 'owner', {}),
    (error) => error.code === 'dom-failed' && error.status === 502,
  );
});
