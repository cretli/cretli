import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkspaceInList,
  pickNewChatWorkspaceFile,
  workspaceOptionHtml,
} from '../app_front/features/chat/newChatWorkspacePick.js';

const fileWorkspace = {
  id: '/ws/acme.code-workspace',
  workspaceFile: '/ws/acme.code-workspace',
};
const folderWorkspace = {
  id: 'cretli:ws:shop',
  workspaceFile: 'cretli:ws:shop',
};

test('isWorkspaceInList matches folder workspace ids', () => {
  assert.equal(isWorkspaceInList([folderWorkspace], 'cretli:ws:shop'), true);
  assert.equal(isWorkspaceInList([fileWorkspace], 'cretli:ws:shop'), false);
});

test('pickNewChatWorkspaceFile keeps a selected folder workspace missing from a stale list', () => {
  const actual = pickNewChatWorkspaceFile({
    workspaces: [fileWorkspace],
    selectedWorkspaceFile: 'cretli:ws:shop',
    headerWorkspaceFile: 'cretli:ws:shop',
  });
  assert.equal(actual, 'cretli:ws:shop');
});

test('pickNewChatWorkspaceFile prefers header over the first registry row', () => {
  const actual = pickNewChatWorkspaceFile({
    workspaces: [fileWorkspace, folderWorkspace],
    selectedWorkspaceFile: '',
    headerWorkspaceFile: 'cretli:ws:shop',
  });
  assert.equal(actual, 'cretli:ws:shop');
});

test('pickNewChatWorkspaceFile keeps an in-list selection when the header differs', () => {
  const actual = pickNewChatWorkspaceFile({
    workspaces: [fileWorkspace, folderWorkspace],
    selectedWorkspaceFile: '/ws/acme.code-workspace',
    headerWorkspaceFile: 'cretli:ws:shop',
  });
  assert.equal(actual, '/ws/acme.code-workspace');
});

test('pickNewChatWorkspaceFile uses the first row only when nothing is selected', () => {
  const actual = pickNewChatWorkspaceFile({
    workspaces: [fileWorkspace, folderWorkspace],
    selectedWorkspaceFile: '',
    headerWorkspaceFile: '',
  });
  assert.equal(actual, '/ws/acme.code-workspace');
});

test('workspace option escapes the workspace and folder names', () => {
  const html = workspaceOptionHtml({
    id: '/ws/a"b',
    name: '<b>ws</b>',
    folders: [{ name: '<img src=x onerror=alert(1)>' }, { name: 'plain' }],
  });
  assert.equal(
    html,
    '<option value="/ws/a&quot;b">&lt;b&gt;ws&lt;/b&gt; (&lt;img src=x onerror=alert(1)&gt;, plain)</option>',
  );
  assert.ok(!html.includes('<img'));
});
