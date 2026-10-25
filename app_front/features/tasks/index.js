/**
 * Public surface of the Tasks feature. `tasksPanel.js` holds the panel;
 * `state/` and `services/` hold scope, autostart (with the watcher lock),
 * debug logging, server-token and run-output helpers.
 */
export {
  initTasksPanel,
  ensureTaskRunsReconnected,
  preloadTasksDropdown,
  refreshTasksList,
  runTaskByLabel,
  restoreTaskRunFromRoute,
  listScopedTaskRunIdsForRoute,
  getTasksTerminalState,
  fitTasksTerminal,
} from './tasksPanel.js';
