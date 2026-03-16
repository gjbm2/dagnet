/**
 * Bayes Webhook — Vite dev server middleware.
 *
 * Local dev equivalent of the Vercel serverless function `api/bayes-webhook.ts`.
 * Decrypts the callback token, reads the graph YAML from GitHub, adds a _bayes
 * metadata block, and commits the updated file back.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import yaml from 'js-yaml';

// ---------- helpers ----------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

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
  return JSON.parse(new TextDecoder().decode(decrypted));
}

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// ---------- handler ----------

export async function handleBayesWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  env: Record<string, string>,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bayes-callback');

  if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }
  if (req.method !== 'POST') { jsonResponse(res, 405, { error: 'Method not allowed' }); return; }

  const secret = env.BAYES_WEBHOOK_SECRET;
  if (!secret) { jsonResponse(res, 500, { error: 'BAYES_WEBHOOK_SECRET not configured' }); return; }

  // 1. Decrypt callback token
  const callbackHeader = req.headers['x-bayes-callback'];
  if (!callbackHeader || typeof callbackHeader !== 'string') {
    jsonResponse(res, 401, { error: 'Missing x-bayes-callback header' });
    return;
  }

  let tokenPayload: CallbackTokenPayload;
  try {
    tokenPayload = await decryptCallbackToken(callbackHeader, secret);
  } catch {
    jsonResponse(res, 401, { error: 'Failed to decrypt callback token' });
    return;
  }

  if (Date.now() > tokenPayload.expires_at) {
    jsonResponse(res, 401, { error: 'Callback token expired' });
    return;
  }

  // 2. Parse body
  let body: any;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  if (!body.job_id || !body.graph_id) {
    jsonResponse(res, 400, { error: 'Invalid webhook payload' });
    return;
  }

  const { owner, repo, token, branch, graph_file_path } = tokenPayload;
  const edgeCount = body.edges?.length ?? 0;

  console.log(
    `[bayes-webhook] graph=${tokenPayload.graph_id} ` +
    `repo=${owner}/${repo} branch=${branch} edges=${edgeCount}`,
  );

  // 3. Read graph file from GitHub
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
      console.error(`[bayes-webhook] GitHub read failed: ${fileResp.status}`, errText);
      jsonResponse(res, 502, {
        error: `Failed to read graph file from GitHub: ${fileResp.status}`,
        detail: errText,
      });
      return;
    }
    const fileData = await fileResp.json() as any;
    fileSha = fileData.sha;
    graphContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
  } catch (e: any) {
    console.error(`[bayes-webhook] GitHub read error:`, e);
    jsonResponse(res, 502, { error: `GitHub read failed: ${e.message}` });
    return;
  }

  // 4. Parse graph content (JSON or YAML), add _bayes metadata
  const isJson = graph_file_path.endsWith('.json');
  let graphDoc: any;
  try {
    graphDoc = isJson ? JSON.parse(graphContent) : yaml.load(graphContent);
  } catch (e: any) {
    jsonResponse(res, 422, { error: `Failed to parse graph file: ${e.message}` });
    return;
  }

  graphDoc._bayes = {
    fitted_at: body.fitted_at || new Date().toISOString(),
    job_id: body.job_id,
    fingerprint: body.fingerprint || null,
    edges_fitted: edgeCount,
    quality: body.quality || {},
    note: `Bayes posteriors computed for ${edgeCount} edges`,
  };

  // 5. Commit back to GitHub (preserve original format)
  const updatedContent = isJson
    ? JSON.stringify(graphDoc, null, 2) + '\n'
    : yaml.dump(graphDoc, { lineWidth: -1, noRefs: true, sortKeys: false });

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
        content: Buffer.from(updatedContent, 'utf-8').toString('base64'),
        branch,
        sha: fileSha,
      }),
    });

    if (!putResp.ok) {
      const errText = await putResp.text();
      console.error(`[bayes-webhook] GitHub commit failed: ${putResp.status}`, errText);
      jsonResponse(res, 502, {
        error: `GitHub commit failed: ${putResp.status}`,
        detail: errText,
      });
      return;
    }

    const putData = await putResp.json() as any;
    const commitSha = putData.commit?.sha ?? 'unknown';

    console.log(
      `[bayes-webhook] Committed ${graph_file_path} -> ${commitSha.slice(0, 8)}`,
    );

    jsonResponse(res, 200, {
      status: 'committed',
      graph_id: tokenPayload.graph_id,
      edges_received: edgeCount,
      commit_sha: commitSha,
    });
  } catch (e: any) {
    console.error(`[bayes-webhook] GitHub commit error:`, e);
    jsonResponse(res, 502, { error: `GitHub commit failed: ${e.message}` });
  }
}
