import assert from 'node:assert/strict';
import {
  SERVER_RESTART_ACTION,
  canRestartServer,
  resolveServerRestartGate,
} from '../lib/server-restart-policy.js';

assert.equal(SERVER_RESTART_ACTION, 'restart-server');

const inputDevEnv = { NODE_ENV: 'development' };
const inputProdEnv = { NODE_ENV: 'production' };
const inputEmptyEnv = {};

assert.equal(canRestartServer(inputDevEnv), true);
assert.equal(canRestartServer(inputEmptyEnv), true);
assert.equal(canRestartServer(inputProdEnv), false);

const actualInvalid = resolveServerRestartGate({
  action: 'restart-build',
  env: inputDevEnv,
});
const expectedInvalid = { allowed: false, status: 400, errorKey: 'generic.invalidAction' };
assert.deepEqual(actualInvalid, expectedInvalid);

const actualBoth = resolveServerRestartGate({
  action: 'restart-both',
  env: inputDevEnv,
});
assert.deepEqual(actualBoth, expectedInvalid);

const actualProd = resolveServerRestartGate({
  action: SERVER_RESTART_ACTION,
  env: inputProdEnv,
});
const expectedProd = { allowed: false, status: 403, errorKey: 'dev.restartDisabled' };
assert.deepEqual(actualProd, expectedProd);

const actualBusy = resolveServerRestartGate({
  action: SERVER_RESTART_ACTION,
  isRestartScheduled: true,
  env: inputDevEnv,
});
const expectedBusy = { allowed: false, status: 409, errorKey: 'dev.restartInProgress' };
assert.deepEqual(actualBusy, expectedBusy);

const actualAllowed = resolveServerRestartGate({
  action: SERVER_RESTART_ACTION,
  isRestartScheduled: false,
  env: inputDevEnv,
});
const expectedAllowed = { allowed: true, status: 202 };
assert.deepEqual(actualAllowed, expectedAllowed);

console.log('server-restart-policy.test.js: ok');
