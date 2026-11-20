import { render } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import '../../../../components/ui/cr-dialog.js';
import '../../../../components/ui/cr-bar-button.js';
import { t } from '../../../../i18n/index.js';
import { preloadMarkdown, renderMarkdownHtml } from '../../../../lib/render-markdown.js';
import { bindWorkspaceFileLinks } from './workspaceFileLinks.js';

/** A chat-scoped preview never changes the global Files panel workspace. */
export async function openWorkspaceFilePreview(chatId, path) {
  const dialog = document.createElement('cr-dialog');
  dialog.heading = path;
  dialog.closable = true;
  dialog.closeLabel = t('common.close');
  dialog.style.setProperty('--cr-dialog-max-width', '64rem');
  const content = document.createElement('div');
  content.className = 'files-preview-markdown';
  Object.assign(content.style, { maxHeight: '70dvh', overflow: 'auto', overflowWrap: 'anywhere' });
  content.textContent = t('files.loading');
  dialog.append(content);
  dialog.addEventListener('cr-dialog-close', () => dialog.remove());
  document.body.append(dialog);
  dialog.show();
  await loadPreview();

  async function loadPreview(allowOutsideWorkspace = false) {
    content.textContent = t('files.loading');
    try {
      const query = new URLSearchParams({ path });
      if (allowOutsideWorkspace) query.set('allowOutsideWorkspace', '1');
      const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/files/read?${query}`);
      const data = await response.json();
      if (!dialog.isConnected) return;
      if (!allowOutsideWorkspace && data.code === 'files.outsideWorkspace') {
        content.textContent = t('files.externalPreviewHint');
        const button = document.createElement('cr-bar-button');
        button.slot = 'actions';
        button.variant = 'primary';
        button.textContent = t('files.openExternalPreview');
        button.addEventListener('click', () => {
          button.remove();
          void loadPreview(true);
        }, { once: true });
        dialog.append(button);
        return;
      }
      if (!response.ok || !data.ok) throw new Error(data.error || t('files.readError'));
      dialog.heading = data.path;
      if (/\.(?:md|markdown)$/i.test(data.path)) {
        await preloadMarkdown();
        if (!dialog.isConnected) return;
        // markdown-it runs with html:false, so raw HTML in the document is already escaped.
        content.replaceChildren();
        render(unsafeHTML(renderMarkdownHtml(data.content)), content);
        // References inside a document are relative to that document's directory.
        const directory = data.path.includes('/') ? data.path.slice(0, data.path.lastIndexOf('/') + 1) : '';
        for (const link of content.querySelectorAll('a[href]')) {
          const href = link.getAttribute('href');
          if (href && !/^(?:[a-z][a-z\d+.-]*:|\/|[?#])/i.test(href)) link.setAttribute('href', directory + href);
        }
        bindWorkspaceFileLinks(content, chatId);
      } else {
        const pre = document.createElement('pre');
        pre.textContent = data.content;
        content.replaceChildren(pre);
      }
    } catch (error) {
      if (dialog.isConnected) content.textContent = error.message || t('files.readError');
    }
  }
}
