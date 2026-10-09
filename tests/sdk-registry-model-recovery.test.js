import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { removeIsolatedDataDir } from './helpers/isolated-data-dir.js';
import { loadSettings, saveSettings } from '../lib/persist/settings.js';
import {
  applySdkRegistryModelFallback,
  buildSdkRegistryModelRecoveryRetryMessage,
  buildSdkRegistryModelRejectedMessage,
  buildStrictRegistryModelRejectedMessage,
  isInvalidSdkRegistryModelError,
  isSdkRunRegistryModelRejection,
  quarantineRejectedSdkFavorite,
  shouldRetrySdkRegistryModelRecovery,
} from '../lib/sdk/sdk-registry-model-recovery.js';

const registryMessage =
  'Invalid parameters for registry model: "grok-4.7::context=500k,fast=false"';

// The run/send path sees the rejection as a failed run status plus the message.
assert.equal(isInvalidSdkRegistryModelError(new Error(registryMessage)), true);
assert.equal(isInvalidSdkRegistryModelError(registryMessage), true);
assert.equal(
  isInvalidSdkRegistryModelError(new Error('Invalid parameters for registry model: grok-4.7')),
  false,
);
assert.equal(isInvalidSdkRegistryModelError(new Error('Request failed with status 500')), false);

assert.equal(isSdkRunRegistryModelRejection('error', registryMessage), true);
assert.equal(isSdkRunRegistryModelRejection('run_failed', registryMessage), true);
assert.equal(isSdkRunRegistryModelRejection('finished', registryMessage), false);
assert.equal(isSdkRunRegistryModelRejection('error', 'some other failure'), false);

// Quarantine removes every sibling preset of the rejected model id.
saveSettings({
  chatEnabledModels: [
    'grok-4.7::context=256k,fast=false',
    'grok-4.7::context=500k,fast=false',
    'composer-2',
  ],
});
assert.equal(quarantineRejectedSdkFavorite('grok-4.7::context=500k,fast=false'), true);
assert.deepEqual(loadSettings().chatEnabledModels, ['composer-2']);
assert.equal(quarantineRejectedSdkFavorite('claude-opus-4-8'), false);
assert.deepEqual(loadSettings().chatEnabledModels, ['composer-2']);

// A run/send rejection switches the room and chat to Auto (non-strict).
saveSettings({ chatEnabledModels: ['grok-4.7::context=500k,fast=false'] });
const room = {
  modelId: 'grok-4.7::context=500k,fast=false',
  _lastRequestedModelId: 'grok-4.7::context=500k,fast=false',
  _strictModelRequested: false,
  _lastModelFallback: null,
};
const chatModelUpdates = [];
const fallback = applySdkRegistryModelFallback({
  room,
  requestedModelId: room._lastRequestedModelId,
  strictFast: false,
  updateChatModel: (modelValue) => chatModelUpdates.push(modelValue),
});
assert.equal(fallback.applied, true);
assert.equal(fallback.blockedByStrict, false);
assert.equal(fallback.attemptedModelId, 'grok-4.7::context=500k,fast=false');
assert.equal(fallback.fallbackModelId, 'auto');
assert.equal(room.modelId, 'auto');
assert.equal(room._lastRequestedModelId, 'auto');
assert.equal(room._strictModelRequested, false);
assert.equal(room._lastModelFallback, fallback);
assert.deepEqual(chatModelUpdates, ['auto']);
assert.equal('chatEnabledModels' in loadSettings(), false);

// Strict fast blocks the automatic fallback but still quarantines + resets.
saveSettings({ chatEnabledModels: ['grok-4.7::context=500k,fast=true'] });
const strictRoom = {
  modelId: 'grok-4.7::context=500k,fast=true',
  _lastRequestedModelId: 'grok-4.7::context=500k,fast=true',
  _strictModelRequested: true,
  _lastModelFallback: null,
};
const strictUpdates = [];
const strictFallback = applySdkRegistryModelFallback({
  room: strictRoom,
  requestedModelId: strictRoom._lastRequestedModelId,
  strictFast: true,
  updateChatModel: (modelValue) => strictUpdates.push(modelValue),
});
assert.equal(strictFallback.applied, false);
assert.equal(strictFallback.blockedByStrict, true);
assert.equal(strictRoom.modelId, 'auto');
assert.deepEqual(strictUpdates, ['auto']);
assert.match(buildStrictRegistryModelRejectedMessage(strictFallback.attemptedModelId), /Strict SDK model/);

// A room already on Auto has nothing to fall back from.
assert.equal(
  applySdkRegistryModelFallback({
    room: { modelId: 'auto', _lastRequestedModelId: 'auto' },
    requestedModelId: 'auto',
    strictFast: false,
  }),
  null,
);

// One retry is the budget; the next call surfaces the error instead of looping.
assert.equal(shouldRetrySdkRegistryModelRecovery(0), true);
assert.equal(shouldRetrySdkRegistryModelRecovery(1), false);
assert.match(buildSdkRegistryModelRecoveryRetryMessage(1), /Auto/);
assert.match(buildSdkRegistryModelRejectedMessage('grok-4.7'), /grok-4.7/);

removeIsolatedDataDir();
console.log('sdk-registry-model-recovery.test.js OK');
