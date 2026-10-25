import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getClientInstance,
  getClientInstanceStatus,
  listClientInstances,
  resetClientInstanceRegistryForTests,
  upsertClientInstance,
} from '../lib/client-instance-registry.js';
import {
  appendClientInstanceLogFile,
  clearClientInstanceLogFile,
  readClientInstanceLogTail,
} from '../lib/client-instance-logs.js';

resetClientInstanceRegistryForTests();

const inputId = 'abc12345-dead-beef-cafe-000000000001';
const record = upsertClientInstance(
  {
    clientInstanceId: inputId,
    label: 'PWA · Android',
    kind: 'pwa',
    ua: 'Mozilla/5.0 Mobile',
    visibility: 'visible',
    activePanel: 'chat',
    wsCount: 3,
    debugRemote: true,
    debugUiFreeze: true,
  },
  '192.168.1.10'
);

assert.ok(record);
assert.equal(record?.id, inputId);
assert.equal(record?.label, 'PWA · Android');
assert.equal(getClientInstanceStatus(record.lastSeenAt), 'online');

const listed = listClientInstances();
assert.equal(listed.length, 1);
assert.equal(listed[0].status, 'online');
assert.equal(getClientInstance(inputId)?.wsCount, 3);

const duplicateId = 'abc12345-dead-beef-cafe-000000000099';
upsertClientInstance(
  {
    clientInstanceId: duplicateId,
    label: 'PWA · Android',
    kind: 'pwa',
    ua: 'Mozilla/5.0 Mobile',
    wsCount: 1,
  },
  '192.168.1.10'
);
assert.equal(listClientInstances().length, 1);
assert.equal(getClientInstance(inputId), null);
assert.ok(getClientInstance(duplicateId));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-client-inst-'));
appendClientInstanceLogFile(tmpDir, inputId, 'heartbeat', 'Mozilla', ['11:00:00.000 [system] boot']);
const tail = readClientInstanceLogTail(tmpDir, inputId, { limit: 10 });
assert.equal(tail.lines.length >= 1, true);
assert.match(tail.lines.join('\n'), /\[system\] boot/);
assert.equal(clearClientInstanceLogFile(tmpDir, inputId), true);

fs.rmSync(tmpDir, { recursive: true, force: true });
resetClientInstanceRegistryForTests();

console.log('client-instance-registry.test.js: ok');
