import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachWsKeepalive } from '../lib/ws/ws-keepalive.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.pings = 0;
    this.terminated = 0;
  }

  ping() {
    this.pings += 1;
  }

  terminate() {
    this.terminated += 1;
    this.readyState = 3;
    this.emit('close');
  }
}

const ws = new FakeSocket();
const stop = attachWsKeepalive(ws, { intervalMs: 20, maxMissed: 2 });
await new Promise((resolve) => setTimeout(resolve, 70));
assert.ok(ws.pings >= 2);
assert.equal(ws.terminated, 1);
stop();

const healthy = new FakeSocket();
const stopHealthy = attachWsKeepalive(healthy, { intervalMs: 20, maxMissed: 2 });
healthy.on('newListener', (event) => {
  if (event !== 'pong') return;
});
const pongLoop = setInterval(() => healthy.emit('pong'), 10);
await new Promise((resolve) => setTimeout(resolve, 70));
clearInterval(pongLoop);
stopHealthy();
assert.equal(healthy.terminated, 0);

console.log('All ws-keepalive tests passed.');
