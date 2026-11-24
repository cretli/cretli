import { REVIEW_VERIFY_E2E_IDS } from './sdk/sdk-review-verify.ts';

/**
 * Classify persisted verification evidence for a commit trailer.
 * @param {any} verifyResult
 * @param {any} [e2eIds]
 */
export function classifyVerifiedBy(verifyResult, e2eIds = REVIEW_VERIFY_E2E_IDS) {
  if (!verifyResult || verifyResult.status !== 'passed' || verifyResult.stale === true) return 'none';
  const ids = Array.isArray(verifyResult.ids) ? verifyResult.ids.map(String).filter(Boolean) : [];
  return ids.some((id) => e2eIds?.has ? e2eIds.has(id) : Array.isArray(e2eIds) && e2eIds.includes(id)) ? 'e2e' : 'unit';
}

/** Format the optional ids alongside the classification. */
export function buildVerifiedByTrailer(verifyResult, options = {}) {
  const value = classifyVerifiedBy(verifyResult, options.e2eIds);
  const ids = Array.isArray(verifyResult?.ids) ? [...new Set(verifyResult.ids.map(String).filter(Boolean))] : [];
  return [`Verified-by: ${value}`, ...(ids.length ? [`Verified-ids: ${ids.join(',')}`] : [])].join('\n');
}

/**
 * Resolve verification evidence from the newest implement/fix delegation for
 * a leaf. The newest row decides even when it has no result; older evidence
 * is never carried forward to a later implementation.
 * @param {{ workspaceFolder?: string, dataDir?: string, leafId?: string, e2eIds?: any, loadDelegations?: Function }} [options]
 */
export async function readLatestLeafVerifiedByTrailer({ workspaceFolder, dataDir, leafId, e2eIds, loadDelegations } = {}) {
  try {
    const { isImplementationWorkDelegationRow } = await import('./delegation-work-role.js');
    const targetLeafId = String(leafId || '').trim();
    let rows;
    if (loadDelegations) rows = await loadDelegations({ workspaceFolder, dataDir });
    else {
      const { listDelegationsForWorkspace } = await import('./persist/delegations-persist.js');
      rows = listDelegationsForWorkspace(String(workspaceFolder || ''), { dataDir });
    }
    const latest = rows
      .filter((row) => String(row.leafId || '') === targetLeafId && isImplementationWorkDelegationRow(row))
      .sort((a, b) => String(b.finishedAt || b.updatedAt || '').localeCompare(String(a.finishedAt || a.updatedAt || '')))[0];
    return buildVerifiedByTrailer(latest?.verifyResult || null, { e2eIds });
  } catch {
    return buildVerifiedByTrailer(null, { e2eIds });
  }
}

/** Parse trailers from a commit message or hook message file. */
export function parseVerifiedByTrailer(message) {
  const text = String(message || '');
  const verifiedBy = text.match(/^Verified-by:\s*(e2e|unit|none)\s*$/im)?.[1]?.toLowerCase() || '';
  const ids = text.match(/^Verified-ids:\s*(.*?)\s*$/im)?.[1]
    ?.split(',').map((id) => id.trim()).filter(Boolean) || [];
  return { verifiedBy, ids };
}
