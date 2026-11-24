/** Map an advisory verdict to the explicitly offered archive action. */
export function completionDialogActions(assessment) {
  if (assessment?.verdict === 'completed') return ['archive', 'leave'];
  if (assessment?.verdict === 'needs_action' && assessment.openItems?.length) return ['followups', 'leave'];
  return ['leave'];
}

/** Keep a detached payload so network retries cannot pick up later edits. */
export function completionFollowupsPayload(assessmentId, items) {
  return { assessmentId, items: items.filter((item) => item.checked).map(({ index, title }) => ({ index, title: title.trim() })), confirm: true };
}

export async function checkChatCompletion(chatId, onArchived) {
  const [{ html, render }, { t }, { apiFetchJson }] = await Promise.all([
    import('lit'), import('../../../i18n/index.js'), import('../../../core/api/runtime.js'),
    import('../../../components/ui/index.js'),
  ]);
  const label = (key) => t(`settings.archivist${key}`);
  const reason = (value) => {
    const key = `settings.archivistReason_${value}`;
    return t(key) === key ? String(value || label('Failed')) : t(key);
  };
  const request = async (action, body) => {
    const result = await apiFetchJson(`/api/chat-archivist/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 'chatCompletionCheck', { timeoutMs: 120000 });
    if (!result?.ok) throw Object.assign(new Error(), { code: result?.code });
    return result;
  };
  const dialog = /** @type {import('../../../components/ui/cr-dialog.js').CrDialog} */ (document.createElement('cr-dialog'));
  dialog.heading = label('CheckArchive');
  dialog.className = 'chat-completion-dialog';
  const body = document.createElement('div');
  const actions = document.createElement('div');
  actions.slot = 'actions';
  dialog.append(body, actions);
  document.body.append(dialog);
  let busy = true;
  let assessment;
  let items = [];
  let frozen;
  let message = label('Checking');
  const close = () => { if (!busy) { dialog.hide(); dialog.remove(); } };
  dialog.addEventListener('cr-dialog-close', close);
  const draw = () => {
    dialog.persistent = busy;
    render(html`<p role="status">${message}</p>${items.map((item) => html`
      <div class="cr-field">
        <cr-checkbox .ariaLabel=${item.title} .checked=${item.checked} ?disabled=${busy || !!frozen}
          @change=${(event) => { item.checked = event.target.checked; draw(); }}>${item.detail}</cr-checkbox>
        <cr-bar-input .value=${item.title} maxlength="120" .ariaLabel=${label('FollowupTitle')} ?disabled=${busy || !!frozen}
          @input=${(event) => { item.title = event.target.value; draw(); }}></cr-bar-input>
      </div>`)}`, body);
    const action = completionDialogActions(assessment)[0];
    render(html`${action !== 'leave' ? html`<cr-bar-button variant="primary"
      ?disabled=${busy || (action === 'followups' && !frozen && (!items.some((item) => item.checked) || items.some((item) => item.checked && !item.title.trim())))}
      @click=${async () => {
        if (busy) return;
        if (action === 'followups') frozen ||= completionFollowupsPayload(assessment.id, items);
        busy = true; message = label('Working'); draw();
        try {
          const result = await request(action === 'followups' ? 'archive-with-followups' : 'archive', frozen || { assessmentId: assessment.id, confirm: true });
          busy = false; close(); onArchived(chatId, result.action?.archivedAt);
        } catch (error) { message = reason(error.code); busy = false; draw(); }
      }}>${label(action === 'followups' ? 'CreateFollowups' : 'Archive')}</cr-bar-button>` : ''}
      <cr-bar-button ?disabled=${busy} @click=${close}>${label('Leave')}</cr-bar-button>`, actions);
  };
  draw(); dialog.show();
  try {
    ({ assessment } = await request('assess', { chatId, mode: 'manual' }));
    items = assessment.verdict === 'needs_action' ? (assessment.openItems || []).map((item, index) => ({ ...item, index, checked: true })) : [];
    message = `${label(`Verdict_${assessment.verdict}`)}: ${reason(assessment.reason)}`;
  } catch (error) { message = reason(error.code); }
  busy = false; draw();
}
