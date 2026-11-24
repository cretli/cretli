import { navigateSpa } from '../../app/appShell/spaNavigationBridge.js';
import { docsScope } from './docsScope.js';
import { isDocPath } from '../../../lib/docs/doc-ref.js';

/** Selection stays local to the panel; note paths never become route selectors. */
export async function openDocsNote(path, scope) {
  if (!isDocPath(path)) return;
  if (JSON.stringify(await docsScope()) !== JSON.stringify(scope)) return;
  await navigateSpa({ panel: 'docs' });
  const { refreshDocsPanel } = await import('./docsPanel.js');
  await refreshDocsPanel();
  if (JSON.stringify(await docsScope()) !== JSON.stringify(scope)) return;
  /** @type {any} */ (document.querySelector('cr-docs-panel'))?.open(path);
}
