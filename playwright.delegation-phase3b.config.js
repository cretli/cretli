import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const port = Number.parseInt(process.env.DELEGATION_PHASE3B_E2E_PORT || '3399', 10);
const resolvedPort = Number.isFinite(port) ? port : 3399;
const baseUrl = `http://127.0.0.1:${resolvedPort}`;

function resolveChromiumExecutable() {
  const fromEnv = String(process.env.CHAT_E2E_CHROMIUM_EXECUTABLE_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  return candidates.find((file) => fs.existsSync(file));
}

const chromiumExecutablePath = resolveChromiumExecutable();

export default defineConfig({
  testDir: './tests/delegation-phase3b-ui-e2e',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    viewport: { width: 1100, height: 800 },
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
  },
  outputDir: 'test-results/delegation-phase3b-ui-e2e',
  webServer: {
    command: `DELEGATION_PHASE3B_E2E_PORT=${resolvedPort} node tests/delegation-phase3b-ui-e2e/start-server.mjs`,
    url: `${baseUrl}/dist/app/index.bundle.js`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
