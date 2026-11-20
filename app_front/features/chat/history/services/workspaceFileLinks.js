/** Recognize file references without changing web URLs or in-page anchors. */
export function workspaceFilePath(href) {
  const value = String(href || '').trim();
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/|[?#])/i.test(value)) return null;
  if (/^\/(?:api|uploads|dist)(?:\/|$)/.test(value)) return null;
  let decoded;
  try { decoded = decodeURIComponent(value.split(/[?#]/)[0]); } catch { return null; }
  decoded = decoded.replace(/:\d+(?::\d+)?$/, '');
  if (!decoded || /[\0\r\n\\]/.test(decoded)) return null;
  return decoded;
}

/** One delegated listener survives streaming Markdown repaints. */
export function bindWorkspaceFileLinks(host, chatId) {
  if (!chatId || host.dataset.workspaceFileLinks === '1') return;
  host.dataset.workspaceFileLinks = '1';
  host.addEventListener('click', (event) => {
    const link = event.target?.closest?.('a[href]');
    if (!link || !host.contains(link)) return;
    const path = workspaceFilePath(link.getAttribute('href'));
    if (!path) return;
    event.preventDefault();
    event.stopPropagation();
    void import('./workspaceFilePreview.js').then(({ openWorkspaceFilePreview }) => {
      openWorkspaceFilePreview(chatId, path);
    });
  });
}
