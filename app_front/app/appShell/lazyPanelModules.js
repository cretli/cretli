/**
 * Panel modules pulled in on demand. Terminal and Tasks carry xterm and
 * Files carries highlight.js, while the app boots into the chat panel, which
 * needs none of them.
 */

const importers = {
  terminal: () => import(/* webpackChunkName: "panel-terminal" */ '../../features/terminal/index.js'),
  tasks: () => import(/* webpackChunkName: "panel-tasks" */ '../../features/tasks/index.js'),
  apps: () => import(/* webpackChunkName: "panel-misc" */ '../../features/apps/index.js'),
  agentsSettings: () => import(/* webpackChunkName: "settings-agents" */ '../../features/settings/agentsSettingsPanel.js'),
  files: () => import(/* webpackChunkName: "panel-files" */ '../../features/files/index.js'),
  git: () => import(/* webpackChunkName: "panel-misc" */ '../../features/git/gitPanel.js'),
  // GitHub keeps its own chunk: it is fetched right after boot to decide whether
  // the GitHub tab is visible at all, so it must not drag the other panels in.
  github: () => import(/* webpackChunkName: "panel-github" */ '../../features/git/githubPanel.js'),
  widget: () => import(/* webpackChunkName: "panel-misc" */ '../../features/widgets/index.js'),
  mcpSettings: () => import(/* webpackChunkName: "panel-misc" */ '../../features/settings/mcpSettings.js'),
  executionSettings: () => import(/* webpackChunkName: "panel-misc" */ '../../features/settings/executionSettings.js'),
  watcherSettings: () => import(/* webpackChunkName: "panel-misc" */ '../../features/settings/workspaceWatcherSettings.js'),
  instances: () =>
    import(/* webpackChunkName: "panel-misc" */ '../../features/instances/instancesPanel.js'),
  statusTests: () => import(/* webpackChunkName: "panel-misc" */ '../../features/statusTests/views/statusTestsPanel.js'),
  browser: () =>
    import(/* webpackChunkName: "panel-browser" */ '../../features/browser/browserPanel.js'),
};

/** @type {Map<string, Promise<object>>} */
const pending = new Map();
/** @type {Map<string, object>} */
const loaded = new Map();

/**
 * True when the panel is a separate chunk. Chat, Todo, Logs and Settings live
 * in the main bundle; asking the loader for them rejects and must not block
 * navigation.
 * @param {string} key
 * @returns {boolean}
 */
export function hasLazyPanelModule(key) {
  return Object.prototype.hasOwnProperty.call(importers, key);
}

/**
 * Loads a panel module once and keeps it for later synchronous access.
 * @param {string} key
 * @returns {Promise<object>}
 */
export function loadPanelModule(key) {
  const alreadyLoaded = loaded.get(key);
  if (alreadyLoaded) return Promise.resolve(alreadyLoaded);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const importer = importers[key];
  if (!importer) return Promise.reject(new Error(`Unknown panel module: ${key}`));
  const promise = importer()
    .then((mod) => {
      loaded.set(key, mod);
      return mod;
    })
    .finally(() => {
      pending.delete(key);
    });
  pending.set(key, promise);
  return promise;
}

/**
 * Returns the module only when it is already loaded. Callers that cannot wait
 * for a chunk (send bars, special characters, copy buttons) use this and treat
 * a missing module as "panel never opened".
 * @param {string} key
 * @returns {object | null}
 */
export function getLoadedPanelModule(key) {
  return loaded.get(key) || null;
}
