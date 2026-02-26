import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Auth Status — env var health-check for OAuth configuration.
 * Returns which OAuth env vars are present (not their values).
 * Used to verify Vercel env var wiring without touching the OAuth flow.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const clientId = process.env.VITE_GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  return res.status(200).json({
    VITE_GITHUB_OAUTH_CLIENT_ID: clientId ? 'set' : 'not set',
    GITHUB_OAUTH_CLIENT_SECRET: clientSecret ? 'set' : 'not set',
  });
}
