/**
 * Pure view helpers for the workspace-folder branch chip in the header.
 *
 * Kept free of DOM and API access so the chip contract can be unit tested
 * without a browser or a running server (same split as gitContextView.js).
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizePathValue(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * True when two Git info payloads describe the same branch of the same
 * repository, so the workspace chip would duplicate the execution badge.
 *
 * @param {object | null | undefined} infoA
 * @param {object | null | undefined} infoB
 * @returns {boolean}
 */
export function isSameRepoBranch(infoA, infoB) {
  if (!infoA?.isRepo || !infoB?.isRepo) return false;
  const topA = normalizePathValue(infoA.topLevel);
  const topB = normalizePathValue(infoB.topLevel);
  if (!topA || !topB || topA !== topB) return false;
  const branchA = String(infoA.branch || '').trim();
  const branchB = String(infoB.branch || '').trim();
  return Boolean(branchA) && branchA === branchB;
}

/**
 * Label/title for the workspace branch chip. `t` is injected so tests can
 * assert keys without loading the i18n bundle.
 *
 * @param {object | null | undefined} info Git info for the workspace scope
 * @param {(key: string, vars?: object) => string} t
 * @returns {{ visible: boolean, detached: boolean, label: string, title: string }}
 */
export function deriveWorkspaceBranchBadge(info, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  if (!info?.ok || !info.isRepo) {
    return { visible: false, detached: false, label: '', title: '' };
  }
  const branch = String(info.branch || '').trim();
  const head = String(info.head || '').trim();
  const detached = !branch || branch === 'HEAD';
  if (detached && !head) {
    return { visible: false, detached: true, label: '', title: '' };
  }
  const label = detached
    ? `${head} · ${translate('workspace.branchDetached')}`
    : branch;
  const parts = [translate('workspace.branchTitle', { branch: label })];
  if (info.aheadBehind) parts.push(info.aheadBehind);
  if (info.upstream) parts.push(`→ ${info.upstream}`);
  return {
    visible: true,
    detached,
    label,
    title: parts.join(' · '),
  };
}
