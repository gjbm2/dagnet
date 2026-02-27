/**
 * OAuth Auth Callback — Vite dev server middleware.
 *
 * Local dev equivalent of the Vercel serverless function `api/auth-callback.ts`.
 * Exchanges the GitHub OAuth code for an access token and redirects back
 * to the app with the token in query params.
 *
 * Reads VITE_GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET from
 * process.env (loaded from .env.local by Vite).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

let _clientId = '';
let _clientSecret = '';

/** Call from vite.config.ts to inject env vars loaded via loadEnv. */
export function configureAuthCallback(clientId: string, clientSecret: string): void {
  _clientId = clientId;
  _clientSecret = clientSecret;
}

export async function handleAuthCallback(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const reqUrl = new URL(req.url || '', `http://${req.headers.host}`);
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');

  const clientId = _clientId;
  const clientSecret = _clientSecret;

  const appOrigin = `http://${req.headers.host}`;

  if (!code) {
    res.writeHead(302, { Location: `${appOrigin}/?auth_error=missing_code` });
    res.end();
    return;
  }

  if (!clientId || !clientSecret) {
    console.error('[auth-callback dev] Missing env vars: VITE_GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET');
    res.writeHead(302, { Location: `${appOrigin}/?auth_error=server_config` });
    res.end();
    return;
  }

  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error || !tokenData.access_token) {
      console.error('[auth-callback dev] Token exchange failed:', tokenData.error || 'no access_token');
      const detail = encodeURIComponent(tokenData.error || 'unknown');
      res.writeHead(302, { Location: `${appOrigin}/?auth_error=token_exchange&detail=${detail}` });
      res.end();
      return;
    }

    const accessToken: string = tokenData.access_token;

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'DagNet-Auth-Dev',
      },
    });

    let githubUser = '';
    if (userResponse.ok) {
      const userData = await userResponse.json();
      githubUser = userData.login || '';
    }

    const params = new URLSearchParams();
    params.set('github_token', accessToken);
    if (githubUser) params.set('github_user', githubUser);
    if (state) params.set('state', state);

    res.writeHead(302, { Location: `${appOrigin}/?${params.toString()}` });
    res.end();
  } catch (err) {
    console.error('[auth-callback dev] Unexpected error:', err);
    res.writeHead(302, { Location: `${appOrigin}/?auth_error=server_error` });
    res.end();
  }
}
