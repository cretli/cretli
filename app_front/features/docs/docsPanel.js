import './cr-docs-panel.js';
import { docsScope } from './docsScope.js';

export async function refreshDocsPanel() {
  const panel = document.querySelector('cr-docs-panel');
  if (!panel) return;
  const scope = await docsScope();
  panel.setScope(scope);
  await panel.reload();
}

const visible = () => document.getElementById('docs-panel')?.classList.contains('active');
window.addEventListener('cretli-view-context-changed', () => { if (visible()) void refreshDocsPanel(); });
window.addEventListener('focus', () => { if (visible()) void refreshDocsPanel(); });
