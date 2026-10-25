/**
 * A Browser context that closes under a live session (renderer/context crash)
 * must drop that session: otherwise every later browser_open fails with
 * "Target page, context or browser has been closed" (seen 2026-10-24 on the
 * operator's system-owner session).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionManager } from '../lib/browser/session-manager.js';

const OWNER = 'owner-context-closed';
const WORKSPACE = '/tmp/cretli-context-closed.code-workspace';

function createDriver() {
  const contexts = [];
  class FakePage {
    constructor() { this._handlers = new Map(); this._closed = false; }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    isClosed() { return this._closed; }
    url() { return 'about:blank'; }
    mainFrame() { return null; }
    async close() { this._closed = true; }
  }
  class FakeContext {
    constructor() { this._handlers = new Map(); this.closed = false; }
    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(handler);
    }
    emit(event) { for (const handler of this._handlers.get(event) || []) handler(); }
    async route() {}
    async newPage() {
      if (this.closed) throw new Error('browserContext.newPage: Target page, context or browser has been closed');
      return new FakePage();
    }
    async close() { this.closed = true; }
  }
  class FakeBrowser {
    async newContext() {
      const context = new FakeContext();
      contexts.push(context);
      return context;
    }
    isConnected() { return true; }
    on() {}
    async close() {}
  }
  return { contexts, driver: { name: 'fake', async launch() { return new FakeBrowser(); } } };
}

test('a closed context drops its session so the next open gets a fresh one', async () => {
  const { contexts, driver } = createDriver();
  const manager = new BrowserSessionManager({
    driver,
    driverStatus: { status: 'available' },
    resolvePolicy: () => ({ allowedOrigins: ['https://example.com'], blockedPorts: [], unblockedPorts: [] }),
    lookup: async () => [{ address: '93.184.216.34' }],
  });
  const first = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE });
  assert.equal(manager.sessions.has(first.browserSessionId), true);

  contexts[0].closed = true;
  contexts[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(manager.sessions.has(first.browserSessionId), false, 'the dead session is no longer registered');

  const second = await manager.createSession({ ownerSessionId: OWNER, workspaceFile: WORKSPACE });
  assert.notEqual(second.browserSessionId, first.browserSessionId);
  assert.equal(contexts.length, 2, 'a new context was created');
});
