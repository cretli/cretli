import { settingsSidebarTransition } from './settingsTreeModel.js';
import { getSharedSpaNavigation } from '../../app/appShell/spaNavigationBridge.js';

export function openSettingsSidebar() {
  return (/** @type {any} */ (getSharedSpaNavigation()))?.navigate({ panel: 'settings', settingsTab: '' }, { explicit: true });
}

export function syncSettingsSidebarMode(panel, tab = '') {
  const body = globalThis.document?.body;
  if (!body || body.classList.contains('embed-mode')) return;
  const transition = settingsSidebarTransition(body.dataset.sidebarMode, panel, tab);
  body.dataset.sidebarMode = transition.mode;
  globalThis.window?.dispatchEvent?.(new CustomEvent('cr-settings-sidebar-route', { detail: { ...transition, tab } }));
}
