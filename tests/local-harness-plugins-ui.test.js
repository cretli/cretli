/**
 * Pure-logic tests for the Settings → Harness local plugin section.
 *
 * No DOM and no HTTP: only the exported pure helpers are exercised.
 */
import assert from 'node:assert/strict';
import {
  buildEnabledLocalHarnessesPatch,
  filterLocalHarnessRows,
  isLocalHarnessRunnable,
  nextEnabledLocalHarnessIds,
  normalizeLocalHarnessIds,
  orphanSavedLocalHarnessIds,
} from '../app_front/features/settings/localHarnessPlugins.js';

// --- normalizeLocalHarnessIds -------------------------------------------------
assert.deepEqual(normalizeLocalHarnessIds(['A', 'a', '', ' b ', 5, null]), ['a', 'b']);
assert.deepEqual(normalizeLocalHarnessIds('alpha'), []);
assert.deepEqual(normalizeLocalHarnessIds(null), []);

// --- filterLocalHarnessRows: origin + safe metadata only ----------------------
const rows = filterLocalHarnessRows([
  { id: 'sdk', label: 'Cursor SDK' }, // built-in row: no local origin
  {
    id: 'alpha',
    label: 'Alpha Harness',
    description: 'Does alpha things',
    version: '1.2.3',
    origin: 'local',
    state: 'not_loaded',
    enabled: true,
    available: false,
    ready: false,
    entry: './index.js',
    path: '/secret/plugins/alpha',
    capabilities: { chat: true },
  },
  { id: 'BETA', label: 42, origin: 'local', state: 'weird' },
  null,
  { origin: 'local' },
]);
assert.deepEqual(rows.map((row) => row.id), ['alpha', 'beta']);
assert.equal(rows[0].label, 'Alpha Harness');
assert.equal(rows[0].description, 'Does alpha things');
assert.equal(rows[0].version, '1.2.3');
assert.equal(rows[0].state, 'not_loaded');
// Safe metadata only: host-internal fields must not survive the filter.
assert.ok(!('entry' in rows[0]));
assert.ok(!('path' in rows[0]));
assert.ok(!('capabilities' in rows[0]));
// Fallback label when the manifest label is not a usable string.
assert.equal(rows[1].label, 'beta');
assert.deepEqual(filterLocalHarnessRows([{ origin: 'builtin', id: 'sdk' }, { origin: 'local' }]), []);
assert.deepEqual(filterLocalHarnessRows(undefined), []);

// --- nextEnabledLocalHarnessIds: discovered-only, order, dedup ----------------
assert.deepEqual(
  nextEnabledLocalHarnessIds({ discoveredIds: ['alpha', 'beta', 'gamma'], checkedIds: ['gamma', 'alpha'] }),
  ['alpha', 'gamma'],
);
// Built-in ids, the legacy cursor alias, and undiscovered orphans are dropped.
assert.deepEqual(
  nextEnabledLocalHarnessIds({ discoveredIds: ['alpha'], checkedIds: ['alpha', 'sdk', 'cursor', 'ghost'] }),
  ['alpha'],
);
// Order follows the discovered catalog and duplicates collapse.
assert.deepEqual(
  nextEnabledLocalHarnessIds({ discoveredIds: ['alpha', 'beta', 'alpha'], checkedIds: ['beta', 'BETA', 'alpha'] }),
  ['alpha', 'beta'],
);
// Empty selection is a valid "disable all locals".
assert.deepEqual(nextEnabledLocalHarnessIds({ discoveredIds: ['alpha'], checkedIds: [] }), []);
assert.deepEqual(nextEnabledLocalHarnessIds(), []);

// --- orphanSavedLocalHarnessIds ----------------------------------------------
assert.deepEqual(
  orphanSavedLocalHarnessIds({ discoveredIds: ['alpha'], savedIds: ['alpha', 'ghost', 'SDK'] }),
  ['ghost', 'sdk'],
);
assert.deepEqual(orphanSavedLocalHarnessIds({ discoveredIds: ['alpha'], savedIds: ['alpha'] }), []);

// --- buildEnabledLocalHarnessesPatch: only that field -------------------------
const patch = buildEnabledLocalHarnessesPatch(['Alpha', 'alpha', 'beta']);
assert.deepEqual(Object.keys(patch), ['enabledLocalHarnesses']);
assert.deepEqual(patch.enabledLocalHarnesses, ['alpha', 'beta']);

// --- isLocalHarnessRunnable: not_loaded and unknown are unavailable ----------
assert.equal(isLocalHarnessRunnable({ state: 'not_loaded', available: false }), false);
assert.equal(isLocalHarnessRunnable({ state: 'weird', available: true, ready: true }), false);
assert.equal(isLocalHarnessRunnable({ state: 'loaded', available: true, ready: true }), true);
assert.equal(isLocalHarnessRunnable(null), false);

console.log('local-harness-plugins-ui.test.js OK');
