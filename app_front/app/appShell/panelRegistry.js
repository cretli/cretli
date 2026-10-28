/**
 * Shared panel policy for shell modules.
 *
 * The runtime owns the DOM wiring; the immutable lists and the last-main-panel
 * tracker below are the single registry surface routers and header chrome use.
 */
export const MAIN_PANELS = Object.freeze([
  'chat', 'terminal', 'tasks', 'todo', 'browser', 'files',
  'git', 'github', 'logs', 'instances', 'tests',
]);

export const RESTORABLE_PANELS = Object.freeze([...MAIN_PANELS, 'settings']);


let lastMainPanelId = 'chat';

/** Remembers the last main-bar panel so Settings can return to it. */
export function setLastMainPanel(panelId) {
  if (!MAIN_PANELS.includes(panelId)) return;
  lastMainPanelId = panelId;
}

export function getLastMainPanel() {
  return MAIN_PANELS.includes(lastMainPanelId) ? lastMainPanelId : 'chat';
}
