import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isFrontHmrEnvEnabled,
  resolveFrontHmrEnabled,
  resolveFrontHmrEnabledFromSettings,
} from '../lib/front-hmr-mode.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webpackConfigUrl = pathToFileURL(path.join(projectRoot, 'app_front', 'webpack.dev.js')).href;

function readWebpackDevFlags(envOverrides) {
  const env = { ...process.env };
  delete env.CRETLI_FRONT_HMR;
  delete env.CURSOR_REMOTE_FRONT_HMR;
  Object.assign(env, envOverrides);
  const script = [
    `import cfg from ${JSON.stringify(webpackConfigUrl)};`,
    'console.log(JSON.stringify({',
    '  watch: cfg.watch,',
    '  entry: [].concat(cfg.entry.index).join(","),',
    '  pluginNames: cfg.plugins.map((plugin) => plugin.constructor.name),',
    '}));',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

test('HMR env is enabled only by an explicit truthy value', () => {
  assert.equal(isFrontHmrEnvEnabled('1'), true);
  assert.equal(isFrontHmrEnvEnabled('true'), true);
  assert.equal(isFrontHmrEnvEnabled(''), false);
  assert.equal(isFrontHmrEnvEnabled(undefined), false);
  assert.equal(isFrontHmrEnvEnabled('0'), false);
  assert.equal(isFrontHmrEnvEnabled('false'), false);
  assert.equal(isFrontHmrEnvEnabled('yes'), false);
});

test('the server process defaults to HMR off and needs CRETLI_FRONT_HMR=1', () => {
  assert.equal(resolveFrontHmrEnabled({ nodeEnv: 'development', envRaw: '' }), false);
  assert.equal(resolveFrontHmrEnabled({ nodeEnv: 'development', envRaw: '0' }), false);
  assert.equal(resolveFrontHmrEnabled({ nodeEnv: 'development', envRaw: '1' }), true);
  assert.equal(resolveFrontHmrEnabled({ nodeEnv: 'development', envRaw: 'true' }), true);
  assert.equal(resolveFrontHmrEnabled({ nodeEnv: 'production', envRaw: '1' }), false);
});

test('settings.frontHmrEnabled defaults to false but is honoured when set', () => {
  assert.equal(resolveFrontHmrEnabledFromSettings({}), false);
  assert.equal(resolveFrontHmrEnabledFromSettings(null), false);
  assert.equal(resolveFrontHmrEnabledFromSettings({ frontHmrEnabled: true }), true);
  assert.equal(resolveFrontHmrEnabledFromSettings({ frontHmrEnabled: false }), false);
});

test('webpack.dev.js stays in plain watch mode without the HMR env', () => {
  const flags = readWebpackDevFlags({});
  assert.equal(flags.watch, true);
  assert.equal(flags.entry, './App.js');
  assert.doesNotMatch(flags.entry, /webpack-hot-middleware/);
  assert.equal(flags.pluginNames.includes('HotModuleReplacementPlugin'), false);
});

test('webpack.dev.js switches to the hot client with CRETLI_FRONT_HMR=1', () => {
  const flags = readWebpackDevFlags({ CRETLI_FRONT_HMR: '1' });
  assert.equal(flags.watch, false);
  assert.match(flags.entry, /webpack-hot-middleware\/client/);
  assert.equal(flags.pluginNames.includes('HotModuleReplacementPlugin'), true);
});
