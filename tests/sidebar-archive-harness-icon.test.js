import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSidebarChatRowHtml } from '../app_front/features/sidebar/sidebarChatRowModel.js';
import {
  __resetSidebarArchiveGroupPassForTest,
  beginSidebarArchiveGroupPass,
  endSidebarArchiveGroupPass,
  getSidebarArchiveGroupRegistration,
  registerSidebarArchiveGroup,
} from '../app_front/features/sidebar/sidebarArchiveGroupPass.js';
import {
  __resetSidebarChatRowPassForTest,
  getSidebarChatRowRegistration,
} from '../app_front/features/sidebar/sidebarChatRowPass.js';
import { registerArchiveChatRowSliceDirect } from '../app_front/features/sidebar/sidebarArchiveChatRows.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Regression guard for "archive rows lose their harness icon": the archive
 * virtualiser re-registers the mounted slice with the archive group's own deps
 * (`registerArchiveChatRowSliceDirect(..., reg.deps)`). When the group was
 * registered with only `{ t, escapeHtml }`, every expanded archive row rendered
 * an empty `.sidebar-chat-item-harness` (no `<img>`), because
 * `buildSidebarChatRowHtml` reads `deps.resolveSidebarHarnessIcon`.
 */

test('registerArchiveGroupEntry passes full chat-row deps to the archive group', () => {
  const source = readFileSync(
    resolve(repoRoot, 'app_front/features/sidebar/sidebarView.js'),
    'utf8',
  );
  const start = source.indexOf('function registerArchiveGroupEntry');
  const end = source.indexOf('function registerWorkspaceGroupEntry', start);
  assert.ok(start >= 0 && end > start, 'registerArchiveGroupEntry must exist before registerWorkspaceGroupEntry');
  const body = source.slice(start, end);
  assert.match(
    body,
    /deps:\s*sidebarChatRowDeps\(\)/,
    'archive group deps must be sidebarChatRowDeps() so the virtualizer keeps harness icons/actions',
  );
});

test('archive virtual slice renders the harness icon when the group deps provide it', () => {
  __resetSidebarArchiveGroupPassForTest();
  __resetSidebarChatRowPassForTest();
  const deps = {
    t: (key) => key,
    escapeHtml: (value) => String(value ?? ''),
    resolveChatState: () => 'idle',
    getTerminalStateMeta: () => ({ tone: 'idle', label: 'Idle' }),
    getSidebarChatStateMeta: () => ({ tone: 'idle', label: 'Idle', activityKey: '' }),
    canPinChatToUrl: () => false,
    resolveSidebarHarnessIcon: () => 'opencode.svg',
    renderChatActionButtonsHtml: () => '',
  };
  beginSidebarArchiveGroupPass();
  registerSidebarArchiveGroup('/ws/archive', {
    sidebarKey: '/ws/archive',
    openSection: true,
    count: 1,
    activeChatId: '',
    archiveTree: [{
      chat: { id: 'arch-1', title: 'Archived', agentTransport: 'opencode' },
      level: 0,
      isLastChild: true,
      parentId: '',
      continuationLevels: [],
    }],
    deps,
  });
  endSidebarArchiveGroupPass();

  const reg = getSidebarArchiveGroupRegistration('/ws/archive');
  assert.ok(reg, 'archive group registration must be available to the virtualizer');
  registerArchiveChatRowSliceDirect(reg.archiveTree, 0, 1, '', reg.deps);
  const rowReg = getSidebarChatRowRegistration('arch-1');
  assert.ok(rowReg, 'archive row payload must be registered by the virtual slice');
  const html = buildSidebarChatRowHtml(rowReg.chat, rowReg.activeChatId, rowReg.opts, rowReg.deps);
  assert.match(html, /harness-icons\/opencode\.svg/, 'archive row must keep the harness icon');
});

test('buildSidebarChatRowHtml drops the icon when deps omit resolveSidebarHarnessIcon', () => {
  const html = buildSidebarChatRowHtml(
    { id: 'arch-2', title: 'Archived', agentTransport: 'opencode' },
    '',
    { archived: true, inArchiveList: true, archiveLogicalIndex: 1 },
    { t: (key) => key, escapeHtml: (value) => String(value ?? '') },
  );
  assert.doesNotMatch(html, /harness-icons\//);
});
