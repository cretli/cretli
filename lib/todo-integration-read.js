import { fingerprintTodoMaterial, fingerprintTodoTree } from './todo-integration-proof.js';

/**
 * Server-computed TODO integration summaries shared by REST and MCP reads.
 * Stored integration states remain the lifecycle source; summaries never write
 * back or infer integration from TODO status or review state.
 */

const PROOF_STRING_FIELDS = Object.freeze([
  'targetBranch', 'targetCommit', 'sourceCommit', 'materialRevision',
  'source', 'confirmedAt', 'changeRef', 'todoMaterialFingerprint',
]);

function readText(value) {
  return String(value ?? '').trim();
}

/**
 * A proof must carry the task-to-change link and server verification result.
 * @param {object|null|undefined} integration
 * @returns {object|null}
 */
export function readCurrentTodoIntegrationEvidence(integration, todo = null) {
  const evidence = integration?.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  if (PROOF_STRING_FIELDS.some((field) => !readText(evidence[field]))) return null;
  if (evidence.branchVerified !== true || evidence.changeAttested !== true) return null;
  if (readText(evidence.scope) === 'tree' && !readText(evidence.treeMaterialFingerprint)) return null;
  if (readText(evidence.cycleId) !== readText(integration.cycleId)
    && readText(integration.cycleId)) return null;
  if (readText(evidence.materialRevision) !== readText(integration.materialRevision)
    && readText(integration.materialRevision)) return null;
  if (todo && readText(evidence.todoMaterialFingerprint) !== fingerprintTodoMaterial(todo)) return null;
  return evidence;
}

/**
 * @param {object} item
 * @returns {object}
 */
export function summarizeTodoIntegration(item) {
  const integration = item?.integration && typeof item.integration === 'object'
    ? item.integration
    : null;
  const state = readText(integration?.state);
  const evidence = readCurrentTodoIntegrationEvidence(integration, item);
  const isNoCode = integration?.changeScope === 'none'
    && readText(integration?.noCodeMaterialFingerprint) === fingerprintTodoMaterial(item || {});
  const isIntegrated = state === 'integrated' && Boolean(evidence);
  const isAwaiting = state === 'ready';
  const isRejected = state === 'rejected';
  const reason = readText(integration?.reason);
  const isConflict = reason.startsWith('integration_conflict') || reason.startsWith('patch_invalid')
    || reason.startsWith('smart_merge_conflict');
  const detail = isNoCode ? 'no_code_changes'
    : integration?.changeScope === 'none' ? 'stale_evidence'
    : isRejected ? 'rejected'
    : isConflict ? 'conflict'
      : state === 'integrated' && !evidence && integration?.evidence ? 'stale_evidence'
        : reason.startsWith('proof_invalidated:') ? 'proof_invalidated'
          : state === 'integrated' && !evidence ? 'legacy_confirmation'
            : readText(integration?.appliedAt) && isAwaiting ? 'working_directory_applied'
            : '';
  return {
    state: isIntegrated ? 'integrated' : isAwaiting ? 'awaiting' : 'unconfirmed',
    detail,
    storedState: state,
    hasCurrentEvidence: Boolean(evidence),
    targetBranch: readText(evidence?.targetBranch),
    targetCommit: readText(evidence?.targetCommit),
    sourceCommit: readText(evidence?.sourceCommit),
    confirmedAt: readText(evidence?.confirmedAt),
    source: readText(evidence?.source),
    appliedAt: readText(integration?.appliedAt),
    reason: isNoCode ? readText(integration?.noCodeReason) : reason,
  };
}

/**
 * Add node summaries and a derived parent aggregate to a complete TODO list.
 * A parent's own explicit whole-tree evidence takes precedence; otherwise all
 * code-changing leaf descendants must prove the same target.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
export function attachTodoIntegrationReadModels(items) {
  const list = Array.isArray(items) ? items : [];
  const children = new Map();
  for (const item of list) {
    const parentId = readText(item?.parentId);
    if (!parentId) continue;
    const rows = children.get(parentId) || [];
    rows.push(item);
    children.set(parentId, rows);
  }
  const own = new Map(list.map((item) => [readText(item?.id), summarizeTodoIntegration(item)]));
  const descendants = (item, seen = new Set()) => {
    const id = readText(item?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const direct = children.get(id) || [];
    if (!direct.length) return [item];
    return direct.flatMap((child) => descendants(child, seen));
  };
  return list.map((item) => {
    const summary = own.get(readText(item?.id)) || summarizeTodoIntegration(item);
    const direct = children.get(readText(item?.id)) || [];
    if (!direct.length) return { ...item, integrationSummary: summary };
    const evidence = readCurrentTodoIntegrationEvidence(item?.integration, item);
    const hasCurrentTreeProof = evidence?.scope === 'tree'
      && readText(evidence.treeMaterialFingerprint) === fingerprintTodoTree(list, readText(item?.id));
    if (hasCurrentTreeProof) {
      return { ...item, integrationSummary: { ...summary, aggregate: { confirmed: 1, required: 1 } } };
    }
    const leaves = descendants(item);
    const required = leaves.filter((leaf) => own.get(readText(leaf.id))?.detail !== 'no_code_changes'
      && leaf.integration?.evidence?.changeScope !== 'none');
    const proven = required.filter((leaf) => own.get(readText(leaf.id))?.state === 'integrated');
    const targets = new Set(proven.map((leaf) => {
      const proof = readCurrentTodoIntegrationEvidence(leaf.integration, leaf);
      return proof?.targetBranch || '';
    }));
    const allSameTarget = targets.size <= 1;
    const state = required.length > 0 && proven.length === required.length && allSameTarget
      ? 'integrated'
      : proven.length > 0 ? 'partial'
        : leaves.some((leaf) => own.get(readText(leaf.id))?.state === 'awaiting') ? 'awaiting'
          : 'unconfirmed';
    const details = leaves.map((leaf) => own.get(readText(leaf.id))).filter((row) => row?.detail);
    const counts = {
      confirmed: proven.length,
      required: required.length,
      rejected: leaves.filter((leaf) => own.get(readText(leaf.id))?.detail === 'rejected').length,
      conflicts: leaves.filter((leaf) => own.get(readText(leaf.id))?.detail === 'conflict').length,
      missing: Math.max(0, required.length - proven.length),
    };
    return {
      ...item,
      integrationSummary: {
        ...summary,
        state,
        detail: details.some((row) => row.detail === 'conflict') ? 'conflict'
          : details.some((row) => row.detail === 'rejected') ? 'rejected' : '',
        aggregate: counts,
        targetBranch: targets.size === 1 ? [...targets][0] : '',
      },
    };
  });
}
