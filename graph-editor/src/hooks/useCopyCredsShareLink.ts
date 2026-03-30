import { useCallback, useMemo } from 'react';
import type { CredentialsData } from '../types/credentials';
import { buildCredsShareUrl, buildGitOnlyCredentialsForShare } from '../services/credentialsShareLinkService';
import { copyToClipboard } from '../utils/copyToClipboard';

export function useCopyCredsShareLink(allCredentials: CredentialsData | null | undefined) {
  const baseUrl = useMemo(() => {
    // Rooted at current deployment origin (app root).
    // Example: https://dagnet-nine.vercel.app/
    return typeof window !== 'undefined' ? `${window.location.origin}/` : '';
  }, []);

  const buildUrlForRepo = useCallback(
    (repoName: string) => {
      if (!allCredentials) {
        throw new Error('No credentials loaded');
      }
      const payload = buildGitOnlyCredentialsForShare(allCredentials, repoName);
      return buildCredsShareUrl(baseUrl, payload);
    },
    [allCredentials, baseUrl]
  );

  const copyForRepo = useCallback(
    async (repoName: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> => {
      try {
        const url = buildUrlForRepo(repoName);

        await copyToClipboard(url);
        return { ok: true, url };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    [buildUrlForRepo]
  );

  return { copyForRepo, buildUrlForRepo, baseUrl };
}


