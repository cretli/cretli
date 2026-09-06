/**
 * Server maps and resolvers for builtin MCP catalog tools.
 */

/** @type {{
 *   dataDir: string,
 *   taskRuns: Map<string, object>,
 *   agentRuns: Map<string, object>,
 *   loadTasksForWorkspace: (input: { workspaceFile?: string, workspaceFolder?: string }) => { tasks: object[] } | null,
 *   workspaceDirForAgent: (workspacePath?: string | null) => string,
 * }} */
let runtimeDeps = {
  dataDir: '',
  taskRuns: new Map(),
  agentRuns: new Map(),
  loadTasksForWorkspace: () => null,
  workspaceDirForAgent: () => '',
};

/**
 * @param {Partial<typeof runtimeDeps>} next
 */
export function setBuiltinMcpRuntimeDeps(next) {
  runtimeDeps = { ...runtimeDeps, ...next };
}

export function getBuiltinMcpRuntimeDeps() {
  return runtimeDeps;
}
