/**
 * One swipe picker on top of a provider settings page (Keys, Models,
 * Permissions, Statistics) switches the same page between harnesses, so the
 * sidebar lists those pages once instead of once per harness.
 */
import { SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES } from './settingsCategories.js';
import { buildSettingsTree, harnessIdForSettingsTab } from './settingsTreeModel.js';
import { resolveSettingsNodeIcon } from './settingsTreeIcons.js';
import { getSharedSpaNavigation } from '../../app/appShell/spaNavigationBridge.js';
import { remapSettingsTab } from '../../../lib/spa-routes.js';
import { t } from '../../i18n/index.js';

const STORAGE_KEY = 'cretli-settings-harness';
/** Logos drawn black on transparent need inverting on the matching theme (same rule as the sidebar). */
const INVERT_DARK = new Set(['sdk', 'opencode']);
const INVERT_LIGHT = new Set(['codex']);

const tree = buildSettingsTree(SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES);

/** Harness last chosen in the picker, used when the sidebar opens a provider page. */
export function readChosenHarness() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_) { return ''; }
}

/** @param {string} id */
function rememberHarness(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch (_) {}
}

export function initSettingsHarnessPicker() {
  const content = document.querySelector('#settings-panel .settings-content');
  if (!content || document.getElementById('settings-harness-picker')) return;
  const picker = /** @type {any} */ (document.createElement('cr-swipe-picker'));
  picker.id = 'settings-harness-picker';
  picker.hidden = true;
  const nav = content.querySelector(':scope > .settings-nav');
  if (nav) nav.after(picker);
  else content.prepend(picker);

  const providers = (tree.find(node => node.id === 'harness')?.children || [])
    .filter(node => /^harness-[a-z]+$/.test(node.id) && node.id !== 'harness-overview');
  const items = () => {
    const light = document.body.classList.contains('theme-light');
    return providers.map(node => {
      const id = node.id.slice('harness-'.length);
      const icon = resolveSettingsNodeIcon(node);
      return {
        value: id,
        label: t(node.labelKey),
        iconSrc: icon?.kind === 'img' ? icon.src : '',
        iconInvert: light ? INVERT_LIGHT.has(id) : INVERT_DARK.has(id),
      };
    });
  };

  let tab = '';
  /** @param {string} nextTab */
  const sync = (nextTab) => {
    tab = remapSettingsTab(nextTab || '');
    const id = harnessIdForSettingsTab(tree, tab);
    picker.hidden = !id;
    if (!id) return;
    rememberHarness(id);
    picker.label = t('settings.tabsHarness');
    picker.items = items();
    picker.value = id;
  };

  picker.addEventListener('cr-change', (/** @type {CustomEvent} */ event) => {
    const next = String(event.detail?.value || '');
    const current = harnessIdForSettingsTab(tree, tab);
    if (!next || !current || next === current) return;
    // Stay on the same page (Keys, Models, ...) of the newly chosen harness.
    const suffix = tab.slice(`harness-${current}`.length);
    rememberHarness(next);
    void (/** @type {any} */ (getSharedSpaNavigation()))?.navigate({ panel: 'settings', settingsTab: `harness-${next}${suffix}` }, { explicit: true });
  });
  window.addEventListener('cr-settings-tab-changed', (event) => sync(/** @type {CustomEvent} */ (event).detail?.tabId));
  window.addEventListener('cr-lang-changed', () => sync(tab));
  sync(document.getElementById('settings-panel')?.dataset.activeSettingsTab || '');
}
