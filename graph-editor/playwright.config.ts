import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E (real browser) for share-live persistence correctness.
 *
 * IMPORTANT:
 * - We do NOT test GitHub. Network boundaries are intercepted in tests.
 * - We rely on real browser IndexedDB/localStorage to validate persistence.
 */
export default defineConfig({
  testDir: './e2e',
  // These flows are intentionally heavyweight (real browser + IndexedDB + app boot).
  // Use a conservative timeout to avoid flakiness on loaded machines/CI.
  timeout: 120_000,
  expect: { timeout: 30_000 },
  // Run single-worker by default to reduce CPU contention and timing flake in real-browser mode.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:e2e',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    env: {
      // CredentialsManager: validate ?secret= against this value and provide credentials JSON.
      VITE_CREDENTIALS_SECRET: 'test-secret',
      VITE_CREDENTIALS_JSON: JSON.stringify({
        defaultGitRepo: 'repo-1',
        git: [
          {
            name: 'repo-1',
            owner: 'owner-1',
            repo: 'repo-1',
            token: 'test-token',
            branch: 'main',
            basePath: '',
          },
          {
            name: 'repo-2',
            owner: 'owner-1',
            repo: 'repo-2',
            token: 'test-token',
            branch: 'main',
            basePath: '',
          },
        ],
      }),
      // GraphComputeClient: point to a dummy origin; tests intercept the HTTP calls.
      VITE_PYTHON_API_URL: 'http://127.0.0.1:9000',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});

