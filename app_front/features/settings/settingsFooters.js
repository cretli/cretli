/**
 * Shared sticky Save footers of the Settings panel.
 *
 * A footer is a sibling of `.settings-sections` carrying
 * `data-settings-footer-for="<tab>[ <tab>…]"`; it is visible only while the
 * active settings tab id is one of the listed ids.
 */

/**
 * @param {string | null | undefined} spec value of `data-settings-footer-for`
 * @param {string} tabId active settings tab id
 * @returns {boolean}
 */
export function footerMatchesTab(spec, tabId) {
  if (!spec || !tabId) return false;
  return String(spec).split(/\s+/).filter(Boolean).includes(tabId);
}

/**
 * Show the footers that belong to `tabId` and hide the rest.
 *
 * @param {ParentNode} root document or panel containing the footers
 * @param {string} tabId
 */
export function applySettingsFooters(root, tabId) {
  root.querySelectorAll('[data-settings-footer-for]').forEach((/** @type {HTMLElement} */ footer) => {
    footer.hidden = !footerMatchesTab(footer.getAttribute('data-settings-footer-for'), tabId);
  });
}
