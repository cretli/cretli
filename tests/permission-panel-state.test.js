import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPermissionPanelState } from '../app_front/features/approval/permissionPanelState.js';

const settings = { ok: true, harnessPermissionControls: { claude: { files: false } } };
const grant = { id: 'example', harness: 'claude', scope: 'tool' };
const fail = () => { throw new Error('API unavailable'); };

test('grant request failure leaves controls available with their saved values', async () => {
  const state = await loadPermissionPanelState({ harness: 'claude', getSettings: () => settings, getPermissionGrants: fail });
  assert.equal(state.controls.files, false);
  assert.equal(state.controlsError, '');
  assert.equal(state.grantsError, 'load');
});

test('settings request failure leaves grants available for revocation', async () => {
  const state = await loadPermissionPanelState({ harness: 'claude', getSettings: fail, getPermissionGrants: () => ({ ok: true, grants: [grant] }) });
  assert.equal(state.controls, null);
  assert.equal(state.controlsError, 'load');
  assert.equal(state.grantsError, '');
  assert.deepEqual(state.grants, [grant]);
});

test('old backend produces an explicit restart message instead of pretending settings loaded', async () => {
  const state = await loadPermissionPanelState({ harness: 'claude', getSettings: () => ({ ok: true }), getPermissionGrants: () => ({ ok: false }) });
  assert.equal(state.controls, null);
  assert.equal(state.controlsError, 'serverUpdate');
  assert.equal(state.grantsError, 'load');
});

test('retry recovers both sections and filters grants for the harness', async () => {
  const state = await loadPermissionPanelState({ harness: 'claude', getSettings: () => settings, getPermissionGrants: () => ({ ok: true, grants: [grant, { harness: 'qwen', scope: 'harness' }] }) });
  assert.equal(state.controls.files, false);
  assert.equal(state.controlsError, '');
  assert.equal(state.grantsError, '');
  assert.deepEqual(state.grants, [grant]);
});
