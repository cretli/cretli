/** Shared SPA navigation handle (stage 3). */

/** @type {ReturnType<import('./spaNavigation.js').createSpaNavigation> | null} */
let navigation = null;

/** @type {string | null} Canonical URL queued before navigation init (view context boot). */
let pendingCanonicalUrl = null;

/**
 * @param {object | null} created
 */
export function setSharedSpaNavigation(created) {
  navigation = created || null;
  if (!navigation || !pendingCanonicalUrl) return;
  const url = pendingCanonicalUrl;
  pendingCanonicalUrl = null;
  navigation.replaceCanonicalUrl(url);
}

/** @returns {object | null} */
export function getSharedSpaNavigation() {
  return navigation;
}

/**
 * @param {object} intent
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export function navigateSpa(intent, options) {
  if (!navigation) return Promise.resolve();
  return navigation.navigate(intent, options);
}

/**
 * @param {string} canonicalPath
 */
export function replaceSpaCanonical(canonicalPath) {
  if (typeof canonicalPath !== 'string' || !canonicalPath.startsWith('/')) return;
  if (navigation) {
    navigation.replaceCanonicalUrl(canonicalPath);
    return;
  }
  pendingCanonicalUrl = canonicalPath;
}
