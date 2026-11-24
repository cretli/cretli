import { t } from '../../i18n/index.js';
import { getViewContextRuntimeScope } from '../../app/appShell/viewContextBridge.js';

const keys = {
  global: 'scopeGlobal', server: 'scopeServer', workspace: 'scopeWorkspace',
  folder: 'scopeFolder', 'per-item': 'scopePerItem',
};
let initialized = false;
let getWorkspaces = () => [];

const NAME_ATTR = 'data-settings-scope-name';

/**
 * Panels with their own scope picker (MCP servers, MCP Operator) publish the
 * scope they actually edit here; it wins over the header context for the
 * section that contains `source`. An empty name clears the override.
 * @param {Element | null} source
 * @param {string} name
 */
export function setSettingsScopeName(source, name) {
  const section = source?.closest('[data-settings-scope]');
  if (!section) return;
  if (name) section.setAttribute(NAME_ATTR, name); else section.removeAttribute(NAME_ATTR);
  refreshSettingsScopeBadges();
}

/** Refresh from the tab context, including dynamically rendered delegation fields. */
export function refreshSettingsScopeBadges() {
  const { workspaceFile, workspaceFolder } = getViewContextRuntimeScope();
  const workspace = getWorkspaces().find((item) => (item.workspaceFile || item.id) === workspaceFile);
  const workspaceName = workspace?.name || (workspaceFile?.startsWith('cretli:ws:') ? '' : workspaceFile?.split(/[\\/]/).pop()?.replace(/\.code-workspace$/, '')) || '';
  document.querySelectorAll('[data-settings-scope]').forEach((element) => {
    const scope = element.getAttribute('data-settings-scope');
    if (!keys[scope]) return;
    let badge = /** @type {import('../../components/ui/cr-scope-badge.js').CrScopeBadge} */ (Array.from(element.children).find((child) => child.tagName === 'CR-SCOPE-BADGE'));
    if (!badge) {
      badge = /** @type {import('../../components/ui/cr-scope-badge.js').CrScopeBadge} */ (document.createElement('cr-scope-badge'));
      element.prepend(badge);
    }
    badge.scope = scope;
    badge.label = t(`settings.${keys[scope]}`);
    // A panel-supplied name beats the header context; a workspace badge that
    // only has a folder (no registry workspace) names the folder, never blank.
    const own = element.getAttribute(NAME_ATTR);
    badge.name = own || (scope === 'folder' ? workspaceFolder : (workspaceName || workspaceFolder || ''));
    badge.emptyLabel = t(`settings.${scope === 'folder' ? 'scopeNoFolder' : 'scopeNoWorkspace'}`);
  });
}

/** The shell supplies registry names without coupling the primitive to app state. */
export function initSettingsScopeBadges(options = {}) {
  // Lit is loaded lazily so importing this module (e.g. from mcpSettings) never
  // touches the DOM; the badge also ships in components/ui/index.js.
  import('../../components/ui/cr-scope-badge.js').then(() => { if (typeof document !== 'undefined') refreshSettingsScopeBadges(); }, () => {});
  getWorkspaces = options.getWorkspaces || getWorkspaces;
  if (!initialized) {
    initialized = true;
    window.addEventListener('cretli-view-context-changed', refreshSettingsScopeBadges);
    window.addEventListener('cr-lang-changed', refreshSettingsScopeBadges);
    const root = document.querySelector('.settings-sections');
    if (root) new MutationObserver((records) => {
      if (records.some((record) => Array.from(record.addedNodes).some((node) =>
        node.nodeType === 1 && node.nodeName !== 'CR-SCOPE-BADGE'))) refreshSettingsScopeBadges();
    }).observe(root, { childList: true, subtree: true });
  }
  refreshSettingsScopeBadges();
}
