import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import { getDelegationsDataPath, loadDelegations } from '../lib/persist/delegations-persist.js';
import { UnsupportedDelegationSchemaError } from '../lib/persist/delegation-schema.js';
import {
  acquireDelegationOwnerLock,
  releaseDelegationOwnerLock,
  DelegationOwnerLockError,
} from '../lib/delegation-owner-lock.js';
import {
  getDelegationRuntimeHealth,
  resetDelegationRuntimeHealth,
  startDelegationRuntimeWorker,
  stopDelegationRuntimeWorker,
  tickDelegationRuntime,
} from '../lib/delegation-runtime-worker.js';
import {
  setDelegationLifecycleState,
  isDelegationRuntimeAcceptingWork,
  resetDelegationLifecycleForTest,
} from '../lib/delegation-lifecycle.js';
import { createDelegationService } from '../lib/delegation-service.js';
import { addChat } from '../lib/persist/chats-persist.js';
import { registerMockChatRunAdapter } from '../lib/chat-run/mock-adapter.js';
import { bootDelegationRuntime, shutdownDelegationRuntime } from '../lib/delegation-runtime-boot.js';

stopDelegationRuntimeWorker();
registerMockChatRunAdapter('opencode');
resetDelegationLifecycleForTest();
resetDelegationRuntimeHealth();

{
  const health = getDelegationRuntimeHealth();
  assert.equal(health.processAlive, true);
  assert.equal(typeof health.workerRunning, 'boolean');
  assert.equal(health.lifecycle.acceptingWork, true);
  assert.ok(health.version);
  assert.equal(health.counts.pendingMailbox >= 0, true);
}

{
  startDelegationRuntimeWorker({ intervalMs: 20 });
  await tickDelegationRuntime({ drainMailbox: false });
  const health = getDelegationRuntimeHealth();
  assert.equal(health.workerRunning, true);
  assert.equal(health.worker.lastTickFinishedAt > 0, true);
  stopDelegationRuntimeWorker();
  assert.equal(getDelegationRuntimeHealth().workerRunning, false);
}

{
  const file = getDelegationsDataPath();
  fs.writeFileSync(file, JSON.stringify({ v: 99, items: [{ id: 'future' }] }));
  let code = '';
  try {
    loadDelegations();
  } catch (err) {
    code = err?.code || '';
    assert.equal(err instanceof UnsupportedDelegationSchemaError, true);
  }
  assert.equal(code, 'DELEGATIONS_SCHEMA');
  assert.match(fs.readFileSync(file, 'utf8'), /"v":\s*99/);
  fs.writeFileSync(file, JSON.stringify({ v: 2, items: [] }));
}

{
  resetDelegationLifecycleForTest();
  setDelegationLifecycleState('initializing');
  assert.equal(isDelegationRuntimeAcceptingWork(), false);
  const service = createDelegationService({
    workspaceDirForAgent: () => ISOLATED_DATA_DIR,
    isModelAvailable: () => true,
  });
  const parent = addChat(crypto.randomUUID(), 'gate', null, ISOLATED_DATA_DIR, 'opencode/test', {
    agentTransport: 'opencode',
    sdkMode: 'agent',
  });
  const denied = await service.createAndStart({
    parentChatId: parent.id,
    sourceKind: 'text',
    taskText: 'nope',
    executor: { transport: 'opencode', model: 'opencode/test' },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'runtime_not_ready');
  resetDelegationLifecycleForTest();
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-lock-a-'));
  releaseDelegationOwnerLock();
  acquireDelegationOwnerLock({ dataDir: dir });
  const script = `
    import { acquireDelegationOwnerLock } from ${JSON.stringify(new URL('../lib/delegation-owner-lock.js', import.meta.url).href)};
    try {
      acquireDelegationOwnerLock({ dataDir: ${JSON.stringify(dir)} });
      console.log('ACQUIRED');
      process.exit(0);
    } catch (err) {
      console.log(err.code || err.message);
      process.exit(2);
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = await new Promise((resolve) => {
    let buf = '';
    child.stdout.on('data', (chunk) => { buf += String(chunk); });
    child.stderr.on('data', (chunk) => { buf += String(chunk); });
    child.on('close', () => resolve(buf));
  });
  assert.match(out, /DELEGATION_OWNER_LOCKED/);
  releaseDelegationOwnerLock({ dataDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cretli-lock-kill-'));
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireDelegationOwnerLock } from ${JSON.stringify(new URL('../lib/delegation-owner-lock.js', import.meta.url).href)};
    acquireDelegationOwnerLock({ dataDir: ${JSON.stringify(dir)} });
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  holder.kill('SIGKILL');
  await new Promise((resolve) => holder.on('close', resolve));
  acquireDelegationOwnerLock({ dataDir: dir });
  releaseDelegationOwnerLock({ dataDir: dir });
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  resetDelegationLifecycleForTest();
  await bootDelegationRuntime({ intervalMs: 50 });
  assert.equal(isDelegationRuntimeAcceptingWork(), true);
  const result = await shutdownDelegationRuntime({ timeoutMs: 2000 });
  assert.equal(result.timedOut, false);
  assert.equal(isDelegationRuntimeAcceptingWork(), false);
  resetDelegationLifecycleForTest();
}

console.log('delegation-phase2-runtime.test.js OK');
