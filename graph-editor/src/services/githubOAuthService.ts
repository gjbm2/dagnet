/**
 * GitHub OAuth Service — client-side OAuth flow for GitHub App user authorisation.
 *
 * Handles initiating the OAuth redirect, processing the return,
 * and persisting the token into the credentials file in IndexedDB.
 */

import { db } from '../db/appDatabase';
import { credentialsManager } from '../lib/credentials';

const OAUTH_STATE_KEY = 'dagnet_oauth_state';
const OAUTH_REPO_KEY = 'dagnet_oauth_repo';

/**
 * Start the GitHub OAuth flow.
 * Generates a CSRF state token, records the target repo, and redirects to GitHub.
 *
 * @param repoName - The git credential entry name (from credentials.git[].name)
 *                   to associate the resulting token with.
 */
export function startOAuthFlow(repoName: string): void {
  const clientId = import.meta.env.VITE_GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    console.error('[githubOAuth] VITE_GITHUB_OAUTH_CLIENT_ID is not set');
    return;
  }

  const state = crypto.randomUUID();
  sessionStorage.setItem(OAUTH_STATE_KEY, state);
  sessionStorage.setItem(OAUTH_REPO_KEY, repoName);

  const callbackUrl = `${window.location.origin}/api/auth-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    state,
  });

  window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export interface OAuthReturnData {
  token: string;
  username: string;
  repoName: string;
}

/**
 * Check if the current page load is a return from the OAuth callback.
 * If so, validate the state, extract the token and username, clean the URL,
 * and return the data. Returns null if this is not an OAuth return.
 */
export function consumeOAuthReturn(): OAuthReturnData | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('github_token');
  const username = params.get('github_user');
  const state = params.get('state');
  const authError = params.get('auth_error');

  if (authError) {
    const detail = params.get('detail') || '';
    console.error(`[githubOAuth] Auth error: ${authError}${detail ? ` (${detail})` : ''}`);
    cleanOAuthParams();
    return null;
  }

  if (!token) return null;

  const savedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  if (!state || state !== savedState) {
    console.error('[githubOAuth] State mismatch — possible CSRF. Ignoring token.');
    cleanOAuthParams();
    return null;
  }

  const repoName = sessionStorage.getItem(OAUTH_REPO_KEY) || '';

  sessionStorage.removeItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(OAUTH_REPO_KEY);

  cleanOAuthParams();

  return {
    token,
    username: username || '',
    repoName,
  };
}

/**
 * Check if the GitHub OAuth feature is enabled (via env var or URL flag).
 */
export function isOAuthEnabled(): boolean {
  if (import.meta.env.VITE_FEATURE_OAUTH === '1') return true;
  if (typeof window !== 'undefined') {
    return new URLSearchParams(window.location.search).has('oauth');
  }
  return false;
}

/**
 * Persist an OAuth token into the credentials file in IndexedDB.
 * Updates only the git entry matching `repoName`; other entries are untouched.
 *
 * @returns true if the token was written, false if it couldn't be (missing file, no matching entry).
 */
export async function applyOAuthToken(data: OAuthReturnData): Promise<boolean> {
  const { token, username, repoName } = data;
  if (!token || !repoName) return false;

  const credentialsFileId = 'credentials-credentials';
  const credentialsFile = await db.files.get(credentialsFileId);

  if (!credentialsFile?.data?.git) {
    console.error('[githubOAuth] No credentials file found in IDB');
    return false;
  }

  const gitEntry = credentialsFile.data.git.find(
    (cred: any) => cred.name === repoName
  );

  if (!gitEntry) {
    console.error(`[githubOAuth] No git entry found for repo: ${repoName}`);
    return false;
  }

  gitEntry.token = token;
  if (username) gitEntry.userName = username;

  await db.files.put(credentialsFile);
  credentialsManager.clearCache();

  return true;
}

function cleanOAuthParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('github_token');
  url.searchParams.delete('github_user');
  url.searchParams.delete('state');
  url.searchParams.delete('auth_error');
  url.searchParams.delete('detail');
  window.history.replaceState({}, '', url.toString());
}
