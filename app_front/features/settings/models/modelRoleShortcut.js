/**
 * Per-model shortcut from the Settings → Harness model lists to the role
 * (plan / implement / review / fix) override form in Model selection.
 */
import { t } from '../../../i18n/index.js';
import { prefillModelRoleOverride } from '../../harness-health/harnessModelRoleConfig.js';

const ROLES_TAB_ID = 'harness-overview-roles';

/**
 * @param {string} value
 * @returns {string}
 */
function attr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {string} harness
 * @param {string} model
 * @returns {string}
 */
export function modelRoleButtonHtml(harness, model) {
  const label = attr(t('settings.chatModelsRoleShortcut'));
  return '<button type="button" class="model-role-shortcut" data-role-harness="' + attr(harness)
    + '" data-role-model="' + attr(model) + '" aria-label="' + label + '" title="' + label + '">'
    + '<span class="mdi mdi-tune-variant" aria-hidden="true"></span></button>';
}

/**
 * @param {Element} listEl
 */
export function bindModelRoleShortcut(listEl) {
  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest('.model-role-shortcut');
    if (!(button instanceof HTMLElement)) return;
    event.preventDefault();
    event.stopPropagation();
    const harness = String(button.dataset.roleHarness || '').trim();
    const model = String(button.dataset.roleModel || '').trim();
    if (!harness || !model) return;
    const tabBtn = document.querySelector('[data-settings-tab="' + ROLES_TAB_ID + '"].settings-tab');
    if (tabBtn instanceof HTMLElement) tabBtn.click();
    prefillModelRoleOverride({ harness, model });
  });
}
