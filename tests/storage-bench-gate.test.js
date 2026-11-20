import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from '../scripts/storage-bench-gate.mjs';

const base = { id: 'g', metric: 'm', workload: 'w', primary: true, n: 10, minN: 5, budget: 100, actual: 50, method: 'x' };

describe('storage bench gate()', () => {
  it('keeps PASS and FAIL for finite values with enough samples', () => {
    assert.equal(gate(base).status, 'PASS');
    assert.equal(gate({ ...base, actual: 100 }).status, 'PASS');
    assert.equal(gate({ ...base, actual: 100.5 }).status, 'FAIL');
  });

  it('marks NaN, Infinity and missing values UNVERIFIED, not FAIL or PASS', () => {
    for (const actual of [NaN, Infinity, -Infinity, null, undefined]) {
      assert.equal(gate({ ...base, actual: /** @type {any} */ (actual) }).status, 'UNVERIFIED', String(actual));
    }
    for (const budget of [NaN, Infinity, null]) {
      assert.equal(gate({ ...base, budget: /** @type {any} */ (budget) }).status, 'UNVERIFIED', String(budget));
    }
  });

  it('marks too few or missing samples UNVERIFIED', () => {
    assert.equal(gate({ ...base, n: 4 }).status, 'UNVERIFIED');
    assert.equal(gate({ ...base, n: null }).status, 'UNVERIFIED');
  });
});
