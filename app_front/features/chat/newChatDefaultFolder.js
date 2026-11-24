/**
 * Default folder of a workspace for the new-chat modal: the one chosen under "Default folder"
 * in the workspace settings, else the first enabled folder, else the workspace directory.
 *
 * @param {any} workspace entry of the workspace list
 * @returns {string}
 */
export function resolveWorkspaceDefaultFolder(workspace) {
  if (!workspace) return '';
  const norm = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const folders = Array.isArray(workspace.folders) ? workspace.folders.filter((f) => f && f.enabled !== false && f.resolvedPath) : [];
  const wanted = norm(workspace.defaultFolder);
  const chosen = wanted ? folders.find((f) => norm(f.resolvedPath) === wanted) : null;
  return (chosen || folders[0])?.resolvedPath || workspace.workspaceDir || '';
}
