/**
 * Header label next to the hamburger icon: shows the active workspace name and the
 * active chat title. The workspace assigned to the active chat wins; the label from
 * #header-workspace-label is only a fallback.
 */
export function createHeaderContextTitle({ getActiveChatId, getChats }) {
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

  function refresh() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('header-context-title');
    if (!el) return;

    const activeChat = readActiveChat();
    const parts = [readWorkspaceLabel(activeChat), readChatTitle(activeChat)].filter(Boolean);
    el.textContent = parts.join(' · ');
    el.classList.toggle('is-empty', parts.length === 0);
  }

  return { refresh };
}
