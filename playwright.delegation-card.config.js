import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

const port = Number.parseInt(process.env.DELEGATION_CARD_E2E_PORT || '3397', 10);
const resolvedPort = Number.isFinite(port) ? port : 3397;
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
  testDir: './tests/delegation-card-e2e',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: baseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ignoreHTTPSErrors: true,
    viewport: { width: 1100, height: 800 },
    launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
  },
  outputDir: 'test-results/delegation-card-e2e',
  webServer: {
    command: `DELEGATION_CARD_E2E_PORT=${resolvedPort} node tests/delegation-card-e2e/server.mjs`,
    url: `${baseUrl}/health`,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
