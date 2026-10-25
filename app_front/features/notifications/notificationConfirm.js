/**
 * Modal confirmation for bulk notification actions (mark all, clear read, clear all).
 *
 * Built on `cr-dialog` like `lib/choiceDialog.js`. The dialog is appended to
 * `document.body`, so its clicks would otherwise reach the notification
 * dropdown's outside-click handler; the buttons and Escape stop propagation for
 * that reason.
 */

import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-dialog.js';

/**
 * @param {string} label
 * @param {'primary' | 'danger' | 'secondary'} variant
 * @param {() => void} onPress
 * @returns {HTMLElement}
 */
function createConfirmButton(label, variant, onPress) {
  const button = document.createElement('cr-bar-button');
  button.setAttribute('variant', variant);
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onPress();
  });
  return button;
}

/**
 * @param {{
 *   heading: string,
 *   body: string,
 *   confirmLabel: string,
 *   cancelLabel: string,
 *   danger?: boolean,
 * }} params
 * @returns {Promise<boolean>} Resolves true only when the confirm button is pressed.
 */
export function confirmNotificationAction(params) {
  return new Promise((resolve) => {
    let settled = false;
    const dialog = document.createElement('cr-dialog');
    dialog.className = 'notification-confirm-dialog';
    dialog.heading = params.heading;
    dialog.style.setProperty('--cr-dialog-max-width', '26rem');

    const message = document.createElement('p');
    message.className = 'notification-confirm-body';
    message.textContent = params.body;
    dialog.appendChild(message);

    const actions = document.createElement('div');
    actions.slot = 'actions';
    actions.className = 'notification-confirm-actions';
    const cancelButton = createConfirmButton(params.cancelLabel, 'secondary', () => finish(false));
    actions.append(
      cancelButton,
      createConfirmButton(params.confirmLabel, params.danger ? 'danger' : 'primary', () => finish(true)),
    );
    dialog.appendChild(actions);

    const onClose = () => finish(false);
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    };

    function finish(confirmed) {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      dialog.removeEventListener('cr-dialog-close', onClose);
      if (dialog.open) dialog.hide();
      dialog.remove();
      resolve(confirmed);
    }

    dialog.addEventListener('cr-dialog-close', onClose);
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(dialog);
    dialog.show();
    void cancelButton.updateComplete.then(() => cancelButton.focus());
  });
}
