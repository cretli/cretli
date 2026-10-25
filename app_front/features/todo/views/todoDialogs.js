import { t } from '../../../i18n/index.js';

/** @type {any} */
let errorDialog = null;

/** Show full TODO errors and optional prepare output as text in one scrollable dialog. */
export function showTodoError(message, prepareDetails = null) {
  const dialog = /** @type {any} */ (errorDialog || document.createElement('cr-dialog'));
  dialog.heading = t(prepareDetails ? 'todo.worktreePrepareErrorTitle' : 'todo.error');
  dialog.variant = 'error';
  dialog.closable = true;
  dialog.closeLabel = t('settings.close');
  dialog.style.setProperty('--cr-dialog-max-width', '48rem');
  const content = document.createElement('div');
  content.style.cssText = 'max-height: 60dvh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
  const messageBlock = document.createElement('p');
  messageBlock.textContent = message;
  messageBlock.style.color = 'var(--cr-error)';
  messageBlock.setAttribute('role', 'alert');
  content.appendChild(messageBlock);
  if (prepareDetails) {
    const details = prepareDetails;
    const addRow = (label, value) => {
      if (!value) return;
      const row = document.createElement('p');
      const heading = document.createElement('strong');
      heading.textContent = `${label}: `;
      const text = document.createElement('code');
      text.textContent = value;
      text.style.overflowWrap = 'anywhere';
      row.append(heading, text);
      content.appendChild(row);
    };
    const command = Array.isArray(details.command) ? details.command.map(String) : [];
    if (details.stage === 'preflight') addRow(t('todo.worktreePrepareStage'), t('todo.worktreePreparePreflight'));
    addRow(t('todo.worktreePrepareCommand'), command.length ? JSON.stringify(command) : '—');
    addRow(t('todo.worktreePrepareDirectory'), String(details.cwd || ''));
    addRow(t('todo.worktreePrepareExit'), [details.exitCode, details.signal].filter(Boolean).join(' / '));
    const output = [
      details.stderr ? `stderr:\n${details.stderr}` : '',
      details.stdout ? `stdout:\n${details.stdout}` : '',
    ].filter(Boolean).join('\n\n') || t('todo.worktreePrepareNoOutput');
    const outputLabel = document.createElement('strong');
    outputLabel.textContent = t('todo.worktreePrepareOutput');
    const outputBlock = document.createElement('pre');
    outputBlock.textContent = output;
    outputBlock.style.cssText = 'max-height: 18rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
    content.append(outputLabel, outputBlock);
  }
  dialog.replaceChildren(content);
  const actions = document.createElement('div');
  actions.setAttribute('slot', 'actions');
  const close = document.createElement('cr-bar-button');
  close.textContent = t('settings.close');
  close.addEventListener('click', () => dialog.hide(), { once: true });
  actions.appendChild(close);
  dialog.appendChild(actions);
  if (!errorDialog) {
    document.body.appendChild(dialog);
    errorDialog = dialog;
    dialog.addEventListener('cr-dialog-close', () => {
      dialog.remove();
      errorDialog = null;
    }, { once: true });
  }
  if (!dialog.open) dialog.show();
}

/** Ask the operator how to handle a dirty logical worktree before retrying. */
export function chooseDirtyWorktreePolicy(paths) {
  return new Promise((resolve) => {
    const dialog = /** @type {any} */ (document.createElement('cr-dialog'));
    dialog.heading = t('todo.worktreeDirtyChoiceTitle');
    dialog.style.setProperty('--cr-dialog-max-width', '42rem');
    const content = document.createElement('div');
    const description = document.createElement('p');
    description.textContent = t('todo.worktreeDirtyChoiceHint');
    const list = document.createElement('pre');
    list.textContent = paths.map((file) => String(file)).join('\n');
    list.style.cssText = 'max-height: 12rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;';
    content.append(description, list);
    dialog.appendChild(content);
    const actions = document.createElement('div');
    actions.setAttribute('slot', 'actions');
    const addAction = (label, value) => {
      const button = document.createElement('cr-bar-button');
      button.textContent = label;
      button.addEventListener('click', () => { dialog.remove(); resolve(value); }, { once: true });
      actions.appendChild(button);
    };
    addAction(t('todo.worktreeDirtyCommit'), null);
    addAction(t('todo.worktreeDirtyHead'), 'head');
    addAction(t('todo.worktreeDirtySnapshot'), 'snapshot');
    dialog.appendChild(actions);
    dialog.addEventListener('cr-dialog-close', () => { dialog.remove(); resolve(null); }, { once: true });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

/**
 * Asks for the optional revisit date and reason of a deferral.
 *
 * @param {boolean} offerMoveToLater Show the "move to later" option (leaves that have a parent).
 * @returns {Promise<{ deferredUntil: string, deferredReason: string, moveToLater: boolean } | null>} `null` = cancelled.
 */
export function askDeferDetails(offerMoveToLater = false) {
  return new Promise((resolve) => {
    const dialog = /** @type {any} */ (document.createElement('cr-dialog'));
    dialog.heading = t('todo.deferDialogTitle');
    dialog.style.setProperty('--cr-dialog-max-width', '28rem');
    const content = document.createElement('div');
    content.className = 'todo-defer-form cr-form';
    const hint = document.createElement('p');
    hint.className = 'cr-hint';
    hint.textContent = t('todo.deferDialogHint');
    const dateField = document.createElement('label');
    dateField.className = 'cr-field';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'cr-field-label';
    dateLabel.textContent = t('todo.deferUntilLabel');
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateField.append(dateLabel, dateInput);
    const reasonField = document.createElement('label');
    reasonField.className = 'cr-field';
    const reasonLabel = document.createElement('span');
    reasonLabel.className = 'cr-field-label';
    reasonLabel.textContent = t('todo.deferReasonLabel');
    const reasonInput = document.createElement('input');
    reasonInput.type = 'text';
    reasonInput.maxLength = 500;
    reasonField.append(reasonLabel, reasonInput);
    const laterLabel = document.createElement('label');
    laterLabel.className = 'cr-check';
    const laterInput = document.createElement('input');
    laterInput.type = 'checkbox';
    laterLabel.append(laterInput, document.createTextNode(` ${t('todo.deferMoveToLater')}`));
    content.append(hint, dateField, reasonField);
    if (offerMoveToLater) content.append(laterLabel);
    dialog.appendChild(content);
    const actions = document.createElement('div');
    actions.setAttribute('slot', 'actions');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.remove();
      resolve(value);
    };
    const cancel = document.createElement('cr-bar-button');
    cancel.textContent = t('todo.deferCancel');
    cancel.addEventListener('click', () => finish(null));
    const confirm = document.createElement('cr-bar-button');
    confirm.setAttribute('variant', 'primary');
    confirm.textContent = t('todo.deferConfirm');
    confirm.addEventListener('click', () => {
      // A date-only value means the end of that local day, so "today" is not overdue at once.
      const day = dateInput.value ? new Date(`${dateInput.value}T23:59:59`) : null;
      finish({
        deferredUntil: day && Number.isFinite(day.getTime()) ? day.toISOString() : '',
        deferredReason: reasonInput.value.trim(),
        moveToLater: offerMoveToLater && laterInput.checked,
      });
    });
    actions.append(cancel, confirm);
    dialog.appendChild(actions);
    dialog.addEventListener('cr-dialog-close', () => finish(null), { once: true });
    document.body.appendChild(dialog);
    dialog.show();
  });
}
