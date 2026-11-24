import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import * as domains from '../extensions/cretli-chrome/domains.js';
import * as lifecycle from '../extensions/cretli-chrome/lifecycle.js';
import { fetchDocument } from '../extensions/cretli-chrome/fetch-document.js';

const source = fs.readFileSync(new URL('../extensions/cretli-chrome/service-worker.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Run the actual worker with browser API boundaries controlled by the test.
async function worker(gate) {
  let release;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let runtimeMessage;
  let socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() { socket = this; }
    send() {}
    close() { this.readyState = 3; }
  }
  const pause = (name, value) => {
    if (gate !== name) return Promise.resolve(value);
    entered();
    return pending.then(() => value);
  };
  const chrome = {
    storage: { local: {
      get: (key) => key === 'cretliTabId' ? pause('storage', { cretliTabId: 1 })
        : Promise.resolve({ installId: 'install', token: 'token' }),
      set: async () => {}, remove: async () => {},
    } },
    permissions: { contains: () => pause('permission', true) },
    tabs: {
      get: async () => ({ id: 1, url: 'https://shop.example.com/', status: 'complete' }),
      create: async () => { calls.push('create'); return { id: 1 }; },
      update: async () => { calls.push('update'); return { id: 1 }; },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: { executeScript: (args) => {
      calls.push(args.files ? 'inject' : 'read');
      return pause('injection', [{ result: { items: [] } }]);
    } },
    runtime: {
      onMessage: { addListener(fn) { runtimeMessage = fn; } },
      sendMessage: async () => {}, onStartup: { addListener() {} }, onInstalled: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  vm.runInNewContext(source, {
    ...domains, ...lifecycle, fetchDocument, chrome, WebSocket: Socket,
    AbortController, DOMException, URL, setTimeout: () => 0, clearTimeout() {},
  });
  await tick();
  await socket.onmessage({ data: JSON.stringify({ type: 'authed', allowed: ['shop.example.com'] }) });
  return {
    calls, reached, release,
    command: (name) => socket.onmessage({ data: JSON.stringify({ type: 'cmd', id: 'work', name,
      args: { url: 'https://shop.example.com/', reuseTab: true, tabId: 1 } }) }),
    cancel: () => socket.onmessage({ data: JSON.stringify({ type: 'cmd', id: 'cancel', name: 'cancel', args: { targetId: 'work' } }) }),
    disconnect: () => { socket.readyState = 3; socket.onclose({ code: 4403 }); },
    kill: () => new Promise((resolve) => runtimeMessage({ type: 'kill' }, {}, resolve)),
  };
}

for (const action of ['cancel', 'disconnect', 'kill']) {
  for (const [command, gate, expected] of [
    ['open_url', 'permission', []], ['open_url', 'storage', []],
    ['list_documents', 'permission', []], ['list_documents', 'injection', ['inject']],
  ]) {
    test(`${command}: ${action} during ${gate} prevents subsequent browser actions`, async () => {
      const fx = await worker(gate);
      await fx.command(command);
      await fx.reached;
      await fx[action]();
      await tick();
      fx.release();
      await tick();
      assert.deepEqual(fx.calls, expected);
    });
  }
}
