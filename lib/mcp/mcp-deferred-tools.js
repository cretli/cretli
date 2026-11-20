/**
 * Which Cretli tools a bridge keeps in the first prompt.
 *
 * The rest of the catalog is marked deferred so a harness with tool search
 * loads a definition only when a task needs it. Dependency-free: the stdio
 * bridge imports it and must stay fast to start.
 */

/**
 * Tools named by the delegation, Watcher and todo prompts, plus the chat
 * protocol tools. A tool a standing prompt names must stay here.
 */
export const MCP_ALWAYS_LOADED_TOOLS = Object.freeze(new Set([
  'chat_event',
  'chat_set_title',
  'chat_show',
  'decision_request',
  'delegation_ack',
  'delegation_inbox',
  'delegation_list',
  'delegation_rate',
  'delegation_reply',
  'delegation_show',
  'delegation_start',
  'delegation_verify',
  'delegation_wait',
  'harness_list',
  'model_list',
  'model_pick',
  'todo_create',
  'todo_list',
  'todo_next_ready',
  'todo_show',
  'todo_update',
  'watcher_report',
  'watcher_show',
  'watcher_status',
  'watcher_update',
  'wmem_add',
  'wmem_list',
  'workflow_show',
  'workflow_update',
]));

const BUILTIN_TOOL_PREFIX = 'mcp__cretli_builtincretl__';

/**
 * @template {{ name?: string, _meta?: Record<string, unknown> }} T
 * @param {T[]} tools Catalog as the bridge lists it.
 * @returns {T[]} Copies; `anthropic/alwaysLoad: false` on every non-core tool.
 */
export function markDeferredMcpTools(tools) {
  return tools.map((tool) => {
    const name = String(tool?.name || '');
    const shortName = name.startsWith(BUILTIN_TOOL_PREFIX) ? name.slice(BUILTIN_TOOL_PREFIX.length) : name;
    if (MCP_ALWAYS_LOADED_TOOLS.has(shortName)) return tool;
    return { ...tool, _meta: { ...tool?._meta, 'anthropic/alwaysLoad': false } };
  });
}
