import { SETTINGS_SUBCATEGORIES } from './settingsCategories.js';
import { buildSettingsSearchIndex, filterSettingsSearch, SETTINGS_CATEGORIES } from './settingsSearch.js';
import { getSharedSpaNavigation } from '../../app/appShell/spaNavigationBridge.js';
import { t } from '../../i18n/index.js';

/** Read caption text without defaults or values nested inside a label. */
function readStaticLabel(target) {
  const caption = target.cloneNode(true);
  caption.querySelectorAll('input, textarea, select, cr-bar-input, cr-bar-textarea, cr-bar-select, cr-searchable-select').forEach(node => node.remove());
  return caption.textContent || '';
}

export function initSettingsSearch(options = {}) {
  const nav = options.nav || document.getElementById('settings-tabs');
  const sidebar = options.sidebar || document.querySelector('.settings-category-sidebar');
  if (!nav || !sidebar) return;
  const input = /** @type {import('../../components/ui/cr-bar-input.js').CrBarInput} */ (options.input || document.createElement('cr-bar-input'));
  if (!input.id) input.id = 'settings-category-search';
  input.type = 'search';
  input.setAttribute('data-i18n-placeholder', 'settings.searchPlaceholder');
  input.setAttribute('data-i18n-aria', 'settings.searchPlaceholder');
  input.setAttribute('aria-label', t('settings.searchPlaceholder'));
  input.setAttribute('placeholder', t('settings.searchPlaceholder'));
  const results = document.createElement('div');
  results.id = 'settings-search-results';
  results.setAttribute('role', 'list');
  results.setAttribute('aria-label', t('settings.searchResults'));
  const empty = document.createElement('p');
  empty.setAttribute('role', 'status');
  empty.dataset.i18n = 'settings.searchEmpty';
  empty.textContent = t('settings.searchEmpty');
  empty.hidden = true;
  if (!options.input) sidebar.prepend(input);
  sidebar.prepend(empty, results);

  // Capture static labels before lazy panels render. Dynamic panels are indexed
  // only through category keywords; values, API responses and secrets are excluded.
  const labels = [...document.querySelectorAll('#settings-panel .settings-section label, #settings-panel .settings-section legend, #settings-panel .settings-section cr-checkbox')]
    .filter(node => !node.closest('template') && !node.matches('[hidden]'))
    .map(target => ({ target, tab: target.closest('[data-settings-tab]').getAttribute('data-settings-tab') }));
  let matches = [];
  function render() {
    const query = String(input.value || '').trim();
    const index = buildSettingsSearchIndex(SETTINGS_CATEGORIES, [...labels.map(({ target, tab }) => ({ target, tab, label: readStaticLabel(target) })), ...SETTINGS_SUBCATEGORIES.map(node => ({ tab: node.tab, label: t(node.labelKey) }))], t);
    matches = filterSettingsSearch(index, query);
    if (options.onFilter) options.onFilter(query, matches);
    results.replaceChildren();
    results.hidden = !query;
    empty.hidden = !query || matches.length > 0;
    matches.forEach(result => {
      const row = document.createElement('div');
      row.setAttribute('role', 'listitem');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${t(`settings.category.${result.category}`)}: ${result.label}`;
      button.addEventListener('click', async () => {
        await (/** @type {any} */ (getSharedSpaNavigation()))?.navigate({ panel: 'settings', settingsTab: result.tab }, { explicit: true });
        const target = result.target;
        if (target?.isConnected) {
          document.querySelectorAll('.settings-search-highlight').forEach(node => node.classList.remove('settings-search-highlight'));
          target.classList.add('settings-search-highlight');
          target.scrollIntoView({ block: 'center' });
          target.setAttribute('tabindex', '-1');
          target.focus({ preventScroll: true });
        }
      });
      row.append(button);
      results.append(row);
    });
  }
  input.addEventListener('input', render);
  function onKeydown(rawEvent) {
    const event = /** @type {KeyboardEvent} */ (rawEvent);
    const buttons = [...results.querySelectorAll('button')];
    if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      render();
      input.focus();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && buttons.length) {
      event.preventDefault();
      const current = buttons.findIndex(button => button === document.activeElement);
      const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    } else if (event.key === 'Enter' && event.composedPath().includes(input) && buttons.length) {
      event.preventDefault();
      buttons[0].click();
    }
  }
  sidebar.addEventListener('keydown', onKeydown);
  input.addEventListener('keydown', onKeydown);
  window.addEventListener('cr-lang-changed', () => {
    results.setAttribute('aria-label', t('settings.searchResults'));
    render();
  });
}
