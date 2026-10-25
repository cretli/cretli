/**
 * Render-pass registry for `<cr-sidebar-subchat-group>` (stage 6.4).
 */

/** @typedef {object} SidebarSubchatGroupRegistration
 * @property {object} group
 * @property {string} sidebarKey
 * @property {string} parentTitle
 * @property {number[]} continuationLevels
 * @property {object} deps
 */

/** @type {Map<string, SidebarSubchatGroupRegistration>} */
const payloadByParentId = new Map();

/** @type {Set<string> | null} */
let passParentIds = null;

export function beginSidebarSubchatGroupPass() {
  passParentIds = new Set();
}

export function endSidebarSubchatGroupPass() {
  if (passParentIds) {
    for (const id of payloadByParentId.keys()) {
      if (!passParentIds.has(id)) payloadByParentId.delete(id);
    }
  }
  passParentIds = null;
}

/**
 * @param {string} parentId
 * @param {SidebarSubchatGroupRegistration} payload
 */
export function registerSidebarSubchatGroup(parentId, payload) {
  const id = String(parentId || '').trim();
  if (!id || !passParentIds) return;
  payloadByParentId.set(id, payload);
  passParentIds.add(id);
}

/**
 * @param {string} parentId
 * @returns {SidebarSubchatGroupRegistration | null}
 */
export function getSidebarSubchatGroupRegistration(parentId) {
  const id = String(parentId || '').trim();
  if (!id) return null;
  return payloadByParentId.get(id) || null;
}

/** Test-only reset. */
export function __resetSidebarSubchatGroupPassForTest() {
  payloadByParentId.clear();
  passParentIds = null;
}
