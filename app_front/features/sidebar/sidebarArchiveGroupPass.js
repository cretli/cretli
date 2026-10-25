/**
 * Render-pass registry for `<cr-sidebar-archive-group>` (stage 6.4).
 */

/** @typedef {object} SidebarArchiveGroupRegistration
 * @property {string} sidebarKey
 * @property {boolean} openSection
 * @property {number} count
 * @property {string} activeChatId
 * @property {Array<{ chat: object, level: number, isLastChild: boolean, parentId: string, continuationLevels: number[] }>} archiveTree
 * @property {object} deps
 */

/** @type {Map<string, SidebarArchiveGroupRegistration>} */
const payloadBySidebarKey = new Map();

/** @type {Set<string> | null} */
let passSidebarKeys = null;

export function beginSidebarArchiveGroupPass() {
  passSidebarKeys = new Set();
}

export function endSidebarArchiveGroupPass() {
  if (passSidebarKeys) {
    for (const key of payloadBySidebarKey.keys()) {
      if (!passSidebarKeys.has(key)) payloadBySidebarKey.delete(key);
    }
  }
  passSidebarKeys = null;
}

/**
 * @param {string} sidebarKey
 * @param {SidebarArchiveGroupRegistration} payload
 */
export function registerSidebarArchiveGroup(sidebarKey, payload) {
  const key = String(sidebarKey || '').trim();
  if (!key || !passSidebarKeys) return;
  payloadBySidebarKey.set(key, payload);
  passSidebarKeys.add(key);
}

/**
 * @param {string} sidebarKey
 * @returns {SidebarArchiveGroupRegistration | null}
 */
export function getSidebarArchiveGroupRegistration(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return null;
  return payloadBySidebarKey.get(key) || null;
}

/** Test-only reset. */
export function __resetSidebarArchiveGroupPassForTest() {
  payloadBySidebarKey.clear();
  passSidebarKeys = null;
}
