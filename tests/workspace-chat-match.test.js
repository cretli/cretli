import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatBelongsToWorkspaceGroup,
  listCloneFoldersForWorkspaceFile,
} from '../app_front/features/sidebar/workspaceChatMatch.js';

const workspaceFile = '/ws/app.code-workspace';
const parentFolder = '/ws/app';
const landingFolder = '/ws/landing';
const workspaces = [
  { workspaceFile, sidebarKey: workspaceFile, isClone: false },
  {
    workspaceFile,
    sidebarKey: `${workspaceFile}#clone-landing`,
    isClone: true,
  },
];

test('listCloneFoldersForWorkspaceFile returns clone folders only', () => {
  const actual = listCloneFoldersForWorkspaceFile(
    workspaces,
    workspaceFile,
    (sidebarKey) => (String(sidebarKey).includes('clone') ? landingFolder : parentFolder),
  );
  assert.deepEqual(actual, [landingFolder]);
});

test('clone group keeps chats in its folder only', () => {
  const cloneChat = { workspaceFile, workspaceFolder: landingFolder };
  const parentChat = { workspaceFile, workspaceFolder: parentFolder };
  const params = {
    workspaceFile,
    groupFolder: landingFolder,
    isClone: true,
    cloneFolders: [landingFolder],
  };
  assert.equal(chatBelongsToWorkspaceGroup(cloneChat, params), true);
  assert.equal(chatBelongsToWorkspaceGroup(parentChat, params), false);
});

test('parent group hides chats that belong to a clone folder', () => {
  const cloneChat = { workspaceFile, workspaceFolder: landingFolder };
  const parentChat = { workspaceFile, workspaceFolder: parentFolder };
  const params = {
    workspaceFile,
    groupFolder: parentFolder,
    isClone: false,
    cloneFolders: [landingFolder],
  };
  assert.equal(chatBelongsToWorkspaceGroup(cloneChat, params), false);
  assert.equal(chatBelongsToWorkspaceGroup(parentChat, params), true);
});

test('parent group keeps chats without a folder', () => {
  const actual = chatBelongsToWorkspaceGroup(
    { workspaceFile },
    {
      workspaceFile,
      groupFolder: parentFolder,
      isClone: false,
      cloneFolders: [landingFolder],
    },
  );
  assert.equal(actual, true);
});

test('clone group does not take chats without a folder', () => {
  const actual = chatBelongsToWorkspaceGroup(
    { workspaceFile },
    {
      workspaceFile,
      groupFolder: landingFolder,
      isClone: true,
      cloneFolders: [landingFolder],
    },
  );
  assert.equal(actual, false);
});
