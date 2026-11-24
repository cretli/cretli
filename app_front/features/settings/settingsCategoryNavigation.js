import { initSettingsSidebarTree } from './settingsSidebarTree.js';

/** Keep legacy tab elements and their click wiring; the sidebar owns visible navigation. */
export function initSettingsCategoryNavigation() {
  const nav = document.getElementById('settings-tabs');
  if (!nav || nav.dataset.categoriesReady) return;
  nav.dataset.categoriesReady = 'true';
  initSettingsSidebarTree();
}
