/**
 * Family tools of the Realtime executor: the single-purpose handlers that are no longer separate tools are
 * detached from `handlers` and reached only through `workspace`, `sidebar`, `chat_ops`, `app_status` (to keep the
 * schema inside its token budget, docs/voice-control-coverage.md §9d), plus the `app_settings` reading actions
 * and the `inbox` tool. Split from `realtimeTools.js` to keep that file inside the front-size ratchet.
 */

import { createReadSettingsHandlers, VOICE_READ_SETTING_ACTIONS } from './voiceReadSettingsTools.js';
import { buildReadSettingsDeps } from './voiceReadSettingsDeps.js';

const SUB_TOOL_NAMES = [
  'list_chats', 'get_chat_status', 'get_cost', 'create_chat', 'close_chat', 'rename_chat', 'fork_chat',
  'run_task', 'list_tasks', 'list_workspaces', 'switch_workspace', 'list_folders', 'switch_folder',
  'open_chat_sidebar', 'close_chat_sidebar',
];

/**
 * @param {Record<string, (args: any) => Promise<object>>} handlers the executor's handler map; mutated in place
 * @param {{
 *   stepBinding: ReturnType<typeof import('./voiceConfirmBinding.js').createConfirmBinding>,
 *   driverConfirm: import('./voiceConfirmBinding.js').BindingDriver,
 *   bindingContext: () => Promise<import('./voiceConfirmBinding.js').BindingContext>,
 *   isToolConfirm: (value: unknown) => boolean,
 *   commandHandlers: { inbox: (args: any, options: object) => Promise<object> },
 * }} deps
 * @returns {Record<string, (args: any) => Promise<object>>} the detached single-purpose handlers
 */
export function installToolFamilies(handlers, deps) {
  const { stepBinding, driverConfirm, bindingContext, isToolConfirm, commandHandlers } = deps;
  const subHandlers = {};
  for (const name of SUB_TOOL_NAMES) {
    subHandlers[name] = handlers[name];
    delete handlers[name];
  }

  const readSettingsTools = createReadSettingsHandlers(buildReadSettingsDeps());

  /** @type {Record<string, (args: any) => Promise<object>>} chat_ops actions that reuse a single-purpose handler */
  const CHAT_OPS_EXTRA = {
    list: () => subHandlers.list_chats(),
    create: (args) => subHandlers.create_chat({ workspace: args?.workspace, title: args?.text }),
    close: (args) => subHandlers.close_chat({ chat_id: args?.chat_id, title: args?.query }),
    rename: (args) => subHandlers.rename_chat({ title: args?.text, chat_id: args?.chat_id, current_title: args?.query }),
    fork: (args) => subHandlers.fork_chat({ title: args?.text, harness: args?.harness }),
  };
  const searchRestoreQueueSteer = handlers.chat_ops;
  handlers.chat_ops = async (args) => {
    const extra = CHAT_OPS_EXTRA[String(args?.action || '').trim().toLowerCase()];
    return extra ? extra(args) : searchRestoreQueueSteer(args);
  };

  const baseAppStatus = handlers.app_status;
  handlers.app_status = async (args) => {
    const action = String(args?.action || '').trim().toLowerCase();
    if (action === 'chat') return subHandlers.get_chat_status();
    if (action === 'cost') return subHandlers.get_cost();
    return baseAppStatus(args);
  };

  const baseAppSettings = handlers.app_settings;
  handlers.app_settings = async (args) => {
    const action = String(args?.action || '').trim().toLowerCase();
    return VOICE_READ_SETTING_ACTIONS.includes(action) ? readSettingsTools.readSettings(args) : baseAppSettings(args);
  };

  /**
   * `workspace` task_run: a task runs arbitrary user-defined commands, so it is a confirm action. Step one resolves
   * the label and returns an id bound to it; step two needs confirm=true, that id and driver speech after the question.
   *
   * @param {{ label?: unknown, id?: unknown, confirm?: unknown }} args
   * @returns {Promise<object>}
   */
  async function runTaskTwoStep(args) {
    const context = await bindingContext();
    if (isToolConfirm(args?.confirm)) {
      const check = stepBinding.consume('task_run', String(args?.id || '').trim(), context, driverConfirm);
      if (!check.ok) return check.result;
      // The label comes from the binding, never from the confirming call, and must still exist verbatim:
      // re-matching it as a spoken fragment could pick another task if the list changed between the steps.
      return subHandlers.run_task({ label: check.data.label, exact: true });
    }
    const resolved = await subHandlers.run_task({ label: args?.label, resolveOnly: true });
    if (resolved.ok !== true) return resolved;
    const id = stepBinding.bind('task_run', 't', context, { label: resolved.label }, driverConfirm);
    return {
      ok: false,
      needsConfirm: true,
      id,
      task: resolved.label,
      untrusted: true,
      error: 'Ask the user. Then call workspace task_run with confirm=true and this id.',
    };
  }

  /** @type {Record<string, (args: any) => Promise<object>>} */
  const WORKSPACE_ACTIONS = {
    list: () => subHandlers.list_workspaces(),
    switch: (args) => subHandlers.switch_workspace(args),
    folders: () => subHandlers.list_folders(),
    folder: (args) => subHandlers.switch_folder(args),
    tasks: () => subHandlers.list_tasks(),
    task_run: runTaskTwoStep,
  };
  handlers.workspace = async (args) => {
    const action = String(args?.action || '').trim().toLowerCase();
    if (action !== 'task_run') stepBinding.cancel();
    const run = WORKSPACE_ACTIONS[action];
    return run ? run(args) : { ok: false, error: `Action must be one of: ${Object.keys(WORKSPACE_ACTIONS).join(', ')}` };
  };

  handlers.sidebar = async (args) => (
    args?.enable === false || args?.enable === 'false' ? subHandlers.close_chat_sidebar() : subHandlers.open_chat_sidebar()
  );

  handlers.inbox = async (args) => commandHandlers.inbox(args, {
    // Scout accept / reject need the driver to answer after the question, not only the model.
    driverConfirm,
  });

  return subHandlers;
}
