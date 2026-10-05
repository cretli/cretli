/**
 * Sidebar Workspace Watcher badge contract.
 *
 * The badge store is fed by the existing agent-presence frame, so the store
 * logic and the render helper are imported directly; the sidebar/chat wiring is
 * asserted from source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyWorkspaceWatcherModeLocal,
  applyWorkspaceWatcherPresence,
  formatWorkspaceAutopilotBadge,
  getWorkspaceWatcherBadge,
  listEnabledWorkspaceWatcherPinnedChats,
  listWorkspaceWatcherPinnedChats,
  renderWorkspaceAutopilotBadgeHtml,
  resolveWorkspaceWatcherBadge,
  workspaceWatcherPresenceRevision,
  __resetWorkspaceWatcherBadgeForTest,
} from '../app_front/features/sidebar/workspaceAutopilotBadge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('autopilot presence produces a badge; observe and off do not', () => {
  __resetWorkspaceWatcherBadgeForTest();
  const changed = applyWorkspaceWatcherPresence([
    { workspaceFolder: '/repo/alpha', mode: 'autopilot', paused: false, stopReason: '', activeCycleChatId: 'c1' },
    { workspaceFolder: '/repo/beta', mode: 'observe' },
    { workspaceFolder: '/repo/gamma', mode: 'off' },
  ]);
  assert.equal(changed, true);
  assert.equal(formatWorkspaceAutopilotBadge(getWorkspaceWatcherBadge('/repo/alpha')).state, 'active');
  assert.equal(formatWorkspaceAutopilotBadge(getWorkspaceWatcherBadge('/repo/beta')), null);
  assert.equal(formatWorkspaceAutopilotBadge(getWorkspaceWatcherBadge('/repo/gamma')), null);
});

test('paused and stopped autopilot have distinct badge states', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([
    { workspaceFolder: '/repo/paused', mode: 'autopilot', paused: true },
    { workspaceFolder: '/repo/stopped', mode: 'autopilot', stopReason: 'loop_same_findings' },
  ]);
  assert.equal(formatWorkspaceAutopilotBadge(getWorkspaceWatcherBadge('/repo/paused')).state, 'paused');
  const stopped = formatWorkspaceAutopilotBadge(getWorkspaceWatcherBadge('/repo/stopped'));
  assert.equal(stopped.state, 'stopped');
  assert.match(stopped.title, /loop_same_findings/);
});

test('the store only bumps its revision on a real change', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([{ workspaceFolder: '/repo/a', mode: 'autopilot' }]);
  const first = workspaceWatcherPresenceRevision();
  assert.equal(applyWorkspaceWatcherPresence([{ workspaceFolder: '/repo/a', mode: 'autopilot' }]), false);
  assert.equal(workspaceWatcherPresenceRevision(), first);
  assert.equal(applyWorkspaceWatcherPresence([{ workspaceFolder: '/repo/a', mode: 'autopilot', paused: true }]), true);
  assert.ok(workspaceWatcherPresenceRevision() > first);
});

test('resolve walks the workspace folders and renders the badge html', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([{ workspaceFolder: '/repo/folder', mode: 'autopilot' }]);
  const workspace = { workspaceFile: '/repo/x.code-workspace', folders: [{ resolvedPath: '/repo/folder' }] };
  assert.ok(resolveWorkspaceWatcherBadge(workspace, ''));
  const html = renderWorkspaceAutopilotBadgeHtml(workspace, '', (v) => String(v));
  assert.match(html, /sidebar-workspace-autopilot/);
  assert.match(html, /data-state="active"/);
});

test('multiple active cycles are represented by count and chat list', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([{
    workspaceFolder: '/repo/multi',
    mode: 'autopilot',
    activeCycleCount: 2,
    activeCycleChatId: 'chat-a',
    activeCycleChatIds: ['chat-a', 'chat-b'],
  }]);
  const badge = getWorkspaceWatcherBadge('/repo/multi');
  assert.equal(badge.activeCycleCount, 2);
  assert.deepEqual(badge.activeCycleChatIds, ['chat-a', 'chat-b']);
  const formatted = formatWorkspaceAutopilotBadge(badge);
  assert.equal(formatted.state, 'active');
  assert.equal(formatted.count, 2);
  assert.match(formatted.label, /2/);
  assert.match(formatted.title, /2 active cycles/);
  const html = renderWorkspaceAutopilotBadgeHtml({ folders: [{ resolvedPath: '/repo/multi' }] }, '', (v) => String(v));
  assert.match(html, /data-cycle-count="2"/);
});

test('a pinned but disabled workspace does not shadow an active badge and flips locally', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([
    { workspaceFolder: '/repo/off-pinned', mode: 'off', pinnedChatId: 'pin-1' },
    { workspaceFolder: '/repo/live', mode: 'autopilot' },
  ]);
  const workspace = {
    folders: [{ resolvedPath: '/repo/off-pinned' }, { resolvedPath: '/repo/live' }],
  };
  assert.equal(resolveWorkspaceWatcherBadge(workspace, '')?.mode, 'autopilot', 'off row skipped');
  assert.equal(applyWorkspaceWatcherModeLocal('/repo/off-pinned', 'autopilot'), true);
  assert.equal(getWorkspaceWatcherBadge('/repo/off-pinned').mode, 'autopilot');
  // A workspace that never had a watcher row still flips optimistically, so the
  // "show all workspaces" switch responds before the presence frame arrives.
  assert.equal(applyWorkspaceWatcherModeLocal('/repo/never', 'autopilot'), true);
  assert.equal(getWorkspaceWatcherBadge('/repo/never').mode, 'autopilot');
  assert.equal(applyWorkspaceWatcherModeLocal('/repo/never', 'autopilot'), false, 'idempotent');
});

test('a clone only sees its own folder, not the source workspace siblings', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([{ workspaceFolder: '/repo/cretli', mode: 'autopilot' }]);
  const clone = {
    isClone: true,
    workspaceDir: '/repo',
    folders: [{ resolvedPath: '/repo/cretli' }, { resolvedPath: '/repo/cretli.com' }],
  };
  assert.equal(
    resolveWorkspaceWatcherBadge(clone, '/repo/cretli.com'),
    null,
    'clone does not inherit a sibling folder badge',
  );
  assert.equal(
    renderWorkspaceAutopilotBadgeHtml(clone, '/repo/cretli.com', (v) => String(v)),
    '',
    'clone header renders no badge',
  );
  assert.equal(
    resolveWorkspaceWatcherBadge(clone, '/repo/cretli')?.mode,
    'autopilot',
    'clone still shows a watcher on its own folder',
  );
  const sourceGroup = { workspaceDir: '/repo', folders: clone.folders };
  assert.equal(
    resolveWorkspaceWatcherBadge(sourceGroup, '')?.mode,
    'autopilot',
    'a non-clone workspace group still searches its folders',
  );
});

test('only enabled pinned watchers list in the default sidebar view', () => {
  __resetWorkspaceWatcherBadgeForTest();
  applyWorkspaceWatcherPresence([
    { workspaceFolder: '/repo/on', mode: 'autopilot', pinnedChatId: 'pin-on' },
    { workspaceFolder: '/repo/observe', mode: 'observe', pinnedChatId: 'pin-observe' },
    { workspaceFolder: '/repo/off', mode: 'off', pinnedChatId: 'pin-off' },
  ]);
  const all = listWorkspaceWatcherPinnedChats().map((row) => row.workspaceFolder);
  assert.deepEqual(all, ['/repo/observe', '/repo/off', '/repo/on'], 'off rows stay in the store');
  const enabled = listEnabledWorkspaceWatcherPinnedChats().map((row) => row.workspaceFolder);
  assert.deepEqual(enabled, ['/repo/observe', '/repo/on'], 'off rows are filtered out');
});

test('sidebar and chat wiring consume the presence store', () => {
  const sidebar = readSource('app_front/features/sidebar/sidebarView.js');
  const chat = readSource('app_front/chat.js');
  const liveSync = readSource('app_front/features/chat/chatListLiveSync.js');
  assert.match(sidebar, /renderWorkspaceAutopilotBadgeHtml/);
  assert.match(sidebar, /workspaceWatcherPresenceRevision/);
  assert.match(chat, /applyWorkspaceWatcherPresence\(msg\.watchers\)/);
  assert.match(liveSync, /onWatcherChanged/);
  assert.match(liveSync, /workspace-watcher/);
});

test('the Workspace section renders the master and per-workspace toggles', () => {
  const sidebar = readSource('app_front/features/sidebar/sidebarView.js');
  assert.match(sidebar, /renderWatcherToggleHtml/);
  assert.match(sidebar, /class="sidebar-watcher-toggle" role="switch"/);
  assert.match(sidebar, /data-watcher-scope/);
  assert.match(sidebar, /setWorkspaceWatcherStartsEnabled/);
  assert.match(sidebar, /setWorkspaceWatcherEnabled/);
  assert.match(sidebar, /workspaceWatcherRuntimeRevision/);
});

test('the Workspace header can expand to every workspace', () => {
  const sidebar = readSource('app_front/features/sidebar/sidebarView.js');
  assert.match(sidebar, /readWatcherShowAllFlag/);
  assert.match(sidebar, /writeWatcherShowAllFlag/);
  assert.match(sidebar, /sidebar-watcher-show-all/);
  assert.match(sidebar, /data-watcher-show-all/);
  assert.match(sidebar, /watcherShowAllShow/);
  assert.match(sidebar, /watcherShowAllHide/);
  // The default view is the enabled-watcher list; "show all" reveals off rows.
  assert.match(sidebar, /listEnabledWorkspaceWatcherPinnedChats/);
  assert.match(sidebar, /watcherNoneEnabled/);
  // The flag is part of the layout signature, so toggling repaints the list.
  assert.match(sidebar, /\(readWatcherShowAllFlag\(\) \? '1' : '0'\)/);
});
