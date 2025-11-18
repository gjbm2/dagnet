import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { CredentialsData } from '../src/types/credentials';

/**
 * Init Credentials API
 *
 * Allows the client to bootstrap credentials from server-side environment
 * variables using a shared secret.
 *
 * Env vars:
 * - INIT_CREDENTIALS_SECRET: shared secret the user must supply
 * - INIT_CREDENTIALS_JSON: JSON string containing CredentialsData
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Basic CORS support (same as graph.ts)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const secret = body?.secret;

    if (!secret || typeof secret !== 'string') {
      return res.status(400).json({ error: 'Secret is required' });
    }

    const envSecret = process.env.INIT_CREDENTIALS_SECRET;
    if (!envSecret) {
      return res.status(500).json({ error: 'Server init secret not configured' });
    }

    if (secret !== envSecret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const credentialsJson = process.env.INIT_CREDENTIALS_JSON;
    if (!credentialsJson) {
      return res.status(500).json({ error: 'Server init credentials not configured' });
    }

    let credentials: CredentialsData;
    try {
      credentials = JSON.parse(credentialsJson);
    } catch (e) {
      return res.status(500).json({ error: 'Invalid INIT_CREDENTIALS_JSON format' });
    }

    return res.status(200).json({ credentials });
  } catch (error) {
    console.error('init-credentials: Unexpected error', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}


