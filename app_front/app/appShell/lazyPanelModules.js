/**
 * Panel modules pulled in on demand. Terminal, Tasks and Agents carry xterm and
 * Files carries highlight.js, while the app boots into the chat panel, which
 * needs none of them.
 */

const importers = {
  terminal: () => import(/* webpackChunkName: "panel-terminal" */ '../../terminal.js'),
  tasks: () => import(/* webpackChunkName: "panel-tasks" */ '../../tasks.js'),
  agents: () => import(/* webpackChunkName: "panel-agents" */ '../../agents.js'),
  agentsSettings: () => import(/* webpackChunkName: "panel-agents" */ '../../agentsPanel.js'),
  files: () => import(/* webpackChunkName: "panel-files" */ '../../filesPanel.js'),
  git: () => import(/* webpackChunkName: "panel-misc" */ '../../gitPanel.js'),
  // GitHub keeps its own chunk: it is fetched right after boot to decide whether
  // the GitHub tab is visible at all, so it must not drag the other panels in.
  github: () => import(/* webpackChunkName: "panel-github" */ '../../githubPanel.js'),
  widget: () => import(/* webpackChunkName: "panel-misc" */ '../../widgetPanel.js'),
  instances: () =>
    import(/* webpackChunkName: "panel-misc" */ '../../features/instances/instancesPanel.js'),
  statusTests: () => import(/* webpackChunkName: "panel-misc" */ '../../statusTests.js'),
};

/** @type {Map<string, Promise<object>>} */
const pending = new Map();
/** @type {Map<string, object>} */
const loaded = new Map();

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
