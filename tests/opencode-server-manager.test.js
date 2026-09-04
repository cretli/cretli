import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { resolveOpenCodeRuntimeHome } from '../lib/opencode/opencode-server-manager.js';
import { resolveOpenCodeUserHome } from '../lib/opencode/opencode-spawn-path.js';

function allocatePort(workspaceFolder, portBase = 4096) {
  const hash = createHash('sha256').update(workspaceFolder).digest();
  const offset = hash.readUInt16BE(0) % 2000;
  return portBase + offset;
}

const portA = allocatePort('/home/user/project-a');
const portB = allocatePort('/home/user/project-b');
const portA2 = allocatePort('/home/user/project-a');

assert.notEqual(portA, portB);
assert.equal(portA, portA2);
assert.ok(portA >= 4096 && portA < 6096);

assert.equal(
  resolveOpenCodeRuntimeHome({ uid: 1000, home: '/root', fallbackHome: '/home/developer' }),
  '/home/developer',
);
assert.equal(
  resolveOpenCodeRuntimeHome({ uid: 1000, home: '/home/developer', fallbackHome: '/home/developer' }),
  '/home/developer',
);
assert.equal(
  resolveOpenCodeRuntimeHome({ uid: 0, home: '/root', fallbackHome: '/home/developer' }),
  '/root',
);

const passwdHome = resolveOpenCodeUserHome();
assert.ok(passwdHome);
assert.equal(
  resolveOpenCodeRuntimeHome({ uid: 1000, home: '/root', fallbackHome: passwdHome }),
  passwdHome,
);

console.log('opencode-server-manager.test.js OK');
