import { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * POST /api/bayes-webhook
 *
 * Receives posterior results from the Modal worker and commits them to git.
 *
 * Authentication: the worker sends an encrypted callback token in the
 * x-bayes-callback header. This handler decrypts it using BAYES_WEBHOOK_SECRET
 * (AES-GCM) to recover the user's git credentials, repo, branch, and graph
 * file path. No SHARE_JSON dependency.
 *
 * For the skeleton/spike phase: decrypts the token, validates it, and returns
 * success — but does NOT yet commit to git. Full git commit logic is added in
 * Step 5 (webhook hardening).
 */

export const maxDuration = 60;

// --- AES-GCM decryption (mirrors the FE encryption in bayesService.ts) ---

async function deriveKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      // Static salt is acceptable here — the secret itself is high-entropy
      salt: enc.encode('dagnet-bayes-callback-token'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

interface CallbackTokenPayload {
  owner: string;
  repo: string;
  token: string;
  branch: string;
  graph_id: string;
  graph_file_path: string;
  issued_at: number;
  expires_at: number;
}

async function decryptCallbackToken(
  encryptedB64: string,
  secret: string,
): Promise<CallbackTokenPayload> {
  const raw = Buffer.from(encryptedB64, 'base64');
  // First 12 bytes = IV, rest = ciphertext (AES-GCM)
  const iv = raw.subarray(0, 12);
  const ciphertext = raw.subarray(12);

  const key = await deriveKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json);
}

// --- Handler ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bayes-callback');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.BAYES_WEBHOOK_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'BAYES_WEBHOOK_SECRET not configured' });
  }

  // 1. Extract and decrypt callback token
  const callbackHeader = req.headers['x-bayes-callback'];
  if (!callbackHeader || typeof callbackHeader !== 'string') {
    return res.status(401).json({ error: 'Missing x-bayes-callback header' });
  }

  let tokenPayload: CallbackTokenPayload;
  try {
    tokenPayload = await decryptCallbackToken(callbackHeader, secret);
  } catch (e) {
    return res.status(401).json({ error: 'Failed to decrypt callback token' });
  }

  // 2. Check expiry
  if (Date.now() > tokenPayload.expires_at) {
    return res.status(401).json({ error: 'Callback token expired' });
  }

  // 3. Parse request body
  const body = req.body;
  if (!body || !body.job_id || !body.graph_id) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  // 4. Skeleton response — token is valid, we have git creds.
  //    Full git commit logic (read files, merge posteriors, cascade,
  //    atomic commit with retry-with-rebase) is added in Step 5.
  console.log(
    `[bayes-webhook] Valid callback for graph=${tokenPayload.graph_id} ` +
    `repo=${tokenPayload.owner}/${tokenPayload.repo} ` +
    `branch=${tokenPayload.branch} ` +
    `edges=${body.edges?.length ?? 0}`,
  );

  return res.status(200).json({
    status: 'received',
    message: 'Skeleton webhook — token decrypted, git commit not yet implemented',
    graph_id: tokenPayload.graph_id,
    edges_received: body.edges?.length ?? 0,
  });
}
