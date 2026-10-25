import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { blockedCategory, groupBlockedByCategory, BLOCKED_CATEGORIES } from '../app_front/features/todo/todoBlockedView.js';
import { countDeferredRoots } from '../app_front/features/todo/todoTabCounts.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('backend causes and reason codes map onto five categories', () => {
  const cases = [
    [{ cause: 'parked' }, 'human'],
    [{ cause: 'parked', reasonCode: 'waits_for_date' }, 'date'],
    [{ cause: 'parked', reasonCode: 'env_infra' }, 'infra'],
    [{ cause: 'parked', reasonCode: 'needs_rescope' }, 'human'],
    [{ cause: 'parked', detail: 'review FAIL twice' }, 'review_fail'],
    [{ cause: 'backoff' }, 'date'],
    [{ cause: 'plan_unapproved' }, 'human'],
    [{ cause: 'blocked_sibling' }, 'human'],
    [{ cause: 'orphan' }, 'human'],
    [{ cause: 'dead_container' }, 'infra'],
    [{ cause: 'stale_worktree' }, 'stale_worktree'],
  ];
  for (const [entry, expected] of cases) assert.equal(blockedCategory(entry), expected, JSON.stringify(entry));
  const grouped = groupBlockedByCategory({ groups: [
    { cause: 'backoff', entries: [{ todoId: 'a' }] },
    { cause: 'orphan', entries: [{ todoId: 'b' }] },
  ] });
  assert.deepEqual(grouped.map((g) => g.category), ['human', 'date']);
  assert.equal(BLOCKED_CATEGORIES.length, 5);
});

test('deferred counter counts deferred roots only', () => {
  const items = [
    { id: '1', status: 'deferred' },
    { id: '2', status: 'deferred', parentId: '1' },
    { id: '3', status: 'ready' },
    { id: '4', status: 'deferred', parentId: '3' },
  ];
  assert.equal(countDeferredRoots(items), 2);
  assert.equal(countDeferredRoots([]), 0);
});

test('cr-tabs restores on workspaceKey change, exposes setCount, and the panel wires the deferred counter', () => {
  const tabs = read('app_front/components/ui/cr-tabs.js');
  assert.match(tabs, /updated\(changed\)[\s\S]*?changed\?\.has\('workspaceKey'\)[\s\S]*?this\._restore\(\)/);
  assert.match(tabs, /setCount\(/);
  const panel = read('app_front/features/todo/views/todoPanel.js');
  assert.match(panel, /cretli:todo-deferred-count-changed/);
  assert.match(panel, /setTabCount\('deferred'/);
  assert.ok(panel.indexOf("addEventListener('cr-tabs-change'") < panel.indexOf('tabs.workspaceKey = getTodo'));
});
