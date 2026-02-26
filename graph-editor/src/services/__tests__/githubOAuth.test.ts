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
    const setUrl = (search: string) => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, search, href: `https://example.com${search}` },
        writable: true,
      });
    };

    it('should return true when ?oauth is present', () => {
      setUrl('?oauth');
      expect(isOAuthEnabled()).toBe(true);
    });

    it('should return true when ?oauth=1 is present', () => {
      setUrl('?oauth=1');
      expect(isOAuthEnabled()).toBe(true);
    });

    it('should return false when no oauth param', () => {
      setUrl('?other=1');
      expect(isOAuthEnabled()).toBe(false);
    });
  });
});
