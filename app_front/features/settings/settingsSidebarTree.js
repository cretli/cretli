import { SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES } from './settingsCategories.js';
import { buildSettingsTree, foldHarnessProviders, harnessIdForSettingsTab, resolveSettingsTreeActive, settingsTreeExpansion } from './settingsTreeModel.js';
import { readChosenHarness } from './settingsHarnessPicker.js';
import { resolveSettingsNodeIcon } from './settingsTreeIcons.js';
import { initSettingsSearch } from './settingsSearchView.js';
import { getSharedSpaNavigation } from '../../app/appShell/spaNavigationBridge.js';
import { t } from '../../i18n/index.js';

export function initSettingsSidebarTree() {
  const sidebar = document.getElementById('app-sidebar');
  if (!sidebar || document.body.classList.contains('embed-mode') || document.getElementById('sidebar-settings-tree')) return;
  const container = document.createElement('div');
  container.id = 'sidebar-settings-body';
  const nav = document.createElement('nav');
  nav.id = 'sidebar-settings-tree';
  nav.setAttribute('data-i18n-aria', 'header.settingsTitle');
  nav.setAttribute('aria-label', t('header.settingsTitle'));
  container.append(nav);
  sidebar.querySelector('.sidebar-body')?.after(container);
  const input = /** @type {import('../../components/ui/cr-bar-input.js').CrBarInput} */ (document.createElement('cr-bar-input'));
  input.id = 'sidebar-settings-search';
  sidebar.querySelector('#sidebar-search')?.before(input);
  const fullTree = buildSettingsTree(SETTINGS_CATEGORIES, SETTINGS_SUBCATEGORIES);
  // Provider pages are listed once and follow the harness open in the content
  // picker (or the last one chosen there).
  const currentTree = () => foldHarnessProviders(fullTree, harnessIdForSettingsTab(fullTree, activeTab) || readChosenHarness());
  // The tree starts collapsed every time settings open; only the path to a
  // deep-linked tab is revealed. Toggles last while the user stays in settings.
  let expanded = [];
  let activeTab = '';
  // Focus moved by code after a re-render shows a ring only for keyboard users;
  // after a tap or click it would look like a stuck blue highlight.
  let keyboardInput = false;
  document.addEventListener('keydown', () => { keyboardInput = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardInput = false; }, true);
  /** @param {Element | null | undefined} el @param {boolean} [preventScroll] */
  const moveFocus = (el, preventScroll = false) => {
    if (!(el instanceof HTMLElement)) return;
    // Browsers without the focusVisible option still treat code focus as
    // :focus-visible, so a class suppresses the ring until the element blurs.
    if (!keyboardInput) {
      el.classList.add('is-pointer-focus');
      el.addEventListener('blur', () => el.classList.remove('is-pointer-focus'), { once: true });
    }
    el.focus(/** @type {FocusOptions} */ ({ preventScroll, focusVisible: keyboardInput }));
  };
  function saveExpansion(action) {
    expanded = settingsTreeExpansion(expanded, action);
  }
  const icon = (name) => {
    const span = document.createElement('span');
    span.className = `mdi ${name}`;
    span.setAttribute('aria-hidden', 'true');
    return span;
  };
  const navigate = (tab) => {
    void (/** @type {any} */ (getSharedSpaNavigation()))?.navigate({ panel: 'settings', settingsTab: tab }, { explicit: true });
  };
  /** A branch is an expansion control; only a leaf changes the current panel. */
  function render() {
    const tree = currentTree();
    const active = resolveSettingsTreeActive(tree, activeTab);
    const scrollTop = container.scrollTop;
    nav.replaceChildren();
    /**
     * Groups render like the "All chats" header, categories like chat rows and
     * subcategories like nested subchats. A leaf keeps a chevron slot only when
     * a sibling is a branch, so icons in one list stay aligned.
     */
    function nodeEl(node, chevronSlot) {
      const open = expanded.includes(node.id);
      const hasChildren = node.children.length > 0;
      const isActive = node.id === active?.id;
      const li = document.createElement('li');
      li.className = 'sidebar-settings-node';
      if (isActive || active?.ancestors?.includes(node.id)) li.classList.add('is-active');
      if (hasChildren && !open) li.classList.add('is-collapsed');
      // A leaf next to branches is shifted by the chevron width instead of
      // holding an empty chevron, so its highlight starts at the icon.
      if (!hasChildren && chevronSlot) li.classList.add('is-slotted');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sidebar-chat-item sidebar-settings-row';
      if (isActive) row.classList.add('is-active');
      row.dataset.settingsNode = node.id;
      row.dataset.settingsTab = node.tab;
      if (isActive) row.setAttribute('aria-current', 'page');
      if (hasChildren) {
        row.dataset.settingsToggle = node.id;
        row.setAttribute('aria-expanded', String(open));
        row.setAttribute('aria-controls', `settings-children-${node.id}`);
        row.setAttribute('aria-label', t(open ? 'sidebar.collapseGroup' : 'sidebar.expandGroup', { label: t(node.labelKey) }));
      }
      if (hasChildren) row.append(icon(`sidebar-settings-chevron ${open ? 'mdi-chevron-down' : 'mdi-chevron-right'}`));
      const mark = document.createElement('span');
      mark.className = 'sidebar-chat-item-harness';
      mark.setAttribute('aria-hidden', 'true');
      const iconSpec = resolveSettingsNodeIcon(node);
      if (iconSpec?.kind === 'img') {
        const img = document.createElement('img');
        img.src = iconSpec.src;
        img.alt = '';
        img.loading = 'lazy';
        mark.append(img);
      } else if (iconSpec) {
        mark.append(icon(iconSpec.cls));
      }
      const title = document.createElement('span');
      title.className = 'sidebar-workspace-title';
      title.textContent = t(node.labelKey);
      row.append(mark, title);
      if (hasChildren) {
        const count = document.createElement('span');
        count.className = 'sidebar-workspace-count';
        count.textContent = String(node.children.length);
        row.append(count);
      }
      const toggle = () => {
        saveExpansion({ type: 'toggle', id: node.id });
        render();
        moveFocus(nav.querySelector(`[data-settings-node="${node.id}"]`), true);
      };
      row.addEventListener('click', () => hasChildren ? toggle() : navigate(node.tab));
      row.addEventListener('keydown', event => {
        if (!hasChildren || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        if ((event.key === 'ArrowRight') !== open) toggle();
      });
      li.append(row);
      if (hasChildren) {
        const list = document.createElement('ul');
        list.id = `settings-children-${node.id}`;
        list.className = 'sidebar-settings-children';
        list.hidden = !open;
        // Nest lists so each connector stops at its own last sibling, even when
        // that sibling expands into another branch.
        if (open) list.append(...nodeList(node.children));
        li.append(list);
      }
      return li;
    }
    const nodeList = nodes => {
      const slot = nodes.some(node => node.children.length > 0);
      return nodes.map(node => nodeEl(node, slot));
    };
    for (const group of ['general', 'agents', 'system', 'advanced']) {
      const nodes = tree.filter(node => (node.advanced ? 'advanced' : node.group) === group);
      if (!nodes.length) continue;
      const section = document.createElement('section');
      section.className = `sidebar-workspace is-all-chats sidebar-settings-group${group === 'advanced' ? ' is-advanced' : ''}`;
      const header = document.createElement('div');
      header.className = 'sidebar-workspace-header sidebar-settings-group-header';
      const title = document.createElement('h3');
      title.className = 'sidebar-workspace-title';
      title.textContent = t(`settings.categoryGroup.${group}`);
      const count = document.createElement('span');
      count.className = 'sidebar-workspace-count';
      count.textContent = String(nodes.length);
      header.append(title, count);
      const list = document.createElement('ul');
      list.className = 'sidebar-settings-list';
      list.append(...nodeList(nodes));
      section.append(header, list);
      nav.append(section);
    }
    container.scrollTop = scrollTop;
  }
  window.addEventListener('cr-settings-sidebar-route', event => {
    const { mode, tab, openTree, entered } = /** @type {CustomEvent} */ (event).detail;
    if (mode !== 'settings') return;
    const nextTab = tab || document.getElementById('settings-panel')?.dataset.activeSettingsTab || 'workspace';
    const changed = activeTab !== nextTab;
    activeTab = nextTab;
    if (entered) expanded = [];
    // Opening settings without a tab shows the collapsed tree, not the last panel's path.
    if (changed && tab) saveExpansion({ type: 'reveal', ancestors: resolveSettingsTreeActive(currentTree(), activeTab)?.ancestors });
    render();
    if (window.matchMedia('(max-width: 768px)').matches) {
      if (openTree) moveFocus(nav.querySelector('[aria-current="page"]'));
      else moveFocus(document.getElementById('header-menu-btn'));
    }
  });
  window.addEventListener('cr-lang-changed', render);
  render();
  initSettingsSearch({ input, sidebar: container, nav, onFilter: query => { nav.hidden = !!query; } });
}
