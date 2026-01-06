import type { CredentialsData, GitRepositoryCredential } from '../types/credentials';

export class CredentialsShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsShareLinkError';
  }
}

/**
 * Build the credentials payload for a share link.
 *
 * Requirements:
 * - git-only (no providers)
 * - preserve the selected git entry exactly, except force isDefault=true
 * - include only one git entry
 */
export function buildGitOnlyCredentialsForShare(
  allCredentials: CredentialsData,
  repoName: string
): CredentialsData {
  const git = Array.isArray(allCredentials?.git) ? allCredentials.git : [];
  const selected = git.find((g) => g?.name === repoName);
  if (!selected) {
    throw new CredentialsShareLinkError(`Git repo credential not found: ${repoName}`);
  }

  const selectedWithDefault: GitRepositoryCredential = {
    ...selected,
    isDefault: true,
  };

  return {
    ...(allCredentials?.version ? { version: allCredentials.version } : {}),
    git: [selectedWithDefault],
  };
}

export function encodeCredsParam(credentials: CredentialsData): string {
  // IMPORTANT: Do NOT pre-encode here.
  // URLSearchParams will encode exactly once. Pre-encoding causes double-encoding (%257B...)
  // which breaks CredentialsManager.loadFromURL JSON parsing.
  return JSON.stringify(credentials);
}

/**
 * Build a share URL rooted at the deployment base URL.
 *
 * baseUrl should be something like:
 * - https://dagnet-nine.vercel.app/
 */
export function buildCredsShareUrl(baseUrl: string, credentials: CredentialsData): string {
  if (!baseUrl) {
    throw new CredentialsShareLinkError('baseUrl is required');
  }

  const url = new URL(baseUrl);
  // Ensure we always land on app root (as requested).
  url.pathname = '/';
  url.search = '';
  url.hash = '';

  url.searchParams.set('creds', encodeCredsParam(credentials));
  // Suppress staleness/safety nudges for share links (read-only explore use case).
  // Presence is enough; value is informational.
  url.searchParams.set('nonudge', '1');
  return url.toString();
}


