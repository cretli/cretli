import { remapSettingsTab } from '../../../lib/spa-routes.js';

export function buildSettingsTree(categories, subcategories) {
  const nodes = new Map(categories.map(category => [category.id, { ...category, tab: category.id, children: [] }]));
  for (const child of subcategories) nodes.set(child.id, { ...child, children: [] });
  for (const child of subcategories) nodes.get(child.parent)?.children.push(nodes.get(child.id));
  return categories.map(category => nodes.get(category.id));
}

export function resolveSettingsTreeActive(tree, tab) {
  let match = null;
  const visit = (nodes, ancestors) => {
    for (const node of nodes) {
      if (remapSettingsTab(node.tab) === remapSettingsTab(tab)) match = { id: node.id, ancestors };
      visit(node.children, [...ancestors, node.id]);
    }
  };
  visit(tree, []);
  return match;
}

/** Explicit collapse wins until navigation changes to another node. */
export function settingsTreeExpansion(expanded, action) {
  const next = new Set(expanded);
  if (action.type === 'toggle') {
    if (next.has(action.id)) next.delete(action.id);
    else next.add(action.id);
  } else if (action.type === 'reveal') {
    for (const id of action.ancestors || []) next.add(id);
  }
  return [...next];
}

export function sidebarModeForPanel(panel) {
  return panel === 'settings' ? 'settings' : 'chats';
}

export function settingsSidebarTransition(previous, panel, tab = '') {
  const mode = sidebarModeForPanel(panel);
  return { mode, openTree: mode === 'settings' && !tab, entered: mode === 'settings' && previous !== mode };
}

const HARNESS_PROVIDER_NODE = /^harness-([a-z]+)$/;

/**
 * Harness id of a per-provider settings tab (`harness-codex-models` -> `codex`),
 * or '' for the overview and every non-harness tab.
 *
 * @param {Array<{ id: string, children: Array<{ id: string, tab: string, children: any[] }> }>} tree
 * @param {string} tab
 */
export function harnessIdForSettingsTab(tree, tab) {
  const root = tree.find(node => node.id === 'harness');
  const wanted = remapSettingsTab(tab);
  for (const provider of root?.children || []) {
    const id = HARNESS_PROVIDER_NODE.exec(provider.id)?.[1];
    if (!id || id === 'overview') continue;
    if (remapSettingsTab(provider.tab) === wanted || provider.children.some(leaf => remapSettingsTab(leaf.tab) === wanted)) return id;
  }
  return '';
}

/**
 * The sidebar lists the per-provider pages (Keys, Models, ...) once: the
 * provider branches under Harnesses fold into leaves that point at the
 * provider chosen in the content picker. Other subtrees are returned as is.
 *
 * @param {any[]} tree
 * @param {string} harnessId
 */
export function foldHarnessProviders(tree, harnessId) {
  return tree.map(node => {
    if (node.id !== 'harness') return node;
    const providers = node.children.filter(child => HARNESS_PROVIDER_NODE.test(child.id) && child.id !== 'harness-overview');
    if (!providers.length) return node;
    const chosen = providers.find(child => child.id === `harness-${harnessId}`) || providers[0];
    const leaves = chosen.children.map(leaf => ({ ...leaf, id: `harness-provider${leaf.id.slice(chosen.id.length)}`, children: [] }));
    return { ...node, children: [...node.children.filter(child => !providers.includes(child)), ...leaves] };
  });
}
