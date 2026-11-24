/**
 * Workspaces store schema v2: sidebar accent colour and icon.
 *
 * `sidebar_color` holds a palette key (red, blue, ...) and `sidebar_icon` a short
 * emoji string; both are empty when unset. Forward-only, additive columns, so an
 * existing v1 store keeps all of its rows.
 */
export default Object.freeze({
  version: 2,
  name: 'workspace_sidebar_appearance',
  sql: `
ALTER TABLE workspaces ADD COLUMN sidebar_color TEXT NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD COLUMN sidebar_icon TEXT NOT NULL DEFAULT '';
`,
});
