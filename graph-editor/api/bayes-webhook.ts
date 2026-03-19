import { VercelRequest, VercelResponse } from '@vercel/node';
import { atomicCommitFiles, CommitFile } from './_lib/git-commit';
/**
 * POST /api/bayes-webhook
 *
 * Receives posterior results from the Modal worker and writes a **patch file**
 * to git. The FE applies the patch into its local files on next pull.
 *
 * The webhook does NOT read or modify graph or parameter files. It commits
 * a single `_bayes/patch-{job_id}.json` file containing the raw posterior
 * data. This avoids merge conflicts with local FE state (canvas charts,
 * dirty edits, etc.) — see doc 4 § "Return path re-architecture".
 *
 * Authentication: encrypted callback token in x-bayes-callback header.
 *
 * Flow:
 *   1. Decrypt callback token → git credentials
 *   2. Validate webhook payload
 *   3. Write patch file to git (single file commit)
 *   4. Return 200
 */

export const maxDuration = 60;

// --- Webhook payload types (from worker) ---

interface EdgePosterior {
  param_id: string;
  file_path: string;
  probability?: {
    alpha: number;
    beta: number;
    mean: number;
    stdev: number;
    hdi_lower: number;
    hdi_upper: number;
    hdi_level: number;
    ess: number;
    rhat: number | null;
    provenance: string;
  };
  latency?: {
    mu_mean: number;
    mu_sd: number;
    sigma_mean: number;
    sigma_sd: number;
    hdi_t95_lower: number;
    hdi_t95_upper: number;
    hdi_level: number;
    ess: number;
    rhat: number | null;
    provenance: string;
  };
}

interface WebhookPayload {
  job_id: string;
  graph_id: string;
  fingerprint: string;
  fitted_at: string;
  quality: {
    max_rhat: number;
    min_ess: number;
    converged_pct: number;
  };
  edges: EdgePosterior[];
  skipped?: Array<{ param_id: string; reason: string }>;
}

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

  if (Date.now() > tokenPayload.expires_at) {
    return res.status(401).json({ error: 'Callback token expired' });
  }

  // 2. Parse and validate webhook payload
  const body = req.body as WebhookPayload;
  if (!body || !body.job_id || !body.graph_id || !Array.isArray(body.edges)) {
    return res.status(400).json({ error: 'Invalid webhook payload: missing job_id, graph_id, or edges' });
  }

  const { owner, repo, token, branch, graph_file_path } = tokenPayload;
  const fittedAt = body.fitted_at || new Date().toISOString();
  const fingerprint = body.fingerprint || 'unknown';

  console.log(
    `[bayes-webhook] graph=${body.graph_id} repo=${owner}/${repo} ` +
    `branch=${branch} edges=${body.edges.length} skipped=${body.skipped?.length ?? 0}`,
  );

  // 3. Write patch file to git
  //
  // The patch file contains the raw posterior data from the worker.
  // The FE reads this on pull, applies upserts into local parameter
  // and graph files (where it has full local context), and commits
  // the result through the normal dirty-file flow.
  try {
    const patchData = {
      job_id: body.job_id,
      graph_id: body.graph_id,
      graph_file_path,
      fitted_at: fittedAt,
      fingerprint,
      model_version: 1,
      quality: {
        max_rhat: body.quality?.max_rhat ?? null,
        min_ess: body.quality?.min_ess ?? null,
        converged_pct: body.quality?.converged_pct ?? 0,
      },
      edges: body.edges,
      skipped: body.skipped ?? [],
    };

    const patchPath = `_bayes/patch-${body.job_id}.json`;
    const patchContent = JSON.stringify(patchData, null, 2) + '\n';

    const commitMessage =
      `[bayes] Patch: ${body.edges.length} edges for ${body.graph_id}\n\n` +
      `fingerprint: ${fingerprint}\n` +
      `job_id: ${body.job_id}\n` +
      `quality: r-hat ${body.quality?.max_rhat ?? '?'}, min ESS ${body.quality?.min_ess ?? '?'}`;

    const result = await atomicCommitFiles(
      owner, repo, branch, token,
      [{ path: patchPath, content: patchContent }],
      commitMessage,
    );

    console.log(
      `[bayes-webhook] Patch written: ${patchPath} → ${result.sha.slice(0, 8)}`,
    );

    return res.status(200).json({
      status: 'patch_committed',
      graph_id: body.graph_id,
      job_id: body.job_id,
      patch_path: patchPath,
      edges_count: body.edges.length,
      commit_sha: result.sha,
      commit_url: result.url,
    });

  } catch (e: any) {
    console.error(`[bayes-webhook] Failed: ${e.message}`);
    return res.status(502).json({
      error: e.message,
      job_id: body.job_id,
    });
  }
}
