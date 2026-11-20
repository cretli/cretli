/**
 * Pure decision for a partial workspace rebuild (leaf 00df6141 item 6): given the
 * signatures that produced the currently mounted `<li>` nodes, the ordered keys
 * of the next render and each key's fresh signature, decide which workspace
 * nodes can be reused as-is, which must be rebuilt, and which are gone.
 *
 * Reusing a node keeps its chat rows (and any in-flight DOM/animation) intact,
 * so a change in one workspace must not recreate the others.
 *
 * @param {Map<string, string>} previousSigs key → signature currently mounted
 * @param {string[]} orderedKeys sidebar keys in render order
 * @param {Map<string, string>} sigByKey fresh key → signature
 * @returns {{ reuseKeys: Set<string>, rebuildKeys: string[], removeKeys: string[] }}
 */
export function planWorkspaceRebuild(previousSigs, orderedKeys, sigByKey) {
  const reuseKeys = new Set();
  const rebuildKeys = [];
  for (const key of orderedKeys) {
    const sig = sigByKey.get(key) || '';
    if (previousSigs.get(key) === sig) reuseKeys.add(key);
    else rebuildKeys.push(key);
  }
  const ordered = new Set(orderedKeys);
  const removeKeys = [...previousSigs.keys()].filter((key) => !ordered.has(key));
  return { reuseKeys, rebuildKeys, removeKeys };
}
