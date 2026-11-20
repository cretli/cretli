import { whenViewContextScopedAccessAllowed } from '../../app/appShell/viewContextBridge.js';
import { todoWorkspaceQuery } from '../todo/todoWorkspaceScope.js';

export async function docsScope() {
  await whenViewContextScopedAccessAllowed();
  return Object.fromEntries(new URLSearchParams(todoWorkspaceQuery().replace(/^\?/, '')));
}
