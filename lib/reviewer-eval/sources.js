/**
 * Real-history loaders for `extract`. Persistence and git are imported lazily
 * (and can be injected) so loading the eval modules never resolves the data dir.
 */

/**
 * @param {string} workspaceFolder
 * @param {{ todos: any[] }} input todos listed through the API
 * @param {{
 *   listDelegations?: (workspaceFolder: string) => any[],
 *   readLeafId?: (row: any) => string,
 *   parseVerdict?: (report: unknown) => string,
 *   runGit?: (args: string[], cwd: string, options?: any) => { stdout: string },
 * }} [deps]
 */
export async function loadHistorySources(workspaceFolder, input, deps = {}) {
  const listDelegations = deps.listDelegations
    || (await import('../persist/delegations-persist.js')).listDelegationsForWorkspace;
  const readLeafId = deps.readLeafId
    || (await import('../delegation-workflow-leaf.js')).readDelegationWorkflowLeafIdFromRow;
  const parseVerdict = deps.parseVerdict || (await import('../delegation-verdict.js')).parseDelegationVerdict;
  const runGit = deps.runGit || (await import('../worktree/git-worktree.ts')).runGit;
  const passed = new Set();
  for (const row of listDelegations(workspaceFolder)) {
    if (String(row.assignment || '') !== 'review' || String(row.reviewSubject || '') !== 'code') continue;
    if (parseVerdict(row.report) !== 'PASS') continue;
    const leaf = readLeafId(row);
    if (leaf) passed.add(String(leaf).toLowerCase());
  }
  const byId = new Map(input.todos.map((t) => [t.id, t]));
  const material = (/** @type {any} */ todo) => (byId.get(todo.id) || todo).leafMaterial;
  /** @param {number} context */
  const diffReader = (context) => (/** @type {any} */ todo) => {
    const base = String(material(todo)?.baseCommit || '');
    const head = String(material(todo)?.lastCheckpoint?.commit || '');
    if (!base || !head) return '';
    return runGit(['diff', `-U${context}`, base, head], workspaceFolder, { allowFailure: true }).stdout;
  };
  return {
    passedReviewLeafIds: passed,
    // -U0 keeps hunk ranges exact: ground truth and same-line detection use them.
    readLeafDiff: diffReader(0),
    readFixDiff: diffReader(0),
    // The reviewer gets normal context.
    readReviewDiff: diffReader(3),
    readPreFixCommit: (/** @type {any} */ todo) => String(material(todo)?.lastCheckpoint?.commit || ''),
  };
}
