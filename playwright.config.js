import path from 'node:path';
import { defineConfig } from '@playwright/test';

const defaultPort = Number.parseInt(process.env.CHAT_E2E_PORT || '3311', 10);
const resolvedPort = Number.isFinite(defaultPort) ? defaultPort : 3311;
const baseUrl = process.env.CHAT_E2E_BASE_URL || `http://127.0.0.1:${resolvedPort}`;
const isMobileViewport = process.env.CHAT_E2E_MOBILE === '1';
const e2eAuthDir = process.env.CHAT_E2E_AUTH_DIR || path.resolve('.tmp/e2e-auth');
const e2eHomeDir = process.env.CHAT_E2E_HOME_DIR || path.resolve('.tmp/e2e-home');
const chromiumExecutablePath = process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || undefined;
const enableVideo = process.env.CHAT_E2E_VIDEO === '1';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 240_000,
  expect: {
    timeout: 30_000,
  },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: enableVideo ? 'retain-on-failure' : 'off',
    ignoreHTTPSErrors: true,
    viewport: isMobileViewport ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    launchOptions: chromiumExecutablePath
      ? {
          executablePath: chromiumExecutablePath,
        }
      : undefined,
  },
  outputDir: 'test-results/playwright',
  webServer: {
    command: `HOME="${e2eHomeDir}" CURSOR_RIPGREP_PATH=./node_modules/.bin/rg USE_HTTPS=0 PORT=${resolvedPort} CURSOR_REMOTE_TEST_DATA_DIR="${e2eAuthDir}" bash ./scripts/start-server-node22.sh`,
    url: `${baseUrl}/api/health`,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
