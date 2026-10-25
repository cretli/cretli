/**
 * Header label next to the hamburger icon: shows the active workspace name and the
 * active chat title. The workspace assigned to the active chat wins; the label from
 * #header-workspace-label is only a fallback.
 */
export function createHeaderContextTitle({ getActiveChatId, getChats, onActivate }) {
  function readWorkspaceLabelFromTrigger() {
    const el = document.getElementById('header-workspace-label');
    if (!el) return '';
    return (el.textContent || '').trim();
  }

  function basename(pathValue) {
    const raw = pathValue == null ? '' : String(pathValue).trim();
    if (!raw) return '';
    const normalized = raw.replace(/\\/g, '/').replace(/\/$/, '');
    const tail = normalized.split('/').pop() || '';
    return tail || normalized;
  }

  function workspaceNameFromFile(workspaceFile) {
    const base = basename(workspaceFile);
    if (!base) return '';
    return base.replace(/\.code-workspace$/i, '').trim();
  }

  function readActiveChat() {
    const id = getActiveChatId();
    if (!id) return null;
    return getChats().find((c) => c.id === id) || null;
  }

  function readWorkspaceLabel(activeChat) {
    if (activeChat && typeof activeChat === 'object') {
      const workspaceName = workspaceNameFromFile(activeChat.workspaceFile);
      const folderName = basename(activeChat.workspaceFolder);
      if (workspaceName && folderName && folderName !== workspaceName) {
        return `${workspaceName} • ${folderName}`;
      }
      if (workspaceName) return workspaceName;
      if (folderName) return folderName;
    }
    return readWorkspaceLabelFromTrigger();
  }

  function readChatTitle(activeChat) {
    if (!activeChat) return '';
    return activeChat?.title ? String(activeChat.title).trim() : '';
  }

  function bindHomeClick() {
    if (typeof document === 'undefined' || typeof onActivate !== 'function') return;
    const el = document.getElementById('header-context-title');
    if (!el || el.dataset.homeBound === '1') return;
    el.dataset.homeBound = '1';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const goHome = () => onActivate();
    el.addEventListener('click', goHome);
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      goHome();
    });
  }

  function refresh() {
    if (typeof document === 'undefined') return;
    bindHomeClick();
    const el = document.getElementById('header-context-title');
    if (!el) return;

    const activeChat = readActiveChat();
    const parts = [readWorkspaceLabel(activeChat), readChatTitle(activeChat)].filter(Boolean);
    el.textContent = parts.join(' · ');
    el.classList.toggle('is-empty', parts.length === 0);
  }

  return { refresh };
}
