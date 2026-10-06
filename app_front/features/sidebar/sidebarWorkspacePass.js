/**
 * Render-pass registry for `<cr-sidebar-workspace>` (stage 6.4 mount boundary).
 */

/** @typedef {import('./sidebarWorkspaceModel.js').SidebarWorkspaceRegistration} SidebarWorkspaceRegistration */

/** @type {Map<string, SidebarWorkspaceRegistration>} */
const payloadBySidebarKey = new Map();

/** @type {Set<string> | null} */
let passSidebarKeys = null;

export function beginSidebarWorkspacePass() {
  passSidebarKeys = new Set();
}

export function endSidebarWorkspacePass() {
  if (passSidebarKeys) {
    for (const key of payloadBySidebarKey.keys()) {
      if (!passSidebarKeys.has(key)) payloadBySidebarKey.delete(key);
    }
  }
  passSidebarKeys = null;
}

/**
 * @param {string} sidebarKey
 * @param {SidebarWorkspaceRegistration} payload
 */
export function registerSidebarWorkspace(sidebarKey, payload) {
  const key = String(sidebarKey || '').trim();
  if (!key || !passSidebarKeys) return;
  payloadBySidebarKey.set(key, payload);
  passSidebarKeys.add(key);
}

/**
 * @param {string} sidebarKey
 * @returns {SidebarWorkspaceRegistration | null}
 */
export function getSidebarWorkspaceRegistration(sidebarKey) {
  const key = String(sidebarKey || '').trim();
  if (!key) return null;
  return payloadBySidebarKey.get(key) || null;
}

/** Test-only reset. */
export function __resetSidebarWorkspacePassForTest() {
  payloadBySidebarKey.clear();
  passSidebarKeys = null;
}
