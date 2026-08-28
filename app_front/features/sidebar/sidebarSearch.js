/**
 * Case-insensitive substring match for the sidebar chat filter.
 *
 * @param {string} query
 * @param {{ title?: string, workspaceName?: string }} item
 * @returns {boolean}
 */
export function matchesSidebarSearch(query, item) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return true;
  const title = String(item?.title || '').toLocaleLowerCase();
  const workspaceName = String(item?.workspaceName || '').toLocaleLowerCase();
  return title.includes(needle) || workspaceName.includes(needle);
}
