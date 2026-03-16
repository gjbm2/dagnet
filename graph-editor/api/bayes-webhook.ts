import { VercelRequest, VercelResponse } from '@vercel/node';
import yaml from 'js-yaml';

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
 * Flow:
 *   1. Decrypt callback token → git credentials
 *   2. Read graph YAML from GitHub (Contents API)
 *   3. Add/update _bayes metadata block
 *   4. Commit updated file back to GitHub
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

  const { owner, repo, token, branch, graph_file_path } = tokenPayload;
  const edgeCount = body.edges?.length ?? 0;

  console.log(
    `[bayes-webhook] graph=${tokenPayload.graph_id} ` +
    `repo=${owner}/${repo} branch=${branch} edges=${edgeCount}`,
  );

  // 4. Read current graph file from GitHub
  const ghHeaders = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'dagnet-bayes-webhook',
  };

  let fileSha: string;
  let graphContent: string;
  try {
    const fileUrl =
      `https://api.github.com/repos/${owner}/${repo}/contents/${graph_file_path}?ref=${branch}`;
    const fileResp = await fetch(fileUrl, { headers: ghHeaders });
    if (!fileResp.ok) {
      const errText = await fileResp.text();
      return res.status(502).json({
        error: `Failed to read graph file from GitHub: ${fileResp.status}`,
        detail: errText,
      });
    }
    const fileData = await fileResp.json();
    fileSha = fileData.sha;
    graphContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
  } catch (e: any) {
    return res.status(502).json({ error: `GitHub read failed: ${e.message}` });
  }

  // 5. Parse YAML, add _bayes metadata
  let graphDoc: any;
  try {
    graphDoc = yaml.load(graphContent);
  } catch (e: any) {
    return res.status(422).json({ error: `Failed to parse graph YAML: ${e.message}` });
  }

  graphDoc._bayes = {
    fitted_at: body.fitted_at || new Date().toISOString(),
    job_id: body.job_id,
    fingerprint: body.fingerprint || null,
    edges_fitted: edgeCount,
    quality: body.quality || {},
    note: `Bayes posteriors computed for ${edgeCount} edges`,
  };

  // 6. Commit updated file back to GitHub
  const updatedYaml = yaml.dump(graphDoc, {
    lineWidth: -1,       // no line wrapping
    noRefs: true,        // no YAML anchors/aliases
    sortKeys: false,     // preserve key order
  });

  const commitMessage =
    `[bayes] Update posteriors for ${tokenPayload.graph_id}\n\n` +
    `Job: ${body.job_id}\n` +
    `Edges fitted: ${edgeCount}\n` +
    `Fitted at: ${graphDoc._bayes.fitted_at}`;

  try {
    const putUrl =
      `https://api.github.com/repos/${owner}/${repo}/contents/${graph_file_path}`;
    const putResp = await fetch(putUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(updatedYaml, 'utf-8').toString('base64'),
        branch,
        sha: fileSha,
      }),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      return res.status(502).json({
        error: `GitHub commit failed: ${putResp.status}`,
        detail: errText,
      });
    }

    const putData = await putResp.json();
    const commitSha = putData.commit?.sha ?? 'unknown';

    console.log(
      `[bayes-webhook] Committed ${graph_file_path} → ${commitSha.slice(0, 8)}`,
    );

    return res.status(200).json({
      status: 'committed',
      graph_id: tokenPayload.graph_id,
      edges_received: edgeCount,
      commit_sha: commitSha,
    });
  } catch (e: any) {
    return res.status(502).json({ error: `GitHub commit failed: ${e.message}` });
  }
}
