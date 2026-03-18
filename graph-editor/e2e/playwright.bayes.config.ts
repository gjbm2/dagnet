/**
 * Playwright config for Bayes roundtrip test.
 *
 * Uses the REAL dev server on :5173 (not the test server with fake credentials).
 * Prerequisites: npm run dev must be running separately.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'bayesPosteriorFullRoundtrip.spec.ts',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // No webServer — reuse the dev server the user started with real credentials
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
