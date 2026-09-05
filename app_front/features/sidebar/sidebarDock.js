/**
 * Desktop dock layout for the workspace/chat sidebar.
 * Overlay stays the default; pin only reserves horizontal space on desktop.
 */

/**
 * @param {{ pinned?: boolean, open?: boolean, isMobile?: boolean }} [options]
 * @returns {boolean}
 */
export function isSidebarDocked(options = {}) {
  const pinned = options.pinned === true;
  const open = options.open === true;
  const isMobile = options.isMobile === true;
  return pinned && open && !isMobile;
}

/**
 * Resume cleanup used to close every open drawer, which also ran on the
 * initial `pageshow` after refresh and wiped the persisted desktop pin.
 * Only a mobile overlay can block the page; a pinned/desktop sidebar stays.
 *
 * @param {{ isOpen?: boolean, isPinned?: boolean, isMobile?: boolean }} [options]
 * @returns {boolean}
 */
export function shouldCloseSidebarOnResume(options = {}) {
  if (options.isOpen !== true) return false;
  if (options.isPinned === true) return false;
  return options.isMobile === true;
}
