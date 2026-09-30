/**
 * Unit tests for the persisted-local-chat state classifier.
 *
 * These tests inject the memoized provider list, host version, and hostMin
 * comparator, so no plugin root, filesystem, or settings store is touched. The
 * real discovery + HTTP wiring is covered by
 * `tests/chat-create-harness-guard.test.js`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENT_TRANSPORTS } from '../lib/agent-transport.js';
import {
  PERSISTED_LOCAL_CHAT_STATE_CODES,
  isPersistedLocalChatTransport,
  resolvePersistedLocalChatState,
  resolvePersistedLocalChatStates,
} from '../lib/agent-harness/persisted-local-chat-state.js';

const CODES = PERSISTED_LOCAL_CHAT_STATE_CODES;

/**
 * @param {object} [overrides]
 * @returns {object}
 */
function providerRow(overrides = {}) {
  return {
    id: 'alpha',
    enabled: true,
    hostMin: '0.1.0',
    capabilities: { chat: true },
    ...overrides,
  };
}

/**
 * Compatibility stub that always reports a compatible, evaluated host.
 *
 * @returns {Promise<{ evaluated: boolean, compatible: boolean, deferred: boolean, reason: string }>}
 */
async function compatibleHost() {
  return { evaluated: true, compatible: true, deferred: false, reason: 'compatible' };
}

/**
 * Build resolver options with a fixed provider list and a compatible host.
 *
 * @param {object[]} providers
 * @param {object} [extra]
 * @returns {object}
 */
function optionsWith(providers, extra = {}) {
  return {
    providers,
    hostVersion: '9.9.9',
    evaluateCompat: compatibleHost,
    ...extra,
  };
}

test('non-local transports are never classified as local', () => {
  for (const raw of [undefined, null, '', '   ', 0, false, [], {}, 'cursor', 'CURSOR', '  cursor  ']) {
    assert.equal(isPersistedLocalChatTransport(raw), false, `raw=${JSON.stringify(raw)}`);
  }
  for (const id of AGENT_TRANSPORTS) {
    assert.equal(isPersistedLocalChatTransport(id), false, `builtin=${id}`);
    assert.equal(isPersistedLocalChatTransport(id.toUpperCase()), false, `builtin=${id}`);
  }
});

test('a local candidate id is detected in any case', () => {
  for (const raw of ['alpha', 'ALPHA', '  alpha  ', 'my-harness']) {
    assert.equal(isPersistedLocalChatTransport(raw), true, `raw=${raw}`);
  }
});

test('non-local transports produce no state, singular or batched', async () => {
  for (const raw of ['sdk', 'cursor', '', null, 42]) {
    assert.equal(await resolvePersistedLocalChatState(raw, optionsWith([])), null, `raw=${raw}`);
  }
  const states = await resolvePersistedLocalChatStates(
    ['sdk', 'openrouter', 'cursor', '', 'alpha'],
    optionsWith([providerRow()]),
  );
  assert.deepEqual([...states.keys()], ['alpha']);
});

test('absent root, discovery failure, and a missing plugin all map to plugin_unavailable', async () => {
  // No providers at all: unconfigured root, discovery failure, or missing manifest.
  const absent = await resolvePersistedLocalChatStates(['alpha'], optionsWith([]));
  assert.deepEqual(absent.get('alpha'), { code: CODES.unavailable, runnable: false });

  // Discovery throws: must degrade, not throw.
  const thrown = await resolvePersistedLocalChatStates(['alpha'], {
    hostVersion: '9.9.9',
    evaluateCompat: compatibleHost,
    listProviders: async () => {
      throw new Error('plugin root exploded at /home/secret/plugins');
    },
  });
  assert.deepEqual(thrown.get('alpha'), { code: CODES.unavailable, runnable: false });

  // A provider list that only contains other ids: the chat's plugin is missing.
  const missing = await resolvePersistedLocalChatStates(['ghost'], optionsWith([providerRow()]));
  assert.deepEqual(missing.get('ghost'), { code: CODES.unavailable, runnable: false });
});

test('discovered but not explicitly enabled maps to plugin_disabled', async () => {
  const states = await resolvePersistedLocalChatStates(
    ['alpha'],
    optionsWith([providerRow({ enabled: false })]),
  );
  assert.deepEqual(states.get('alpha'), { code: CODES.disabled, runnable: false });
});

test('disabled takes precedence over a missing chat capability', async () => {
  const states = await resolvePersistedLocalChatStates(
    ['alpha'],
    optionsWith([providerRow({ enabled: false, capabilities: { chat: false } })]),
  );
  assert.deepEqual(states.get('alpha'), { code: CODES.disabled, runnable: false });
});

test('enabled without capabilities.chat maps to plugin_capability', async () => {
  for (const capabilities of [{ chat: false }, {}, undefined, null]) {
    const states = await resolvePersistedLocalChatStates(
      ['alpha'],
      optionsWith([providerRow({ capabilities })]),
    );
    assert.deepEqual(
      states.get('alpha'),
      { code: CODES.capability, runnable: false },
      `capabilities=${JSON.stringify(capabilities)}`,
    );
  }
});

test('an evaluated incompatible hostMin maps to host_incompatible', async () => {
  const states = await resolvePersistedLocalChatStates(['alpha'], optionsWith([providerRow({ hostMin: '99.0.0' })], {
    hostVersion: '0.1.0',
    evaluateCompat: async () => ({
      evaluated: true,
      compatible: false,
      deferred: false,
      reason: 'host_too_old',
    }),
  }));
  assert.deepEqual(states.get('alpha'), { code: CODES.incompatible, runnable: false });
});

test('a compatible hostMin maps to not_loaded and never claims runnable', async () => {
  const states = await resolvePersistedLocalChatStates(['alpha'], optionsWith([providerRow()]));
  assert.deepEqual(states.get('alpha'), { code: CODES.notLoaded, runnable: false });
});

test('a deferred hostMin maps to not_loaded, matching the loader policy', async () => {
  for (const reason of ['semver_unavailable', 'version_unparseable']) {
    const states = await resolvePersistedLocalChatStates(['alpha'], optionsWith([providerRow()], {
      evaluateCompat: async () => ({
        evaluated: false,
        compatible: null,
        deferred: true,
        reason,
      }),
    }));
    assert.deepEqual(states.get('alpha'), { code: CODES.notLoaded, runnable: false });
  }
});

test('a throwing hostMin comparator degrades to not_loaded', async () => {
  const states = await resolvePersistedLocalChatStates(['alpha'], optionsWith([providerRow()], {
    evaluateCompat: async () => {
      throw new Error('semver blew up');
    },
  }));
  assert.deepEqual(states.get('alpha'), { code: CODES.notLoaded, runnable: false });
});

test('the real hostMin comparator is used when none is injected', async () => {
  const incompatible = await resolvePersistedLocalChatStates(['alpha'], {
    providers: [providerRow({ hostMin: '99.0.0' })],
    hostVersion: '0.1.0',
  });
  assert.deepEqual(incompatible.get('alpha'), { code: CODES.incompatible, runnable: false });

  // An unparseable version defers instead of guessing, so the read stays safe.
  const deferred = await resolvePersistedLocalChatStates(['alpha'], {
    providers: [providerRow({ hostMin: 'not-semver' })],
    hostVersion: '0.1.0',
  });
  assert.deepEqual(deferred.get('alpha'), { code: CODES.notLoaded, runnable: false });
});

test('the emitted state is exactly a safe code plus runnable:false', async () => {
  const poisoned = providerRow({
    hostMin: 'not-semver',
    entry: '/home/secret/plugins/alpha/index.mjs',
    error: 'boom /home/secret/plugins/alpha/index.mjs',
  });
  const states = await resolvePersistedLocalChatStates(['alpha'], optionsWith([poisoned]));
  const state = states.get('alpha');
  assert.deepEqual(Object.keys(state).sort(), ['code', 'runnable']);
  assert.equal(state.runnable, false);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('/home'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('index.mjs'), false);
  assert.equal(serialized.includes('boom'), false);
});

test('only a local transport is resolved, and repeated ids are de-duplicated', async () => {
  let calls = 0;
  const states = await resolvePersistedLocalChatStates(
    ['alpha', 'sdk', 'alpha', 'ALPHA', 'beta'],
    optionsWith([providerRow(), providerRow({ id: 'beta', enabled: false })], {
      evaluateCompat: async () => {
        calls += 1;
        return { evaluated: true, compatible: true, deferred: false, reason: 'compatible' };
      },
    }),
  );
  assert.deepEqual([...states.keys()].sort(), ['alpha', 'beta']);
  assert.equal(calls, 1, 'the host gate runs once per distinct local id');
  assert.deepEqual(states.get('alpha'), { code: CODES.notLoaded, runnable: false });
  assert.deepEqual(states.get('beta'), { code: CODES.disabled, runnable: false });
});

test('settings and env are threaded to the memoized provider list', async () => {
  const settings = { enabledLocalHarnesses: ['alpha'] };
  const env = { CRETLI_HARNESS_PLUGIN_ROOT: '/tmp/plugins' };
  let received = null;
  const states = await resolvePersistedLocalChatStates(['alpha'], {
    settings,
    env,
    hostVersion: '1.0.0',
    evaluateCompat: compatibleHost,
    listProviders: async (options) => {
      received = options;
      return [providerRow()];
    },
  });
  assert.equal(received.settings, settings);
  assert.equal(received.env, env);
  assert.deepEqual(states.get('alpha'), { code: CODES.notLoaded, runnable: false });
});

test('settings are read lazily and only when a local transport is present', async () => {
  let reads = 0;
  const readSettings = () => {
    reads += 1;
    return { enabledLocalHarnesses: ['alpha'] };
  };
  let received = null;
  await resolvePersistedLocalChatStates(['sdk', 'alpha'], {
    readSettings,
    hostVersion: '1.0.0',
    evaluateCompat: compatibleHost,
    listProviders: async (options) => {
      received = options;
      return [providerRow()];
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(received.settings, { enabledLocalHarnesses: ['alpha'] });

  await resolvePersistedLocalChatStates(['sdk'], {
    readSettings,
    listProviders: async () => [],
  });
  assert.equal(reads, 1);
});

test('an injected provider list is never re-read from settings', async () => {
  let reads = 0;
  await resolvePersistedLocalChatStates(['alpha'], {
    providers: [providerRow()],
    readSettings: () => {
      reads += 1;
      return {};
    },
    hostVersion: '1.0.0',
    evaluateCompat: compatibleHost,
  });
  assert.equal(reads, 0);
});

console.log('persisted-local-chat-state.test.js OK');
