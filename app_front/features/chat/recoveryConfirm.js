/**
 * Explicit confirmation before resuming a run whose liveness is `unknown`.
 *
 * The resume service refuses `unknown` without `confirmUnknown`, because the
 * previous executor may still be alive and a second turn could execute the
 * prompt twice. The UI must therefore never send that flag without a user
 * decision. Built on `cr-dialog` like `notificationConfirm.js`.
 */

import '../../components/ui/cr-bar-button.js';
import '../../components/ui/cr-dialog.js';
import { t } from '../../i18n/index.js';

/**
 * @param {string} label
 * @param {'primary' | 'danger' | 'secondary'} variant
 * @param {() => void} onPress
 * @returns {HTMLElement}
 */
function createButton(label, variant, onPress) {
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
 * @returns {Promise<boolean>} true only when the user confirms the resume.
 */
export function confirmRecoveryUnknownResume() {
  return new Promise((resolve) => {
    let settled = false;
    const dialog = document.createElement('cr-dialog');
    dialog.className = 'sdk-rich-recovery-confirm-dialog';
    dialog.heading = t('chat.recoveryUnknownConfirmHeading');
    dialog.style.setProperty('--cr-dialog-max-width', '26rem');

    const body = document.createElement('p');
    body.className = 'sdk-rich-recovery-confirm-body';
    body.textContent = t('chat.recoveryUnknownConfirmBody');
    dialog.appendChild(body);

    const actions = document.createElement('div');
    actions.slot = 'actions';
    actions.className = 'sdk-rich-recovery-confirm-actions';
    const cancelButton = createButton(t('chat.cancel'), 'secondary', () => finish(false));
    const confirmButton = createButton(
      t('chat.recoveryUnknownConfirmAction'),
      'primary',
      () => finish(true),
    );
    actions.append(cancelButton, confirmButton);
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
