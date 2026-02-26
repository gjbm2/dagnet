import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Auth Callback — GitHub App OAuth callback for user authorisation.
 *
 * GitHub redirects here (GET) with `code` and `state` after the user
 * authorises. This function exchanges the code for an access token
 * (server-side, so the client secret is never exposed to the browser),
 * fetches the GitHub username, and redirects back to the app with the
 * token and username as query parameters.
 *
 * Env vars (server-side only):
 * - VITE_GITHUB_OAUTH_CLIENT_ID: GitHub App client ID
 * - GITHUB_OAUTH_CLIENT_SECRET: GitHub App client secret
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  const clientId = process.env.VITE_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const appOrigin = `${proto}://${host}`;

  if (!code) {
    return res.redirect(302, `${appOrigin}/?auth_error=missing_code`);
  }

  if (!clientId || !clientSecret) {
    console.error('[auth-callback] Missing env vars: VITE_GITHUB_OAUTH_CLIENT_ID or GITHUB_OAUTH_CLIENT_SECRET');
    return res.redirect(302, `${appOrigin}/?auth_error=server_config`);
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
      console.error('[auth-callback] Token exchange failed:', tokenData.error || 'no access_token');
      return res.redirect(302, `${appOrigin}/?auth_error=token_exchange&detail=${encodeURIComponent(tokenData.error || 'unknown')}`);
    }

    const accessToken: string = tokenData.access_token;

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'DagNet-Auth',
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

    return res.redirect(302, `${appOrigin}/?${params.toString()}`);
  } catch (err) {
    console.error('[auth-callback] Unexpected error:', err);
    return res.redirect(302, `${appOrigin}/?auth_error=server_error`);
  }
}
