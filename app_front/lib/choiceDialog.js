import '../components/ui/cr-bar-button.js';
import '../components/ui/cr-dialog.js';

const STYLE_ID = 'cr-choice-dialog-styles';

/**
 * @typedef {object} ChoiceOption
 * @property {string} value
 * @property {string} label
 * @property {string} [hint]
 * @property {'primary' | 'danger' | 'secondary'} [variant]
 */

/**
 * @typedef {object} ChoiceDialogParams
 * @property {string} heading
 * @property {string} [body]
 * @property {ChoiceOption[]} options
 * @property {string} [cancelLabel]
 */

function ensureChoiceDialogStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .cr-choice-dialog-body {
      margin: 0 0 var(--cr-space-3);
      color: var(--cr-text-muted);
      font-size: 0.85rem;
      line-height: 1.4;
    }
    .cr-choice-list {
      display: flex;
      flex-direction: column;
      gap: var(--cr-space-2);
    }
    .cr-choice-item {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.2rem;
      width: 100%;
      box-sizing: border-box;
      margin: 0;
      padding: var(--cr-space-2) var(--cr-space-3);
      text-align: left;
      cursor: pointer;
      font-family: var(--cr-font-ui);
      color: var(--cr-text);
      background: var(--cr-input-bg);
      border: 1px solid var(--cr-border-control);
      border-radius: var(--cr-radius-sm);
      transition: background var(--cr-transition), border-color var(--cr-transition);
    }
    .cr-choice-item:hover,
    .cr-choice-item:focus-visible {
      background: var(--cr-hover);
      border-color: var(--cr-border-strong);
      outline: none;
    }
    .cr-choice-item:focus-visible {
      border-color: var(--cr-input-focus-border);
      box-shadow: 0 0 0 2px var(--cr-focus-ring);
    }
    .cr-choice-item[data-variant='primary'] {
      background: var(--cr-primary);
      color: var(--cr-text-inverse);
      border-color: var(--cr-primary-hover);
    }
    .cr-choice-item[data-variant='primary']:hover,
    .cr-choice-item[data-variant='primary']:focus-visible {
      background: var(--cr-primary-hover);
    }
    .cr-choice-item[data-variant='danger'] {
      background: var(--cr-danger-bg);
      color: var(--cr-danger-text);
      border-color: var(--cr-danger-border);
    }
    .cr-choice-item[data-variant='danger']:hover,
    .cr-choice-item[data-variant='danger']:focus-visible {
      background: var(--cr-danger-hover);
    }
    .cr-choice-item-label {
      font-size: 0.9rem;
      font-weight: 600;
    }
    .cr-choice-item-hint {
      font-size: 0.78rem;
      font-weight: 400;
      opacity: 0.85;
      line-height: 1.35;
      white-space: normal;
    }
    .cr-choice-dialog > [slot='actions'] {
      display: flex;
      justify-content: flex-end;
      gap: var(--cr-space-2);
    }
  `;
  document.head.appendChild(style);
}

function createChoiceItem(option, onPick) {
  const value = String(option?.value || '').trim();
  if (!value) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cr-choice-item';
  button.setAttribute('role', 'option');
  if (option.variant) button.dataset.variant = option.variant;
  const label = document.createElement('span');
  label.className = 'cr-choice-item-label';
  label.textContent = String(option.label || value);
  button.appendChild(label);
  if (option.hint) {
    const hint = document.createElement('span');
    hint.className = 'cr-choice-item-hint';
    hint.textContent = String(option.hint);
    button.appendChild(hint);
  }
  button.dataset.value = value;
  const pick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPick(value);
  };
  button.addEventListener('pointerdown', pick);
  button.addEventListener('click', pick);
  return button;
}

/**
 * Show a modal with a clickable list of choices.
 * Resolves to the selected option value, or null when cancelled.
 *
 * @param {ChoiceDialogParams} params
 * @returns {Promise<string | null>}
 */
export function showChoiceDialog(params) {
  const heading = String(params?.heading || '');
  const body = String(params?.body || '');
  const options = Array.isArray(params?.options) ? params.options : [];
  const cancelLabel = String(params?.cancelLabel || '');
  return new Promise((resolve) => {
    ensureChoiceDialogStyles();
    let isSettled = false;
    const dialog = document.createElement('cr-dialog');
    dialog.className = 'cr-choice-dialog';
    dialog.heading = heading;
    const bodyWrap = document.createElement('div');
    if (body) {
      const bodyEl = document.createElement('p');
      bodyEl.className = 'cr-choice-dialog-body';
      bodyEl.textContent = body;
      bodyWrap.appendChild(bodyEl);
    }
    const list = document.createElement('div');
    list.className = 'cr-choice-list';
    list.setAttribute('role', 'listbox');
    const finish = (value) => {
      if (isSettled) return;
      isSettled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      dialog.removeEventListener('cr-dialog-close', onClose);
      window.setTimeout(() => {
        if (dialog.open) dialog.hide();
        dialog.remove();
        resolve(value);
      }, 0);
    };
    const onClose = () => finish(null);
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    for (const option of options) {
      const item = createChoiceItem(option, finish);
      if (item) list.appendChild(item);
    }
    bodyWrap.appendChild(list);
    dialog.persistent = true;
    dialog.setAttribute('persistent', '');
    dialog.appendChild(bodyWrap);
    if (cancelLabel) {
      const actions = document.createElement('div');
      actions.slot = 'actions';
      const cancelBtn = document.createElement('cr-bar-button');
      cancelBtn.textContent = cancelLabel;
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      });
      actions.appendChild(cancelBtn);
      dialog.appendChild(actions);
    }
    dialog.addEventListener('cr-dialog-close', onClose);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(dialog);
    dialog.show();
    list.querySelector('.cr-choice-item')?.focus();
  });
}
