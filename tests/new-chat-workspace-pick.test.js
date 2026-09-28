import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isWorkspaceInList,
  pickNewChatWorkspaceFile,
} from '../app_front/features/chat/newChatWorkspacePick.js';

const fileWorkspace = {
  id: '/ws/domq.code-workspace',
  workspaceFile: '/ws/domq.code-workspace',
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
    selectedWorkspaceFile: '/ws/domq.code-workspace',
    headerWorkspaceFile: 'cretli:ws:shop',
  });
  assert.equal(actual, '/ws/domq.code-workspace');
});

test('pickNewChatWorkspaceFile uses the first row only when nothing is selected', () => {
  const actual = pickNewChatWorkspaceFile({
    workspaces: [fileWorkspace, folderWorkspace],
    selectedWorkspaceFile: '',
    headerWorkspaceFile: '',
  });
  assert.equal(actual, '/ws/domq.code-workspace');
});
