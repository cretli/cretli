/**
 * The `metrics` field on a delegation record (task "Metryki per delegacja",
 * subtask 4): created as an all-null shape, normalized for legacy rows, merged
 * (not replaced) on patch, and validated so a corrupt value cannot poison the
 * observed aggregation.
 */

import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import {
  createDelegationRecord,
  getDelegationById,
  getDelegationsDataPath,
  loadDelegations,
  updateDelegationRecord,
} from '../lib/persist/delegations-persist.js';
import { getDelegationStoreBackend } from '../lib/persist/delegation-store-backend.js';

const NULL_METRICS = {
  tokens_in: null,
  tokens_out: null,
  tokens_out_per_sec: null,
  tool_calls_n: null,
  files_changed: null,
  lines_added: null,
  lines_removed: null,
};

// A freshly created record carries the complete nullable shape.
const created = createDelegationRecord({
  parentChatId: 'metrics-parent',
  executor: { transport: 'sdk', model: 'model-a' },
  assignment: 'implement',
});
assert.deepEqual(created.metrics, NULL_METRICS, 'create yields the all-null metrics shape');

// A partial patch stores what it knows and keeps the rest null.
const patched = updateDelegationRecord(created.id, {
  metrics: { tokens_out: 500, tokens_in: 1000, files_changed: 3, tool_calls_n: 7 },
});
assert.equal(patched.metrics.tokens_out, 500);
assert.equal(patched.metrics.files_changed, 3);
assert.equal(patched.metrics.tool_calls_n, 7);
assert.equal(patched.metrics.lines_added, null, 'unset fields stay null');

// A later patch merges, so a second write does not wipe the first.
const merged = updateDelegationRecord(created.id, { metrics: { lines_added: 40, lines_removed: 5 } });
assert.equal(merged.metrics.tokens_out, 500, 'the earlier metric survives a merge');
assert.equal(merged.metrics.lines_added, 40);
assert.equal(merged.metrics.lines_removed, 5);

// Invalid values are validated away on write.
const dirty = updateDelegationRecord(created.id, { metrics: { lines_added: -7, tokens_out: 'x' } });
assert.equal(dirty.metrics.tokens_out, null, 'a non-numeric overwrite is rejected');
assert.equal(dirty.metrics.lines_added, null, 'a negative count is rejected');

// Round-trips through the store as-is.
const reloaded = getDelegationById(created.id);
assert.equal(reloaded.metrics.lines_removed, 5, 'metrics persist across reads');

// Legacy rows on disk that predate the `metrics` key default to the null shape
// when read back, so the API and aggregation never see `undefined`. Only the
// JSON backend can be seeded with a raw file (sqlite serializes whole records).
if (getDelegationStoreBackend() === 'json') {
  writeFileSync(getDelegationsDataPath(), JSON.stringify({
    v: 2,
    items: [{
      id: 'legacy-metrics-row',
      parentChatId: 'legacy-parent',
      status: 'completed',
      assignment: 'implement',
      executor: { transport: 'sdk', model: 'model-a' },
    }],
  }), 'utf8');
  const legacy = loadDelegations().find((r) => r.id === 'legacy-metrics-row');
  assert.deepEqual(legacy.metrics, NULL_METRICS, 'a stored row without metrics defaults to the null shape');
}

console.log('delegation-metrics-persist.test.js OK');
