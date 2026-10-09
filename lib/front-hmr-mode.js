/**
 * Gate for the in-process webpack HMR compiler.
 *
 * HMR is opt-in: only a truthy `CRETLI_FRONT_HMR` (legacy
 * `CURSOR_REMOTE_FRONT_HMR`) enables the webpack-dev-middleware compiler inside
 * the server process. The default dev path is the external CLI watcher
 * (`npm run watch:front`), which keeps the webpack compiler out of `server.js`.
 */

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isFrontHmrEnvEnabled(raw) {
  return raw === '1' || raw === 'true';
}

/**
 * Effective HMR decision for the server process: production never runs HMR and
 * everything else needs an explicit truthy env value.
 *
 * @param {{ nodeEnv?: string, envRaw?: unknown }} [options]
 * @returns {boolean}
 */
export function resolveFrontHmrEnabled({ nodeEnv = '', envRaw = '' } = {}) {
  if (nodeEnv === 'production') return false;
  return isFrontHmrEnvEnabled(envRaw);
}

/**
 * Effective HMR value stored in `data/config.json`. Kept only for the Settings
 * UI and the restart helper, which relaunches the server with the explicit env
 * value; it never enables HMR on a plain `npm start` by itself.
 *
 * @param {object | null | undefined} settings
 * @returns {boolean}
 */
export function resolveFrontHmrEnabledFromSettings(settings) {
  if (settings && typeof settings.frontHmrEnabled === 'boolean') return settings.frontHmrEnabled;
  return false;
}
