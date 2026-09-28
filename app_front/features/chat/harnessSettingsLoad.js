/**
 * When to pull the seven harness model catalogs (slow CodeBuddy / OpenCode / SDK).
 *
 * @param {'boot' | 'settings' | 'new-chat' | 'models-changed' | 'lang'} reason
 * @returns {boolean}
 */
export function shouldLoadHarnessModelCatalogs(reason) {
  return reason === 'settings' || reason === 'models-changed';
}
