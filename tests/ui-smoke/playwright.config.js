import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, defineConfig } from '@playwright/test';

const artifacts = process.env.CRETLI_UI_SMOKE_DIR;
if (!artifacts || !path.isAbsolute(artifacts)) throw new Error('CRETLI_UI_SMOKE_DIR must be an isolated absolute directory');
const port = Number(process.env.CRETLI_UI_SMOKE_PORT || 34319);

/**
 * The env override, else Playwright's own browser when it is downloaded, else a
 * system Chromium: hosts without `npx playwright install` used to fail the gate
 * with "Executable doesn't exist" although /usr/bin/chromium was there.
 *
 * @returns {string | undefined}
 */
function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // No bundled browser registered for this Playwright version.
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    .find((file) => existsSync(file));
}

export default defineConfig({
  testDir: '.',
  testMatch: 'frontend.spec.js',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: path.join(artifacts, 'results'),
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
    actionTimeout: 15_000,
    launchOptions: {
      executablePath: resolveChromiumExecutable(),
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    command: 'node --import ./lib/register-boot-env.js server.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      USE_HTTPS: '0', PORT: String(port), CRETLI_BIND: '127.0.0.1',
      // Creating a dormant SDK chat checks presence only; the smoke sends no prompt.
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
