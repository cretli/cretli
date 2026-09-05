/**
 * Environment for interactive PTY sessions (colors, isolated HOME).
 */

import path from 'path';

/**
 * @param {{ localRuntimeHome: string, overrides?: NodeJS.ProcessEnv }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function buildInteractivePtyEnv(options) {
  const localRuntimeHome = options.localRuntimeHome;
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    FORCE_COLOR: '1',
    ...(options.overrides || {}),
  };
  delete env.NO_COLOR;
  delete env.CI;
  delete env.CURSOR_HEADLESS;
  const homeDir = String(env.HOME || localRuntimeHome).trim() || localRuntimeHome;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  if (homeDir === localRuntimeHome || homeDir.startsWith(`${localRuntimeHome}/`)) {
    env.PM2_HOME = path.join(localRuntimeHome, `.pm2-uid-${uid}`);
  }
  return env;
}
