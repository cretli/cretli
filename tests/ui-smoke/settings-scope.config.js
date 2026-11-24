import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const artifacts = process.env.CRETLI_UI_SMOKE_DIR;
if (!artifacts || !path.isAbsolute(artifacts)) throw new Error('CRETLI_UI_SMOKE_DIR must be an isolated absolute directory');
const port = Number(process.env.CRETLI_UI_SMOKE_PORT || 34320);
function resolveChromiumExecutable() {
  try { if (existsSync(chromium.executablePath())) return undefined; } catch { /* Use the host Chromium fallback. */ }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((file) => existsSync(file));
}

export default defineConfig({
  testDir: '.',
  testMatch: 'settings-scope.spec.js',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: path.join(artifacts, 'results'),
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'off',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
    actionTimeout: 15_000,
    launchOptions: { executablePath: resolveChromiumExecutable(), args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  },
  webServer: {
    cwd: path.resolve(new URL('../..', import.meta.url).pathname),
    command: 'node --import ./lib/register-boot-env.js server.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      USE_HTTPS: '0', PORT: String(port), CRETLI_BIND: '127.0.0.1',
      CURSOR_API_KEY: 'ui-smoke-placeholder',
      HOME: path.join(artifacts, 'home'),
      WORKSPACES_SCAN_DIR: artifacts,
      CRETLI_DATA_DIR: path.join(artifacts, 'runtime'),
      CURSOR_REMOTE_DATA_DIR: path.join(artifacts, 'runtime'),
      CRETLI_TEST_DATA_DIR: path.join(artifacts, 'auth'),
      CURSOR_REMOTE_TEST_DATA_DIR: path.join(artifacts, 'auth'),
    },
  },
});
