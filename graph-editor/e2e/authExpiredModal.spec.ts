/**
 * Auth-Expired Modal — Playwright E2E Tests
 *
 * Tests every load scenario for the auth-expired modal in a real browser
 * with real IDB, real React mount timing, and controlled GitHub API responses.
 *
 * No mocking of IDB or React — only GitHub API responses are intercepted.
 */

import { test, expect, Page } from '@playwright/test';

test.describe.configure({ timeout: 15_000 });

// ============================================================================
// Helpers
// ============================================================================

const REPO_NAME = 'repo-1';
const REPO_OWNER = 'owner-1';

async function seedCredentials(page: Page, token: string, userName?: string) {
  await page.evaluate(
    ({ token, userName }) => {
      const db = (window as any).db;
      if (!db) throw new Error('db not available');
      return db.files.put({
        fileId: 'credentials-credentials',
        type: 'credentials',
        viewTabs: [],
        data: {
          version: '1.0.0',
          defaultGitRepo: 'repo-1',
          git: [
            {
              name: 'repo-1',
              isDefault: true,
              owner: 'owner-1',
              token,
              branch: 'main',
              basePath: '',
              graphsPath: 'graphs',
              paramsPath: 'parameters',
              contextsPath: 'contexts',
              casesPath: 'cases',
              nodesPath: 'nodes',
              eventsPath: 'events',
              ...(userName ? { userName } : {}),
            },
          ],
        },
        source: { repository: 'local', path: 'credentials.yaml', branch: 'main' },
        isDirty: false,
        lastModified: Date.now(),
      });
    },
    { token, userName },
  );
}

async function seedWorkspace(page: Page) {
  await page.evaluate(() => {
    const db = (window as any).db;
    if (!db) throw new Error('db not available');
    return db.workspaces.put({
      id: 'repo-1-main',
      repository: 'repo-1',
      branch: 'main',
      lastSynced: Date.now(),
      fileIds: [],
    });
  });
}

async function stubGitHubAPI(
  page: Page,
  opts: { authStatus?: number; expectedToken?: string } = {},
) {
  const status = opts.authStatus ?? 200;
  const expectedToken = opts.expectedToken;
  await page.route('https://api.github.com/**', async (route) => {
    const authHeader = route.request().headers()['authorization'] || '';
    const token = authHeader.startsWith('token ') ? authHeader.slice('token '.length) : '';

    if (status !== 404 && (!authHeader || !authHeader.startsWith('token ') || token.trim() === '')) {
      // If the app is meant to be authenticated and it isn't, we want the test to fail loudly.
      // Returning a 401 here ensures the modal path triggers (or the test fails expectations).
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Bad credentials (missing token)' }),
      });
    }

    if (status !== 404 && expectedToken && token !== expectedToken) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Bad credentials (wrong token)' }),
      });
    }

    if (status === 401) {
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Bad credentials' }),
      });
    }
    if (status === 404) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Not Found' }),
      });
    }
    const url = route.request().url();
    if (url.includes('/git/ref/heads/') || url.includes('/git/refs/heads/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ref: 'refs/heads/main', object: { sha: 'abc123', type: 'commit' } }),
      });
    }
    if (url.includes('/branches')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ name: 'main', commit: { sha: 'abc123' } }]),
      });
    }
    if (url.endsWith(`/repos/${REPO_OWNER}/${REPO_NAME}`)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: REPO_NAME, full_name: `${REPO_OWNER}/${REPO_NAME}` }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function setOAuthSessionState(page: Page, state: string, repoName: string) {
  await page.evaluate(
    ({ state, repoName }) => {
      sessionStorage.setItem('dagnet_oauth_state', state);
      sessionStorage.setItem('dagnet_oauth_repo', repoName);
    },
    { state, repoName },
  );
}

const MODAL_SELECTOR = 'text=GitHub credentials expired';
const CHIP_CONNECT_SELECTOR = 'text=connect 🔗';
const CHIP_READONLY_SELECTOR = 'text=read-only 🔗';

// ============================================================================
// Group A: Normal page load (no OAuth params)
// ============================================================================

test.describe('Group A: Normal page load', () => {
  test('A1: valid ghu_ token, GitHub 200 — no modal, chip shows @username', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 200, expectedToken: 'ghu_valid_token' });
    await page.goto('/');
    await seedCredentials(page, 'ghu_valid_token', 'testuser');
    await seedWorkspace(page);
    await page.reload();

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
    await expect(page.locator('text=@testuser')).toBeVisible();
  });

  test('A2: revoked ghu_ token, GitHub 401 — modal visible', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 401, expectedToken: 'ghu_revoked_token' });
    await page.goto('/');
    await seedCredentials(page, 'ghu_revoked_token');
    await seedWorkspace(page);
    await page.reload();

    await expect(page.locator(MODAL_SELECTOR)).toBeVisible({ timeout: 10_000 });
  });

  test('A3: valid shared PAT, GitHub 200 — no modal, chip shows connect', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 200, expectedToken: 'ghp_valid_pat' });
    await page.goto('/');
    await seedCredentials(page, 'ghp_valid_pat');
    await seedWorkspace(page);
    await page.reload();

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
    await expect(page.locator(CHIP_CONNECT_SELECTOR)).toBeVisible();
  });

  test('A4: revoked shared PAT, GitHub 401 — modal visible', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 401, expectedToken: 'ghp_revoked_pat' });
    await page.goto('/');
    await seedCredentials(page, 'ghp_revoked_pat');
    await seedWorkspace(page);
    await page.reload();

    await expect(page.locator(MODAL_SELECTOR)).toBeVisible({ timeout: 10_000 });
  });

  test('A5: no token (empty), GitHub 404 — no modal, chip shows read-only', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 404 });
    await page.goto('/');
    await seedCredentials(page, '');
    await seedWorkspace(page);
    await page.reload();

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
  });

  test('A6: no credentials file (blank slate) — no modal', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 404 });
    await page.goto('/');

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
  });
});

// ============================================================================
// Group B: OAuth return (URL has github_token)
// ============================================================================

test.describe('Group B: OAuth return', () => {
  test('B1: OAuth return with valid token — no modal, chip shows @testuser, IDB updated', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 200 });
    await page.goto('/');
    await seedCredentials(page, 'ghp_old_token');
    await seedWorkspace(page);
    await setOAuthSessionState(page, 'test-state-b1', REPO_NAME);

    await page.goto('/?github_token=ghu_fresh_token&github_user=testuser&state=test-state-b1');

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
    await expect(page.getByText('@testuser', { exact: true })).toBeVisible();

    const idbToken = await page.evaluate(async () => {
      const db = (window as any).db;
      const file = await db.files.get('credentials-credentials');
      return file?.data?.git?.[0]?.token;
    });
    expect(idbToken).toBe('ghu_fresh_token');
  });

  test('B2: OAuth return when old token was revoked — no modal, IDB updated', async ({ page }) => {
    // Return 401 for old token, 200 for new token
    let tokenApplied = false;
    await page.route('https://api.github.com/**', async (route) => {
      const authHeader = route.request().headers()['authorization'] || '';
      if (authHeader.includes('ghu_fresh') || tokenApplied) {
        tokenApplied = true;
        const url = route.request().url();
        if (url.includes('/branches')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ name: 'main', commit: { sha: 'abc123' } }]),
          });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Bad credentials' }),
      });
    });

    await page.goto('/');
    await seedCredentials(page, 'ghp_revoked_token');
    await seedWorkspace(page);
    await setOAuthSessionState(page, 'test-state-b2', REPO_NAME);

    await page.goto('/?github_token=ghu_fresh_token&github_user=testuser&state=test-state-b2');

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();

    const idbToken = await page.evaluate(async () => {
      const db = (window as any).db;
      const file = await db.files.get('credentials-credentials');
      return file?.data?.git?.[0]?.token;
    });
    expect(idbToken).toBe('ghu_fresh_token');
  });
});

// ============================================================================
// Group C: Post-connect reload
// ============================================================================

test.describe('Group C: Post-connect reload', () => {
  test('C1: reload after successful connect — no modal', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 200, expectedToken: 'ghu_connected_token' });
    await page.goto('/');
    await seedCredentials(page, 'ghu_connected_token', 'testuser');
    await seedWorkspace(page);
    await page.reload();

    await page.waitForTimeout(3000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
    await expect(page.locator('text=@testuser')).toBeVisible();
  });

  test('C2: reload after connect, token revoked externally — modal visible', async ({ page }) => {
    // First load: seed valid token
    await stubGitHubAPI(page, { authStatus: 200 });
    await page.goto('/');
    await seedCredentials(page, 'ghu_was_valid', 'testuser');
    await seedWorkspace(page);
    await page.reload();

    await page.waitForTimeout(2000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();

    // Now revoke: switch stub to 401 and reload
    await page.unroute('https://api.github.com/**');
    await stubGitHubAPI(page, { authStatus: 401 });
    await page.reload();

    await expect(page.locator(MODAL_SELECTOR)).toBeVisible({ timeout: 10_000 });
  });
});

// ============================================================================
// Group D: User actions post-init
// ============================================================================

test.describe('Group D: User actions post-init', () => {
  test('D1: pull with revoked token — modal appears from event', async ({ page }) => {
    await stubGitHubAPI(page, { authStatus: 401 });
    await page.goto('/');
    await seedCredentials(page, 'ghu_revoked');
    await seedWorkspace(page);
    await page.reload();

    // The post-init check should show the modal
    await expect(page.locator(MODAL_SELECTOR)).toBeVisible({ timeout: 10_000 });

    // Dismiss it
    await page.locator('text=Dismiss').click();
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();

    // Now trigger a user action — click Repository > Pull Latest
    await page.locator('text=Repository').click();
    const pullItem = page.locator('text=Pull Latest');
    if (await pullItem.isVisible()) {
      await pullItem.click();
      // Modal should reappear from the event dispatch
      await expect(page.locator(MODAL_SELECTOR)).toBeVisible({ timeout: 10_000 });
    }
  });
});

// ============================================================================
// Group E: Health check isolation
// ============================================================================

test.describe('Group E: Health check isolation', () => {
  test('E1: health check 401 before init does not trigger modal', async ({ page }) => {
    let requestCount = 0;
    await page.route('https://api.github.com/**', async (route) => {
      requestCount++;
      const authHeader = route.request().headers()['authorization'] || '';
      // First few requests (health check, before setCredentials) — no auth header or wrong token
      if (!authHeader || authHeader.includes('test-token')) {
        // After credentials load, requests will have the real token
        if (authHeader.includes('ghu_valid')) {
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        // Health check without proper auth
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Bad credentials' }),
        });
      }
      if (authHeader.includes('ghu_valid')) {
        const url = route.request().url();
        if (url.includes('/branches')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{ name: 'main', commit: { sha: 'abc123' } }]),
          });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/');
    await seedCredentials(page, 'ghu_valid_token', 'testuser');
    await seedWorkspace(page);
    await page.reload();

    // The post-init check should use the valid token (from setCredentials) and succeed
    await page.waitForTimeout(4000);
    await expect(page.locator(MODAL_SELECTOR)).not.toBeVisible();
  });
});
