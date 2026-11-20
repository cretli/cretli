/**
 * Header button that opens the car view (big buttons, one decision at a time).
 * The view and its data layer load on first use, not at boot.
 */

import { t } from '../../i18n/index.js';
import { subscribe } from '../../state/index.js';
import { getCarMode } from '../voice/voicePrefs.js';

const BUTTON_ID = 'header-car-mode-btn';

/** @type {Promise<typeof import('./carService.js')>|null} */
let servicePromise = null;

/**
 * @param {HTMLButtonElement} button
 * @returns {Promise<typeof import('./carService.js')>}
 */
function loadService(button) {
  if (!servicePromise) {
    servicePromise = import('./carService.js').then((service) => {
      subscribe(service.carViewOpen, () => {
        const open = service.carViewOpen.get();
        button.classList.toggle('is-live', open);
        button.setAttribute('aria-pressed', open ? 'true' : 'false');
      });
      return service;
    });
  }
  return servicePromise;
}

/** @returns {void} */
export function initCarModeButton() {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById(BUTTON_ID));
  if (!button) return;
  const label = () => {
    button.title = t('car.openTitle');
    button.setAttribute('aria-label', t('car.openTitle'));
  };
  label();
  button.addEventListener('click', async () => {
    const service = await loadService(button);
    if (service.carViewOpen.get()) service.closeCarView();
    else await service.openCarView();
  });
  if (typeof window !== 'undefined') window.addEventListener('cr-lang-changed', label);
  if (getCarMode()) void loadService(button).then((service) => service.restoreCarView());
}
