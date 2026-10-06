import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatBelongsToWorkspaceGroup,
  findWorkspaceFileContainingFolder,
  listCloneFoldersForWorkspaceFile,
  resolveWorkspaceTargetForChat,
  workspaceDisplayNameForFolder,
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

test('a shared projects directory does not inherit the DOMQ watcher name', () => {
  const catalog = [
    { name: 'ar2oor-domq', workspaceFile: '/projects/domq.code-workspace', workspaceDir: '/projects' },
    { name: 'Fade', workspaceFile: '/projects/fresh.code-workspace', workspaceDir: '/projects' },
    { name: 'Freshthing', workspaceFile: '/projects/fresh.code-workspace', sidebarKey: '/projects/fresh.code-workspace#clone-shop', workspaceDir: '/projects' },
  ];
  const preferred = (key) => key.includes('clone') ? '/shop' : key.includes('domq') ? '/domq' : '/fade';
  assert.equal(workspaceDisplayNameForFolder(catalog, '/projects', preferred), 'projects');
  assert.equal(workspaceDisplayNameForFolder(catalog, '/domq', preferred), 'ar2oor-domq');
  assert.equal(workspaceDisplayNameForFolder(catalog, '/fade', preferred), 'Fade');
  assert.equal(workspaceDisplayNameForFolder(catalog, '/shop', preferred), 'Freshthing');
});

test('a workspace without a configured folder can still name its own directory', () => {
  assert.equal(workspaceDisplayNameForFolder([{ name: 'Plain', workspaceDir: '/plain' }], '/plain'), 'Plain');
});

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

test('chat without workspaceFile matches parent group by workspaceFolder', () => {
  // Watcher orchestrator chats and their delegation sub-chats have only
  // workspaceFolder set (workspaceFile is null). They should appear in the
  // sidebar under the matching workspace group.
  const watcherChat = { workspaceFolder: parentFolder };
  assert.equal(
    chatBelongsToWorkspaceGroup(watcherChat, {
      workspaceFile,
      groupFolder: parentFolder,
      isClone: false,
      cloneFolders: [],
    }),
    true,
  );
});

test('resolveWorkspaceTargetForChat switches file and folder from the chat', () => {
  const catalog = [
    {
      workspaceFile,
      workspaceDir: parentFolder,
      folders: [{ resolvedPath: landingFolder }],
    },
  ];
  const active = { workspaceFile: '/ws/other.code-workspace', workspaceFolder: '/ws/other' };
  assert.deepEqual(
    resolveWorkspaceTargetForChat(
      { workspaceFile, workspaceFolder: landingFolder },
      active,
      catalog,
    ),
    { workspaceFile, workspaceFolder: landingFolder },
  );
  assert.equal(
    resolveWorkspaceTargetForChat(
      { workspaceFile, workspaceFolder: landingFolder },
      { workspaceFile, workspaceFolder: landingFolder },
      catalog,
    ),
    null,
  );
});

test('resolveWorkspaceTargetForChat finds the file from a folder-only chat', () => {
  const catalog = [
    { workspaceFile, workspaceDir: parentFolder, folders: [{ resolvedPath: parentFolder }] },
  ];
  assert.equal(findWorkspaceFileContainingFolder(catalog, parentFolder), workspaceFile);
  assert.deepEqual(
    resolveWorkspaceTargetForChat(
      { workspaceFolder: parentFolder },
      { workspaceFile: '/ws/other.code-workspace', workspaceFolder: '/ws/other' },
      catalog,
    ),
    { workspaceFile, workspaceFolder: parentFolder },
  );
  assert.equal(
    resolveWorkspaceTargetForChat({ title: 'legacy' }, { workspaceFile }, catalog),
    null,
  );
});

test('resolveWorkspaceTargetForChat uses the sidebar preferred folder', () => {
  const sidebarKey = `${workspaceFile}#clone-landing`;
  const rows = [
    { workspaceFile, sidebarKey: workspaceFile, isClone: false, workspaceDir: parentFolder },
    { workspaceFile, sidebarKey, isClone: true, workspaceDir: parentFolder },
  ];
  const prefer = (key) => (key === sidebarKey ? landingFolder : parentFolder);
  assert.equal(findWorkspaceFileContainingFolder(rows, landingFolder, prefer), workspaceFile);
  assert.deepEqual(
    resolveWorkspaceTargetForChat(
      { workspaceFolder: landingFolder },
      { workspaceFile, workspaceFolder: parentFolder },
      rows,
      prefer,
    ),
    { workspaceFile, workspaceFolder: landingFolder },
  );
});

test('a legacy chat in the workspace-file directory selects the configured project folder', () => {
  const file = '/projects/esystent.pl.code-workspace';
  const catalog = [{ workspaceFile: file, workspaceDir: '/projects' }];
  const preferred = () => '/esystent.pl';
  const chat = { workspaceFile: file, workspaceFolder: '/projects' };
  assert.deepEqual(resolveWorkspaceTargetForChat(chat,
    { workspaceFile: '/projects/other.code-workspace', workspaceFolder: '/other' },
    catalog, preferred,
  ), { workspaceFile: file, workspaceFolder: '/esystent.pl' });
  assert.equal(resolveWorkspaceTargetForChat(chat,
    { workspaceFile: file, workspaceFolder: '/esystent.pl' }, catalog, preferred,
  ), null, 'chat alignment must not restore projects after the sidebar selected esystent');
  assert.deepEqual(resolveWorkspaceTargetForChat(chat, {}, [], preferred),
    { workspaceFile: file, workspaceFolder: '/esystent.pl' }, 'works before the catalog loads');
});

test('legacy folder resolution preserves explicit project, clone and folder-only watcher scopes', () => {
  const file = '/projects/esystent.pl.code-workspace';
  const clone = `${file}#clone-projects`;
  const catalog = [
    { workspaceFile: file, workspaceDir: '/projects' },
    { workspaceFile: file, sidebarKey: clone, isClone: true, workspaceDir: '/projects' },
  ];
  const preferred = (key) => key === clone ? '/projects' : '/esystent.pl';
  for (const chat of [
    { workspaceFile: file, workspaceFolder: '/libs' },
    { workspaceFile: file, workspaceFolder: '/projects' },
    { workspaceFolder: '/projects' },
  ]) {
    assert.deepEqual(resolveWorkspaceTargetForChat(chat, {}, catalog, preferred),
      { workspaceFile: file, workspaceFolder: chat.workspaceFolder });
  }
  assert.deepEqual(resolveWorkspaceTargetForChat({ workspaceFile: file }, {}, catalog, preferred),
    { workspaceFile: file, workspaceFolder: '/esystent.pl' });
  assert.deepEqual(resolveWorkspaceTargetForChat(
    { workspaceFile: file, workspaceFolder: '/projects' }, {}, catalog,
  ), { workspaceFile: file, workspaceFolder: '/projects' }, 'no configured default keeps the saved folder');
});

test('a folder-only watcher chooses its primary workspace before a read-only inclusion', () => {
  const catalog = [
    { workspaceFile: '/ws/fresh.code-workspace', folders: [{ resolvedPath: '/ws/domq' }] },
    { workspaceFile: '/ws/domq.code-workspace', folders: [{ resolvedPath: '/ws/domq' }] },
  ];
  const prefer = (file) => file.includes('fresh') ? '/ws/fade' : '/ws/domq';
  assert.deepEqual(resolveWorkspaceTargetForChat(
    { workspaceFolder: '/ws/domq' },
    { workspaceFile: '/ws/fresh.code-workspace', workspaceFolder: '/ws/fade' },
    catalog, prefer,
  ), { workspaceFile: '/ws/domq.code-workspace', workspaceFolder: '/ws/domq' });
});

test('chat without workspaceFile follows the exact clone folder', () => {
  const watcherChat = { workspaceFolder: parentFolder };
  assert.equal(
    chatBelongsToWorkspaceGroup(watcherChat, {
      workspaceFile,
      groupFolder: landingFolder,
      isClone: false,
      cloneFolders: [],
    }),
    false,
    'wrong folder',
  );
  assert.equal(
    chatBelongsToWorkspaceGroup(watcherChat, {
      workspaceFile,
      groupFolder: parentFolder,
      isClone: true,
      cloneFolders: [parentFolder],
    }),
    true,
    'matching clone group',
  );
  assert.equal(chatBelongsToWorkspaceGroup(watcherChat, {
    workspaceFile,
    groupFolder: parentFolder,
    isClone: false,
    cloneFolders: [parentFolder],
  }), false, 'the parent must not duplicate a chat owned by its clone');
});

test('Freshthing folder-only Scout chats are visible only in Freshthing, including archived chats', () => {
  const file = '/projects/ar2oor-fresh.code-workspace';
  const fresh = '/www/freshthing.pl';
  const fade = '/www/fade.freshthing.pl';
  const chats = [
    { id: 'scout', title: '[Scout] freshthing.pl', workspaceFolder: fresh },
    { id: 'review', title: '[Scout] review', workspaceFolder: fresh, parentChatId: 'scout' },
    { id: 'archive', title: '[Scout] freshthing.pl', workspaceFolder: fresh, archivedAt: '2026-10-06' },
    { id: 'fade', title: '[Scout] fade.freshthing.pl', workspaceFolder: fade },
    { id: 'unknown', title: '[Scout]' },
  ];
  const cloneFolders = [fresh];
  const inGroup = (groupFolder, isClone) => chats.filter((chat) => chatBelongsToWorkspaceGroup(chat,
    { workspaceFile: file, groupFolder, isClone, cloneFolders })).map((chat) => chat.id);
  assert.deepEqual(inGroup(fresh, true), ['scout', 'review', 'archive']);
  assert.deepEqual(inGroup(fade, false), ['fade']);
  assert.deepEqual(inGroup('/www/unrelated', true), []);
});
