import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSidebarWorkspaceActive,
  sortSidebarWorkspaces,
} from '../app_front/features/sidebar/sidebarWorkspaceSort.js';

const workspaces = [
  { name: 'zeta', workspaceFile: '/ws/zeta.code-workspace', sidebarKey: '/ws/zeta.code-workspace' },
  { name: 'alpha', workspaceFile: '/ws/alpha.code-workspace', sidebarKey: '/ws/alpha.code-workspace' },
  { name: 'cretli', workspaceFile: '/ws/cretli.code-workspace', sidebarKey: '/ws/cretli.code-workspace' },
];

test('sortSidebarWorkspaces keeps alphabetical order when active is not pinned', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: false,
    activeWorkspaceFile: '/ws/cretli.code-workspace',
    activeWorkspaceFolder: '/ws/cretli',
    getPreferredWorkspaceFolder: () => '/ws/cretli',
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['alpha', 'cretli', 'zeta']
  );
});

test('sortSidebarWorkspaces pins the active workspace when the option is on', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: true,
    activeWorkspaceFile: '/ws/cretli.code-workspace',
    activeWorkspaceFolder: '/ws/cretli',
    getPreferredWorkspaceFolder: (key) =>
      key.includes('cretli') ? '/ws/cretli' : '',
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['cretli', 'alpha', 'zeta']
  );
});

test('isSidebarWorkspaceActive matches file and preferred folder', () => {
  const actual = isSidebarWorkspaceActive(workspaces[2], {
    activeWorkspaceFile: '/ws/cretli.code-workspace',
    activeWorkspaceFolder: '/ws/cretli',
    getPreferredWorkspaceFolder: () => '/ws/cretli',
  });
  assert.equal(actual, true);
});

test('sortSidebarWorkspaces applies the custom order first', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: false,
    order: ['/ws/cretli.code-workspace', '/ws/zeta.code-workspace'],
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['cretli', 'zeta', 'alpha']
  );
});

test('sortSidebarWorkspaces appends unordered workspaces alphabetically at the end', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: false,
    order: ['/ws/zeta.code-workspace'],
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['zeta', 'alpha', 'cretli']
  );
});

test('sortSidebarWorkspaces keeps pinActiveOnTop above the custom order', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: true,
    activeWorkspaceFile: '/ws/alpha.code-workspace',
    activeWorkspaceFolder: '/ws/alpha',
    getPreferredWorkspaceFolder: () => '/ws/alpha',
    order: ['/ws/cretli.code-workspace', '/ws/zeta.code-workspace', '/ws/alpha.code-workspace'],
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['alpha', 'cretli', 'zeta']
  );
});

test('sortSidebarWorkspaces ignores stale keys in the custom order', () => {
  const sorted = sortSidebarWorkspaces(workspaces, {
    pinActiveOnTop: false,
    order: ['/ws/removed.code-workspace', '/ws/alpha.code-workspace'],
  });
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['alpha', 'cretli', 'zeta']
  );
});
