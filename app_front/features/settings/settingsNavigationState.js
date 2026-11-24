/** Route-driven state keeps form DOM intact when returning to the list. */
export function settingsNavigationView(tab = '') {
  return tab ? 'content' : 'list';
}

export function syncSettingsNavigationView(tab = '') {
  const panel = globalThis.document?.getElementById('settings-panel');
  if (!panel) return;
  const view = settingsNavigationView(tab);
  const changed = panel.dataset.settingsView !== view;
  panel.dataset.settingsView = view;
  if (changed && globalThis.window?.matchMedia?.('(max-width: 768px)').matches) {
    const selector = view === 'content' ? '#header-menu-btn' : '#sidebar-settings-tree [aria-current="page"]';
    const target = /** @type {HTMLElement | null} */ (globalThis.document?.querySelector?.(selector));
    target?.focus({ preventScroll: true });
  }
}

export function returnToSettingsList() {
  return document.getElementById('settings-panel')?.dataset.settingsView === 'content';
}
