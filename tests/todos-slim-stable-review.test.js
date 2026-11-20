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

test('the lean list keeps a report source that sits past the body preview', () => {
  const meta = { v: 1, hash: 'h', sources: [
    { at: '2026-10-01T00:00:00.000Z', workspace: '~/www/old', client: '', mode: 'agent' },
    { at: '2026-10-02T00:00:00.000Z', workspace: '~/www/my-app', client: 'Acme', mode: 'operator', chatId: 'x'.repeat(100) },
  ] };
  const slim = slimTodoForList({ id: 'r', title: 'report', status: 'idea', body: `<!-- cretli-feedback ${JSON.stringify(meta)} -->\nx` }, { lean: true });
  assert.deepEqual(slim.feedbackSource, { workspace: '~/www/my-app', client: 'Acme', mode: 'operator' });
  assert.equal('feedbackSource' in slimTodoForList({ id: 't', title: 'plain', status: 'idea', body: 'plain' }, { lean: true }), false);
});
