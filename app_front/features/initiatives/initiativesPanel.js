import './cr-initiatives-panel.js';
import { whenViewContextScopedAccessAllowed } from '../../app/appShell/viewContextBridge.js';
import { getTodoWorkspaceFile, getTodoWorkspaceFolder, todoWorkspaceQuery } from '../todo/todoWorkspaceScope.js';

let revision = -1;

/** @returns {import('./cr-initiatives-panel.js').CrInitiativesPanel | null} */
const element = () => /** @type {any} */ (document.querySelector('cr-initiatives-panel'));

/** Loads the panel for this tab's view context (never the server's shared cwd). */
export async function refreshInitiativesPanel() {
  const el = element();
  if (!el) return;
  await whenViewContextScopedAccessAllowed();
  el.setScope({ viewQuery: todoWorkspaceQuery(), scopeKey: getTodoWorkspaceFile() || getTodoWorkspaceFolder() || 'default' });
  await el.reload();
}

export function initInitiativesPanel() {
  window.addEventListener('cr-initiatives-changed', (event) => {
    const next = Number((/** @type {CustomEvent} */ (event)).detail?.revision);
    // Only a newer workspace revision triggers a reload; the editor keeps its draft either way.
    if (!Number.isFinite(next) || next > revision) { revision = Number.isFinite(next) ? next : revision; if (isVisible()) void refreshInitiativesPanel(); }
  });
  window.addEventListener('cretli-view-context-changed', () => { if (isVisible()) void refreshInitiativesPanel(); });
  window.addEventListener('focus', () => { if (isVisible()) void refreshInitiativesPanel(); });
}

const isVisible = () => document.getElementById('plans-panel')?.classList.contains('active') === true;
