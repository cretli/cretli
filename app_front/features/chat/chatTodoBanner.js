/** Persistent navigation to the task linked to a chat, outside the transcript. */
export function createChatTodoBanner(chat, { t, loadSummary, onOpen }) {
  const root = document.createElement('div');
  root.className = 'chat-todo-banner';
  root.hidden = true;
  const icon = document.createElement('span');
  icon.className = 'mdi mdi-checkbox-marked-outline';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'chat-todo-banner-title';
  const open = document.createElement('cr-bar-button');
  open.textContent = t('sendBar.todoChipOpen');
  root.append(icon, title, open);
  open.addEventListener('click', () => {
    const id = String(chat.todoId || '').trim();
    if (id) onOpen(id);
  });
  let pendingId = '';

  function paint(id, summary) {
    title.textContent = `TODO · ${summary?.title || id.slice(0, 8)}`;
    title.title = summary?.title || id;
  }

  function sync() {
    const id = String(chat.todoId || '').trim();
    root.hidden = !id;
    if (!id) return;
    paint(id, chat._todoRowMeta?.[id]);
    if (pendingId === id) return;
    pendingId = id;
    void Promise.resolve().then(() => loadSummary(id)).then((summary) => {
      // A task can be replaced while its summary is loading.
      if (!summary || String(chat.todoId || '').trim() !== id) return;
      chat._todoRowMeta ||= {};
      chat._todoRowMeta[id] = summary;
      paint(id, summary);
    }).catch(() => {
      // Keep navigation available even when the task summary cannot be loaded.
    }).finally(() => {
      if (pendingId === id) pendingId = '';
    });
  }

  return { root, sync };
}
