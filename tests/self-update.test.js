import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLogLine,
  buildUpdateStatusPayload,
  getUpdateStatus,
  inspectUpdateRepo,
  resolveUpdateApplyGate,
  resolveUpdateRef,
  shortSha,
} from '../lib/self-update.js';
import { canRestartServer } from '../lib/server-restart-policy.js';

assert.equal(shortSha('abcdef1234567890'), 'abcdef1');
assert.equal(shortSha(''), '');

const actualRefDefault = resolveUpdateRef({});
assert.deepEqual(actualRefDefault, {
  remote: 'origin',
  branch: 'master',
  ref: 'origin/master',
});

const actualRefCustom = resolveUpdateRef({ CRETLI_UPDATE_REF: 'origin/feat/foo' });
assert.deepEqual(actualRefCustom, {
  remote: 'origin',
  branch: 'feat/foo',
  ref: 'origin/feat/foo',
});

const actualRefInvalid = resolveUpdateRef({ CRETLI_UPDATE_REF: '../evil' });
assert.deepEqual(actualRefInvalid, {
  remote: 'origin',
  branch: 'master',
  ref: 'origin/master',
});

const actualNoRepoGate = resolveUpdateApplyGate({ isRepo: false, busy: false });
assert.deepEqual(actualNoRepoGate, { allowed: false, status: 400, errorKey: 'update.noRepo' });

const actualBusyGate = resolveUpdateApplyGate({ isRepo: true, busy: true });
assert.deepEqual(actualBusyGate, { allowed: false, status: 409, errorKey: 'update.busy' });

const actualAllowedGate = resolveUpdateApplyGate({ isRepo: true, busy: false });
assert.deepEqual(actualAllowedGate, { allowed: true, status: 202 });

const actualNoRepo = buildUpdateStatusPayload({
  version: '0.2.0',
  isRepo: false,
  localSha: '',
  remoteSha: '',
  busy: false,
  phase: 'idle',
  logTail: [],
  canRestart: canRestartServer({ NODE_ENV: 'development' }),
});
assert.equal(actualNoRepo.canApply, false);
assert.equal(actualNoRepo.isRepo, false);
assert.equal(actualNoRepo.behind, false);
assert.equal(actualNoRepo.canRestart, true);

const actualBusy = buildUpdateStatusPayload({
  version: '0.2.0',
  isRepo: true,
  localSha: 'aaaaaaaaaaaaaaaa',
  remoteSha: 'bbbbbbbbbbbbbbbb',
  busy: true,
  phase: 'npm',
  logTail: ['phase: npm'],
  canRestart: true,
});
assert.equal(actualBusy.canApply, false);
assert.equal(actualBusy.behind, true);
assert.equal(actualBusy.localSha, 'aaaaaaa');
assert.equal(actualBusy.busy, true);

const actualProd = buildUpdateStatusPayload({
  version: '0.2.0',
  isRepo: true,
  localSha: '1111111',
  remoteSha: '2222222',
  busy: false,
  phase: 'idle',
  canRestart: canRestartServer({ NODE_ENV: 'production' }),
});
assert.equal(actualProd.canApply, true);
assert.equal(actualProd.canRestart, false);
assert.equal(actualProd.behind, true);

const actualLog = appendLogLine(['a'], 'b', 2);
assert.deepEqual(actualLog, ['a', 'b']);
const actualLogTrim = appendLogLine(['a', 'b'], 'c', 2);
assert.deepEqual(actualLogTrim, ['b', 'c']);

const inputNotRepo = mkdtempSync(path.join(os.tmpdir(), 'cretli-not-repo-'));
writeFileSync(path.join(inputNotRepo, 'package.json'), JSON.stringify({ version: '1.2.3' }));
const actualInspect = inspectUpdateRepo({ projectRoot: inputNotRepo });
assert.deepEqual(actualInspect, {
  isRepo: false,
  localSha: '',
  remoteSha: '',
  fetchError: '',
});
const actualNotRepoStatus = getUpdateStatus({
  projectRoot: inputNotRepo,
  check: false,
  env: { NODE_ENV: 'production' },
});
assert.equal(actualNotRepoStatus.isRepo, false);
assert.equal(actualNotRepoStatus.canApply, false);
assert.equal(actualNotRepoStatus.canRestart, false);
assert.equal(actualNotRepoStatus.version, '1.2.3');
assert.equal(actualNotRepoStatus.localSha, '');
assert.equal(actualNotRepoStatus.remoteSha, '');

console.log('self-update.test.js: ok');
