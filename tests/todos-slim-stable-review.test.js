import './helpers/isolated-data-dir.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { slimTodoForList } from '../lib/routes/todos-routes.js';

test('a slim row does not change when only the review aggregate computedAt changes', () => {
  const item = (computedAt) => ({
    id: 't1',
    title: 'parent',
    status: 'doing',
    review: { generation: 3, aggregate: { reviewed: 2, total: 3, counts: { passed: 2 }, computedAt } },
  });
  const a = slimTodoForList(item('2026-10-24T02:35:07.767Z'), { lean: true });
  const b = slimTodoForList(item('2026-10-24T02:35:11.499Z'), { lean: true });
  assert.deepEqual(a, b);
  assert.equal(a.review.aggregate.reviewed, 2, 'the aggregate counts the badge shows stay');
  assert.equal('computedAt' in a.review.aggregate, false);
});
