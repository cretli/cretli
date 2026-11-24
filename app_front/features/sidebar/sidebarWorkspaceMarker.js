/** Workspace accent marker (emoji icon, or a dot in the workspace colour) shared by sidebar rows and menus. */

const WORKSPACE_COLORS = new Set(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray']);

/** Key of the virtual "all chats" workspace used by the flat view mode. */
export const ALL_CHATS_KEY = '__all_chats__';

/**
 * @param {{ color?: string, icon?: string } | null | undefined} workspace
 * @param {(value: unknown) => string} escapeHtml
 * @returns {string}
 */
export function renderWorkspaceMarkerHtml(workspace, escapeHtml) {
  const color = WORKSPACE_COLORS.has(String(workspace?.color || '')) ? String(workspace?.color) : '';
  const icon = String(workspace?.icon || '').trim();
  const cls = 'sidebar-ws-marker' + (color ? ' ws-color-' + color : '') + (icon ? ' has-icon' : '');
  return '<span class="' + cls + '" aria-hidden="true">' + (icon ? escapeHtml(icon) : '') + '</span>';
}
