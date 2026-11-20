/**
 * Settings → Workspace Watcher.
 *
 * One deterministic guard per workspace. The UI is intentionally explicit: the
 * operator picks off/observe/autopilot, tunes the guardrails, and can nudge the
 * watcher (tick / run cycle / claim next) without turning on autopilot.
 *
 * This module only wires the panel up. State lives in `watcher/store.js`
 * (signals), the form and live regions are Lit elements under
 * `watcher/components/`, and the controllers sit next to them in `watcher/`.
 */

import { sharedState } from '../../state/index.js';
import { installPerfProbe } from '../../lib/perfProbe.js';
import '../../components/ui/cr-bar-select.js';
import { watcherWorkspaceScopeChanged } from '../watcher/watcherWorkspaceScope.js';
import { mountWatcherPanel } from './watcher/components/watcherPanel.js';
import { createWorkspaceOverride, resetWorkspaceOverrides, revokeWorkspaceOverride } from './watcher/overrides.js';
import { refreshWorkspaceWatcherSettingsPanel } from './watcher/refresh.js';
import { applyWatcherTab, stopWatcherTicker, syncWatcherTabFromSettings } from './watcher/runtime.js';
import { ws } from './watcher/store.js';
import './workspace-watcher-settings.scss';

export { refreshWorkspaceWatcherSettingsPanel };

/** Mount the panel once and subscribe to live changes. Safe to call repeatedly. */
export function initWorkspaceWatcherSettingsPanel() {
  const root = document.getElementById('settings-watcher-root');
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  installPerfProbe();
  mountWatcherPanel(root);
  // The override list is re-rendered on every full refresh, so a delegated
  // listener on the root survives the re-render.
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const revokeId = target.closest('[data-watcher-override-revoke]')?.getAttribute('data-watcher-override-revoke');
    if (revokeId) {
      void revokeWorkspaceOverride(revokeId);
      return;
    }
    if (target.closest('[data-watcher-override-create]')) {
      void createWorkspaceOverride(root);
      return;
    }
    if (target.closest('[data-watcher-override-reset]')) {
      void resetWorkspaceOverrides();
    }
  });
  sharedState.onWatcherChanged(() => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true') return;
    // A live change must not rebuild the form (that would erase unsaved policy
    // edits); it only updates the store the live regions render from.
    void refreshWorkspaceWatcherSettingsPanel({ full: false });
  });
  // Switching the active workspace changes which watcher row the form edits.
  // Leaving the previous workspace's policy on screen is one Save away from
  // writing it to the wrong workspace, so a switch rebuilds the form. While the
  // watcher settings pane is hidden the refresh is deferred to the next open
  // (see `syncWorkspaceWatcherSettingsTab`).
  const refreshOnActiveWorkspaceChange = () => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true' || panel.dataset.rendered !== 'true') return;
    if (!watcherWorkspaceScopeChanged(ws.renderedWorkspaceFolder)) return;
    const section = /** @type {HTMLElement | null} */ (document.querySelector('.settings-section[data-settings-tab="watcher"]'));
    if (section && section.hidden) return;
    void refreshWorkspaceWatcherSettingsPanel();
  };
  window.addEventListener('cretli-active-workspace-changed', refreshOnActiveWorkspaceChange);
  window.addEventListener('cretli-workspace-updated', refreshOnActiveWorkspaceChange);
  window.addEventListener('cr-lang-changed', () => {
    const panel = document.getElementById('settings-watcher-root');
    if (!panel || panel.dataset.bound !== 'true') return;
    // Every region re-renders its labels; a dirty Scout draft is left alone.
    ws.langRev += 1;
    if (!ws.peek('scoutEditorState').dirty) ws.touch('scoutEditorState');
  });
  // The per-second ticker is pure background work while the document is hidden;
  // stop it and let the next visible refresh rebind it.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopWatcherTicker();
  });
  void refreshWorkspaceWatcherSettingsPanel();
}

/** Follow the settings-nav sub-tab without rebuilding the form. */
export function syncWorkspaceWatcherSettingsTab() {
  const root = document.getElementById('settings-watcher-root');
  if (!root || root.dataset.rendered !== 'true') return;
  // The active workspace may have moved while the pane was hidden (the change
  // event is skipped there); re-open on a full refresh instead of showing the
  // previous workspace's policy.
  if (watcherWorkspaceScopeChanged(ws.renderedWorkspaceFolder)) {
    void refreshWorkspaceWatcherSettingsPanel();
    return;
  }
  syncWatcherTabFromSettings();
  applyWatcherTab(root);
}
