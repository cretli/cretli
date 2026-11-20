import { ISOLATED_DATA_DIR } from './helpers/isolated-data-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isReviewerMemberStartable } from '../lib/reviewer-member-startable.js';
import { registerChatRunAdapter, unregisterChatRunAdapter } from '../lib/chat-run-service.js';
import { clearHarnessUsageLimit, noteHarnessUsageLimit } from '../lib/harness-usage-limits.js';

/**
 * @param {object} settings
 * @returns {void}
 */
function writeSettings(settings) {
  fs.writeFileSync(path.join(ISOLATED_DATA_DIR, 'config.json'), JSON.stringify(settings));
}

/**
 * @param {string} transport
 * @returns {void}
 */
function registerStubAdapter(transport) {
  registerChatRunAdapter({ transport, start: async () => ({}) });
}

test('a model that left the enabled favorites is not startable; another effort of it is', () => {
  registerStubAdapter('codex');
  try {
    writeSettings({ codexChatEnabledModels: ['gpt-6-luna'] });
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra::effort=low' }), false);
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-luna::effort=high' }), true);
    writeSettings({ codexChatEnabledModels: ['gpt-6-astra::effort=medium'] });
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra::effort=low' }), true);
  } finally {
    unregisterChatRunAdapter('codex');
  }
});

test('a disabled harness or one without an adapter is not startable; missing credentials alone are', () => {
  writeSettings({ codexChatEnabledModels: ['gpt-6-astra'] });
  // No adapter registered for codex in this test.
  assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra' }), false);
  registerStubAdapter('codex');
  try {
    // The adapter alone is enough here: the credential `ready` probe is ignored.
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra' }), true);
    writeSettings({ codexChatEnabledModels: ['gpt-6-astra'], enabledHarnesses: ['claude'] });
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra' }), false);
  } finally {
    unregisterChatRunAdapter('codex');
  }
});

test('unreliable information keeps the member', () => {
  registerStubAdapter('codex');
  try {
    // No favorites configured for the harness.
    writeSettings({ claudeChatEnabledModels: ['opus'] });
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra' }), true);
    // Unknown harness or empty model.
    assert.equal(isReviewerMemberStartable({ harness: 'nope', model: 'x' }), true);
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: '' }), true);
  } finally {
    unregisterChatRunAdapter('codex');
  }
});

test('a quota lockout never makes an enabled favorite unstartable', () => {
  registerStubAdapter('codex');
  try {
    writeSettings({ codexChatEnabledModels: ['gpt-6-astra'] });
    noteHarnessUsageLimit({
      harness: 'codex',
      model: 'gpt-6-astra',
      message: 'usage limit reached; resets at 2099-01-01T00:00:00Z',
    });
    assert.equal(isReviewerMemberStartable({ harness: 'codex', model: 'gpt-6-astra' }), true);
  } finally {
    clearHarnessUsageLimit('codex', 'gpt-6-astra');
    unregisterChatRunAdapter('codex');
  }
});
