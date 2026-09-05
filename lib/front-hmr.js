/**
 * Webpack HMR middleware on the same Express server (dev only).
 */

import { existsSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

/**
 * @param {{
 *   app: import('express').Express,
 *   projectRoot: string,
 *   enabled: boolean,
 * }} options
 */
export async function installFrontHmrMiddleware(options) {
  const { app, projectRoot, enabled } = options;
  if (!enabled) return;
  const webpackConfigPath = path.join(projectRoot, 'app_front', 'webpack.dev.js');
  if (!existsSync(webpackConfigPath)) {
    console.warn('[front-hmr] missing webpack.dev.js config');
    return;
  }
  try {
    const prevFrontHmrEnvCurrent = process.env.CRETLI_FRONT_HMR;
    const prevFrontHmrEnvLegacy = process.env.CURSOR_REMOTE_FRONT_HMR;
    let mod;
    try {
      process.env.CRETLI_FRONT_HMR = '1';
      process.env.CURSOR_REMOTE_FRONT_HMR = '1';
      mod = await import(pathToFileURL(webpackConfigPath).href);
    } finally {
      if (typeof prevFrontHmrEnvCurrent === 'undefined') delete process.env.CRETLI_FRONT_HMR;
      else process.env.CRETLI_FRONT_HMR = prevFrontHmrEnvCurrent;
      if (typeof prevFrontHmrEnvLegacy === 'undefined') delete process.env.CURSOR_REMOTE_FRONT_HMR;
      else process.env.CURSOR_REMOTE_FRONT_HMR = prevFrontHmrEnvLegacy;
    }
    const configRequire = createRequire(pathToFileURL(webpackConfigPath).href);
    const webpack = configRequire('webpack');
    const nodeRequire = createRequire(pathToFileURL(path.join(projectRoot, 'package.json')).href);
    const webpackDevMiddleware = nodeRequire('webpack-dev-middleware');
    const webpackHotMiddleware = nodeRequire('webpack-hot-middleware');
    const devConfig = mod?.default || mod;
    if (!devConfig) {
      console.warn('[front-hmr] empty webpack.dev.js config');
      return;
    }
    const compiler = webpack(devConfig);
    app.use(
      webpackDevMiddleware(compiler, {
        publicPath: devConfig.output?.publicPath || '/dist/app/',
        writeToDisk: false,
        stats: 'errors-warnings',
      }),
    );
    app.use(
      webpackHotMiddleware(compiler, {
        path: '/__webpack_hmr',
        heartbeat: 10000,
        log: false,
      }),
    );
    console.log('[front-hmr] active: /__webpack_hmr');
  } catch (err) {
    console.warn('[front-hmr] failed to start HMR:', err?.message || err);
  }
}
