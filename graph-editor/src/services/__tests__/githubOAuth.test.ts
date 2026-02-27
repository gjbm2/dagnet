/**
 * GitHub OAuth Service — Integration Tests
 *
 * Tests the OAuth flow logic and IDB persistence.
 * Uses real fake-indexeddb (configured in vitest setup) to verify tokens
 * are actually persisted, not just modified in memory.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../db/appDatabase';
import { credentialsManager } from '../../lib/credentials';
import {
  consumeOAuthReturn,
  applyOAuthToken,
  isOAuthEnabled,
  type OAuthReturnData,
} from '../githubOAuthService';
import { GitAuthError, rethrowIfAuthError, dispatchGitAuthExpired, gitService } from '../gitService';

// Seed a credentials file with two git entries into IDB
async function seedCredentials(repos: Array<{ name: string; owner: string; token: string; userName?: string }>) {
  await db.files.put({
    fileId: 'credentials-credentials',
    type: 'credentials' as any,
    viewTabs: [],
    data: {
      version: '1.0.0',
      git: repos.map(r => ({ ...r })),
    },
    isDirty: false,
    source: { repository: 'local', path: 'credentials.yaml', branch: 'main' },
    lastModified: Date.now(),
  });
}

// Read credentials back from IDB (not from any cache)
async function readCredentialsFromIDB() {
  return db.files.get('credentials-credentials');
}

describe('GitHub OAuth Service', () => {
  beforeEach(async () => {
    await db.files.clear();
    await db.credentials.clear();
    credentialsManager.clearCache();
    sessionStorage.clear();
  });

  // =========================================================================
  // applyOAuthToken — IDB persistence
  // =========================================================================

  describe('applyOAuthToken', () => {
    it('should persist token to the correct git entry in IDB', async () => {
      await seedCredentials([
        { name: 'repo-alpha', owner: 'org1', token: 'ghp_shared_alpha' },
        { name: 'repo-beta', owner: 'org2', token: 'ghp_shared_beta' },
      ]);

      const result = await applyOAuthToken({
        token: 'ghu_personal_token',
        username: 'alice',
        repoName: 'repo-alpha',
      });

      expect(result).toBe(true);

      const record = await readCredentialsFromIDB();
      const alpha = record!.data.git.find((g: any) => g.name === 'repo-alpha');
      const beta = record!.data.git.find((g: any) => g.name === 'repo-beta');

      expect(alpha.token).toBe('ghu_personal_token');
      expect(alpha.userName).toBe('alice');
      expect(beta.token).toBe('ghp_shared_beta');
    });

    it('should not modify other git entries', async () => {
      await seedCredentials([
        { name: 'repo-a', owner: 'org', token: 'ghp_a', userName: 'shared-user' },
        { name: 'repo-b', owner: 'org', token: 'ghp_b', userName: 'shared-user' },
      ]);

      await applyOAuthToken({
        token: 'ghu_new',
        username: 'bob',
        repoName: 'repo-b',
      });

      const record = await readCredentialsFromIDB();
      const repoA = record!.data.git.find((g: any) => g.name === 'repo-a');

      expect(repoA.token).toBe('ghp_a');
      expect(repoA.userName).toBe('shared-user');
    });

    it('should return false when no credentials file exists in IDB', async () => {
      const result = await applyOAuthToken({
        token: 'ghu_token',
        username: 'alice',
        repoName: 'nonexistent',
      });

      expect(result).toBe(false);
    });

    it('should return false when repo name does not match any git entry', async () => {
      await seedCredentials([
        { name: 'repo-alpha', owner: 'org', token: 'ghp_shared' },
      ]);

      const result = await applyOAuthToken({
        token: 'ghu_token',
        username: 'alice',
        repoName: 'repo-nonexistent',
      });

      expect(result).toBe(false);

      const record = await readCredentialsFromIDB();
      expect(record!.data.git[0].token).toBe('ghp_shared');
    });

    it('should return false when token is empty', async () => {
      await seedCredentials([
        { name: 'repo-alpha', owner: 'org', token: 'ghp_shared' },
      ]);

      const result = await applyOAuthToken({
        token: '',
        username: 'alice',
        repoName: 'repo-alpha',
      });

      expect(result).toBe(false);

      const record = await readCredentialsFromIDB();
      expect(record!.data.git[0].token).toBe('ghp_shared');
    });

    it('should return false when repoName is empty', async () => {
      await seedCredentials([
        { name: 'repo-alpha', owner: 'org', token: 'ghp_shared' },
      ]);

      const result = await applyOAuthToken({
        token: 'ghu_token',
        username: 'alice',
        repoName: '',
      });

      expect(result).toBe(false);

      const record = await readCredentialsFromIDB();
      expect(record!.data.git[0].token).toBe('ghp_shared');
    });

    it('should clear credentialsManager cache after writing', async () => {
      await seedCredentials([
        { name: 'repo-alpha', owner: 'org', token: 'ghp_shared' },
      ]);

      // Prime the cache
      await credentialsManager.loadCredentials();
      const before = credentialsManager.getDefaultGitCredentials();
      expect(before?.token).toBe('ghp_shared');

      await applyOAuthToken({
        token: 'ghu_new_token',
        username: 'alice',
        repoName: 'repo-alpha',
      });

      // Cache was cleared, next load should pick up new token from IDB
      const result = await credentialsManager.loadCredentials();
      const after = result.credentials?.git?.find((g: any) => g.name === 'repo-alpha');
      expect(after?.token).toBe('ghu_new_token');
    });
  });

  // =========================================================================
  // consumeOAuthReturn — URL parsing + state validation
  // =========================================================================

  describe('consumeOAuthReturn', () => {
    const setUrl = (search: string) => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search, href: `https://example.com${search}` },
        writable: true,
      });
    };

    beforeEach(() => {
      vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    });

    it('should return token data when state matches', () => {
      sessionStorage.setItem('dagnet_oauth_state', 'abc123');
      sessionStorage.setItem('dagnet_oauth_repo', 'my-repo');
      setUrl('?github_token=ghu_tok&github_user=alice&state=abc123');

      const result = consumeOAuthReturn();

      expect(result).toEqual({
        token: 'ghu_tok',
        username: 'alice',
        repoName: 'my-repo',
      });
    });

    it('should return null and clean URL on state mismatch', () => {
      sessionStorage.setItem('dagnet_oauth_state', 'correct_state');
      sessionStorage.setItem('dagnet_oauth_repo', 'my-repo');
      setUrl('?github_token=ghu_tok&github_user=alice&state=wrong_state');

      const result = consumeOAuthReturn();

      expect(result).toBeNull();
      expect(window.history.replaceState).toHaveBeenCalled();
    });

    it('should return null on auth error', () => {
      setUrl('?auth_error=token_exchange&detail=bad_verification_code');

      const result = consumeOAuthReturn();

      expect(result).toBeNull();
      expect(window.history.replaceState).toHaveBeenCalled();
    });

    it('should return null when no OAuth params are present (normal page load)', () => {
      setUrl('?oauth');

      const result = consumeOAuthReturn();

      expect(result).toBeNull();
      expect(window.history.replaceState).not.toHaveBeenCalled();
    });

    it('should clear sessionStorage after successful consumption', () => {
      sessionStorage.setItem('dagnet_oauth_state', 'state1');
      sessionStorage.setItem('dagnet_oauth_repo', 'repo1');
      setUrl('?github_token=ghu_tok&state=state1');

      consumeOAuthReturn();

      expect(sessionStorage.getItem('dagnet_oauth_state')).toBeNull();
      expect(sessionStorage.getItem('dagnet_oauth_repo')).toBeNull();
    });

    it('should return empty repoName when repo key is missing from sessionStorage', () => {
      sessionStorage.setItem('dagnet_oauth_state', 'state1');
      setUrl('?github_token=ghu_tok&state=state1');

      const result = consumeOAuthReturn();

      expect(result).toEqual({
        token: 'ghu_tok',
        username: '',
        repoName: '',
      });
    });
  });

  // =========================================================================
  // isOAuthEnabled — feature flag detection
  // =========================================================================

  describe('isOAuthEnabled', () => {
    it('should return true when VITE_GITHUB_OAUTH_CLIENT_ID is set', () => {
      vi.stubEnv('VITE_GITHUB_OAUTH_CLIENT_ID', 'Iv23_test_id');
      expect(isOAuthEnabled()).toBe(true);
      vi.unstubAllEnvs();
    });

    it('should return false when VITE_GITHUB_OAUTH_CLIENT_ID is not set', () => {
      vi.stubEnv('VITE_GITHUB_OAUTH_CLIENT_ID', '');
      expect(isOAuthEnabled()).toBe(false);
      vi.unstubAllEnvs();
    });
  });

  // =========================================================================
  // GitAuthError + rethrowIfAuthError + dispatchGitAuthExpired
  // =========================================================================

  describe('GitAuthError', () => {
    it('should have name GitAuthError', () => {
      const err = new GitAuthError('test');
      expect(err.name).toBe('GitAuthError');
      expect(err.message).toBe('test');
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe('rethrowIfAuthError', () => {
    it('should re-throw GitAuthError as-is', () => {
      const err = new GitAuthError('expired');
      expect(() => rethrowIfAuthError(err)).toThrow(GitAuthError);
    });

    it('should throw GitAuthError when error has status 401', () => {
      const err = { status: 401, message: 'Bad credentials' };
      expect(() => rethrowIfAuthError(err)).toThrow(GitAuthError);
    });

    it('should throw GitAuthError when error message contains 401 + Bad credentials', () => {
      const err = new Error('Git API Error: 401 Unauthorized - {"message":"Bad credentials"}');
      expect(() => rethrowIfAuthError(err)).toThrow(GitAuthError);
    });

    it('should not throw for non-401 errors', () => {
      const err = new Error('Git API Error: 404 Not Found');
      expect(() => rethrowIfAuthError(err)).not.toThrow();
    });

    it('should not throw for errors with status 403', () => {
      const err = { status: 403, message: 'Forbidden' };
      expect(() => rethrowIfAuthError(err)).not.toThrow();
    });
  });

  describe('dispatchGitAuthExpired', () => {
    it('should fire dagnet:gitAuthExpired event on window', () => {
      const handler = vi.fn();
      window.addEventListener('dagnet:gitAuthExpired', handler);

      dispatchGitAuthExpired();

      expect(handler).toHaveBeenCalledTimes(1);
      window.removeEventListener('dagnet:gitAuthExpired', handler);
    });
  });

  // =========================================================================
  // Group 3: gitService boundary (credentialsManager -> gitService)
  // This is where the production defect lives.
  // =========================================================================

  describe('gitService token propagation', () => {
    const TEST_CREDS_OLD = {
      version: '1.0.0' as const,
      git: [{ name: 'test-repo', owner: 'test-org', token: 'ghp_old_shared_token' }],
    };

    beforeEach(async () => {
      await seedCredentials(TEST_CREDS_OLD.git);
    });

    async function initGitServiceFromIDB() {
      const result = await credentialsManager.loadCredentials();
      if (result.credentials) gitService.setCredentials(result.credentials);
      return result;
    }

    it('should NOT update gitService token from applyOAuthToken alone (documenting the gap)', async () => {
      await initGitServiceFromIDB();
      expect((gitService as any).currentRepo?.token).toBe('ghp_old_shared_token');

      await applyOAuthToken({ token: 'ghu_new_personal', username: 'alice', repoName: 'test-repo' });

      // gitService still has the old token — applyOAuthToken only writes to IDB
      expect((gitService as any).currentRepo?.token).toBe('ghp_old_shared_token');
    });

    it('should update gitService token after applyOAuthToken + credential reload + setCredentials', async () => {
      await initGitServiceFromIDB();
      expect((gitService as any).currentRepo?.token).toBe('ghp_old_shared_token');

      await applyOAuthToken({ token: 'ghu_new_personal', username: 'alice', repoName: 'test-repo' });

      // Simulate what the app must do after applyOAuthToken: reload from IDB and push to gitService
      const reloaded = await credentialsManager.loadCredentials();
      if (reloaded.credentials) gitService.setCredentials(reloaded.credentials);

      expect((gitService as any).currentRepo?.token).toBe('ghu_new_personal');
      expect((gitService as any).currentRepo?.userName).toBe('alice');
    });

    it('should send the new token in Authorization header after credential reload', async () => {
      await initGitServiceFromIDB();

      await applyOAuthToken({ token: 'ghu_new_personal', username: 'alice', repoName: 'test-repo' });

      const reloaded = await credentialsManager.loadCredentials();
      if (reloaded.credentials) gitService.setCredentials(reloaded.credentials);

      // Mock fetch to capture the Authorization header
      const capturedHeaders: Record<string, string> = {};
      const mockFetch = vi.fn().mockImplementation(async (url: string, opts: any) => {
        if (opts?.headers) {
          for (const [k, v] of Object.entries(opts.headers)) {
            capturedHeaders[k] = v as string;
          }
        }
        return new Response(JSON.stringify({ name: 'test-repo' }), { status: 200 });
      });
      vi.stubGlobal('fetch', mockFetch);

      try {
        await gitService.getRepoInfo();
        expect(capturedHeaders['Authorization']).toBe('token ghu_new_personal');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should propagate token through full init -> OAuth -> reload lifecycle', async () => {
      // Step 1: Simulate app init — load old token
      await initGitServiceFromIDB();
      expect((gitService as any).currentRepo?.token).toBe('ghp_old_shared_token');

      // Step 2: Simulate OAuth return — write new token to IDB
      await applyOAuthToken({ token: 'ghu_lifecycle_token', username: 'bob', repoName: 'test-repo' });

      // Step 3: Simulate credential reload (what the app does after OAuth)
      const reloaded = await credentialsManager.loadCredentials();
      if (reloaded.credentials) gitService.setCredentials(reloaded.credentials);

      // Step 4: Verify the full chain
      expect((gitService as any).currentRepo?.token).toBe('ghu_lifecycle_token');
      expect((gitService as any).currentRepo?.userName).toBe('bob');

      // Step 5: Verify the token is actually used in API calls
      const capturedHeaders: Record<string, string> = {};
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, opts: any) => {
        if (opts?.headers) {
          for (const [k, v] of Object.entries(opts.headers)) {
            capturedHeaders[k] = v as string;
          }
        }
        return new Response(JSON.stringify({ name: 'test-repo' }), { status: 200 });
      }));

      try {
        await gitService.getRepoInfo();
        expect(capturedHeaders['Authorization']).toBe('token ghu_lifecycle_token');
      } finally {
        vi.unstubAllGlobals();
      }

      // Step 6: Verify IDB has the correct token (persistence check)
      const idbRecord = await readCredentialsFromIDB();
      expect(idbRecord!.data.git[0].token).toBe('ghu_lifecycle_token');
    });
  });

  // =========================================================================
  // Group 4a: 401 error propagation via makeRequest
  // =========================================================================

  describe('401 error propagation', () => {
    beforeEach(async () => {
      await seedCredentials([{ name: 'test-repo', owner: 'test-org', token: 'ghp_test' }]);
      const result = await credentialsManager.loadCredentials();
      if (result.credentials) gitService.setCredentials(result.credentials);
    });

    it('should throw GitAuthError when GitHub API returns 401', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('{"message":"Bad credentials"}', {
          status: 401,
          statusText: 'Unauthorized',
        })
      ));

      try {
        await gitService.getRepoInfo();
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GitAuthError);
        expect((error as Error).message).toContain('401');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should NOT throw GitAuthError for 403 responses', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
        new Response('{"message":"Forbidden"}', { status: 403, statusText: 'Forbidden' })
      ));

      try {
        const result = await gitService.getRepoInfo();
        // Should not throw, should return error result
        expect(result.success).toBe(false);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // =========================================================================
  // Group 5b: Caller pattern dispatches event on GitAuthError
  // =========================================================================

  describe('caller pattern for GitAuthError dispatch', () => {
    it('should dispatch gitAuthExpired when catching GitAuthError by name', () => {
      const handler = vi.fn();
      window.addEventListener('dagnet:gitAuthExpired', handler);

      try {
        // Simulate the pattern used in usePullAll / NavigatorContext / CommitModal
        try {
          throw new GitAuthError('credentials expired');
        } catch (error) {
          if ((error as any)?.name === 'GitAuthError') {
            dispatchGitAuthExpired();
          }
        }

        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('dagnet:gitAuthExpired', handler);
      }
    });

    it('should NOT dispatch for non-auth errors', () => {
      const handler = vi.fn();
      window.addEventListener('dagnet:gitAuthExpired', handler);

      try {
        try {
          throw new Error('Network error');
        } catch (error) {
          if ((error as any)?.name === 'GitAuthError') {
            dispatchGitAuthExpired();
          }
        }

        expect(handler).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('dagnet:gitAuthExpired', handler);
      }
    });
  });

  // =========================================================================
  // Group 8c + 8d: Multi-repo and re-connect edge cases
  // =========================================================================

  describe('multi-repo and re-connect edge cases', () => {
    it('should handle consecutive OAuth connects for different repos', async () => {
      await seedCredentials([
        { name: 'repo-x', owner: 'org', token: 'ghp_x' },
        { name: 'repo-y', owner: 'org', token: 'ghp_y' },
      ]);

      await applyOAuthToken({ token: 'ghu_alice', username: 'alice', repoName: 'repo-x' });
      await applyOAuthToken({ token: 'ghu_bob', username: 'bob', repoName: 'repo-y' });

      const record = await readCredentialsFromIDB();
      const repoX = record!.data.git.find((g: any) => g.name === 'repo-x');
      const repoY = record!.data.git.find((g: any) => g.name === 'repo-y');

      expect(repoX.token).toBe('ghu_alice');
      expect(repoX.userName).toBe('alice');
      expect(repoY.token).toBe('ghu_bob');
      expect(repoY.userName).toBe('bob');
    });

    it('should overwrite previous OAuth token on re-connect to same repo', async () => {
      await seedCredentials([
        { name: 'repo-z', owner: 'org', token: 'ghp_z' },
      ]);

      await applyOAuthToken({ token: 'ghu_first', username: 'alice', repoName: 'repo-z' });
      await applyOAuthToken({ token: 'ghu_second', username: 'alice-v2', repoName: 'repo-z' });

      const record = await readCredentialsFromIDB();
      expect(record!.data.git[0].token).toBe('ghu_second');
      expect(record!.data.git[0].userName).toBe('alice-v2');
    });
  });
});
