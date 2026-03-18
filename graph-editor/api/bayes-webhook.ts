import { VercelRequest, VercelResponse } from '@vercel/node';
import yaml from 'js-yaml';
import { atomicCommitFiles, CommitFile } from './_lib/git-commit';
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
 *   2. Read graph file + parameter files from GitHub
 *   3. Update parameter files with posterior data
 *   4. Update graph _bayes metadata block
 *   5. Atomic commit all changed files via Git Data API
 *
 * See: docs/current/project-bayes/4-async-roundtrip-infrastructure.md §3B
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
    converged: boolean;
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

// --- GitHub helpers ---

async function ghFetch<T = any>(
  url: string,
  token: string,
  options?: { method?: string; body?: any },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'dagnet-bayes-webhook',
  };
  if (options?.body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GitHub ${resp.status}: ${errText}`);
  }
  return resp.json() as Promise<T>;
}

/** Read a file from GitHub Contents API. Returns parsed content + sha. */
async function readGitHubFile(
  owner: string, repo: string, path: string, branch: string, token: string,
): Promise<{ content: string; sha: string }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
  const data = await ghFetch<{ content: string; sha: string }>(url, token);
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

// --- Parameter file update logic ---

/**
 * Merge posterior data into a parameter file's YAML structure.
 *
 * Updates:
 *   - values[0].mean, values[0].stdev (from probability posterior)
 *   - latency.model_trained_at (timestamp only — does NOT overwrite
 *     latency.mu/latency.sigma, which remain as analytic LAG pass values)
 *   - posterior sub-object on the parameter root (probability)
 *   - latency.posterior sub-object (latency)
 */
/** Default retention settings for fit_history. */
const FIT_HISTORY_MAX_ENTRIES = 20;

function mergePosteriorsIntoParam(
  paramDoc: any,
  edge: EdgePosterior,
  fittedAt: string,
  fingerprint: string,
): void {
  if (edge.probability) {
    const prob = edge.probability;

    // Update current values
    if (paramDoc.values && paramDoc.values.length > 0) {
      paramDoc.values[0].mean = prob.mean;
      paramDoc.values[0].stdev = prob.stdev;
    }

    // Append to fit_history BEFORE overwriting posterior (so we capture
    // the previous run's snapshot, not the current one being written).
    // The first run has no previous posterior, so fit_history starts empty
    // and grows from the second run onward.
    const existingPosterior = paramDoc.posterior;
    if (existingPosterior?.alpha != null && existingPosterior?.beta != null) {
      if (!Array.isArray(paramDoc.posterior.fit_history)) {
        paramDoc.posterior.fit_history = [];
      }
      paramDoc.posterior.fit_history.push({
        fitted_at: existingPosterior.fitted_at ?? fittedAt,
        alpha: existingPosterior.alpha,
        beta: existingPosterior.beta,
        hdi_lower: existingPosterior.hdi_lower ?? 0,
        hdi_upper: existingPosterior.hdi_upper ?? 1,
        rhat: existingPosterior.rhat ?? 0,
        divergences: existingPosterior.divergences ?? 0,
      });
      // Retention: keep only the most recent entries
      if (paramDoc.posterior.fit_history.length > FIT_HISTORY_MAX_ENTRIES) {
        paramDoc.posterior.fit_history = paramDoc.posterior.fit_history.slice(
          -FIT_HISTORY_MAX_ENTRIES,
        );
      }
    }

    // Carry forward the accumulated fit_history into the new posterior
    const fitHistory = paramDoc.posterior?.fit_history ?? [];

    // Set posterior sub-object (overwrites previous, fit_history carried forward)
    paramDoc.posterior = {
      distribution: 'beta',
      alpha: prob.alpha,
      beta: prob.beta,
      hdi_lower: prob.hdi_lower,
      hdi_upper: prob.hdi_upper,
      hdi_level: prob.hdi_level,
      ess: prob.ess,
      rhat: prob.rhat,
      evidence_grade: prob.ess >= 400 && (prob.rhat === null || prob.rhat < 1.05) ? 3 : 0,
      fitted_at: fittedAt,
      fingerprint,
      provenance: prob.provenance,
      ...(fitHistory.length > 0 ? { fit_history: fitHistory } : {}),
    };
  }

  if (edge.latency) {
    const lat = edge.latency;

    // Ensure latency section exists
    if (!paramDoc.latency) paramDoc.latency = {};

    // Append to latency fit_history (same pattern as probability)
    const existingLatPosterior = paramDoc.latency.posterior;
    if (existingLatPosterior?.mu_mean != null) {
      if (!Array.isArray(paramDoc.latency.posterior.fit_history)) {
        paramDoc.latency.posterior.fit_history = [];
      }
      paramDoc.latency.posterior.fit_history.push({
        fitted_at: existingLatPosterior.fitted_at ?? fittedAt,
        mu_mean: existingLatPosterior.mu_mean,
        sigma_mean: existingLatPosterior.sigma_mean,
        onset_delta_days: existingLatPosterior.onset_delta_days ?? 0,
        rhat: existingLatPosterior.rhat ?? 0,
        divergences: existingLatPosterior.divergences ?? 0,
      });
      if (paramDoc.latency.posterior.fit_history.length > FIT_HISTORY_MAX_ENTRIES) {
        paramDoc.latency.posterior.fit_history = paramDoc.latency.posterior.fit_history.slice(
          -FIT_HISTORY_MAX_ENTRIES,
        );
      }
    }

    const latFitHistory = paramDoc.latency.posterior?.fit_history ?? [];

    // NOTE: Do NOT overwrite latency.mu/latency.sigma — those are the analytic
    // (pre-Bayes) model params from the LAG pass. Bayesian values live exclusively
    // in latency.posterior so both are inspectable side by side.
    paramDoc.latency.model_trained_at = fittedAt;

    // Set latency posterior sub-object
    paramDoc.latency.posterior = {
      distribution: 'lognormal',
      onset_delta_days: paramDoc.latency.onset_delta_days ?? 0,
      mu_mean: lat.mu_mean,
      mu_sd: lat.mu_sd,
      sigma_mean: lat.sigma_mean,
      sigma_sd: lat.sigma_sd,
      hdi_t95_lower: lat.hdi_t95_lower,
      hdi_t95_upper: lat.hdi_t95_upper,
      hdi_level: lat.hdi_level,
      ess: lat.ess,
      rhat: lat.rhat,
      fitted_at: fittedAt,
      fingerprint,
      provenance: lat.provenance,
      ...(latFitHistory.length > 0 ? { fit_history: latFitHistory } : {}),
    };
  }
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

  // 3. Read all files from GitHub (graph + each parameter file)
  try {
    // Read graph file
    const graphFile = await readGitHubFile(owner, repo, graph_file_path, branch, token);
    const isJson = graph_file_path.endsWith('.json');
    let graphDoc: any;
    try {
      graphDoc = isJson ? JSON.parse(graphFile.content) : yaml.load(graphFile.content);
    } catch (e: any) {
      return res.status(422).json({ error: `Failed to parse graph: ${e.message}`, job_id: body.job_id });
    }

    // Read and update each parameter file
    const updatedFiles: CommitFile[] = [];

    const edgeDiag: Array<{ param_id: string; file_path: string; status: string; detail?: string }> = [];
    for (const edge of body.edges) {
      if (!edge.file_path) {
        edgeDiag.push({ param_id: edge.param_id, file_path: '', status: 'skipped', detail: 'no file_path' });
        continue;
      }

      let paramFile;
      try {
        paramFile = await readGitHubFile(owner, repo, edge.file_path, branch, token);
      } catch (e: any) {
        edgeDiag.push({ param_id: edge.param_id, file_path: edge.file_path, status: 'read_failed', detail: e.message });
        continue;
      }

      let paramDoc: any;
      try {
        paramDoc = yaml.load(paramFile.content);
      } catch (e: any) {
        edgeDiag.push({ param_id: edge.param_id, file_path: edge.file_path, status: 'parse_failed', detail: e.message });
        continue;
      }

      mergePosteriorsIntoParam(paramDoc, edge, fittedAt, fingerprint);

      const updatedYaml = yaml.dump(paramDoc, { lineWidth: -1, noRefs: true, sortKeys: false });
      updatedFiles.push({ path: edge.file_path, content: updatedYaml });
      edgeDiag.push({ param_id: edge.param_id, file_path: edge.file_path, status: 'ok', detail: `posterior=${!!paramDoc.posterior}` });
    }

    // 4. Update graph _bayes metadata
    graphDoc._bayes = {
      fitted_at: fittedAt,
      duration_ms: body.quality ? undefined : undefined, // filled by worker if available
      fingerprint,
      model_version: 1,
      settings_signature: '', // filled when settings are passed through
      quality: {
        max_rhat: body.quality?.max_rhat ?? null,
        min_ess: body.quality?.min_ess ?? null,
        converged: body.quality?.converged ?? false,
      },
    };

    // 5. Serialise graph
    const updatedGraphContent = isJson
      ? JSON.stringify(graphDoc, null, 2) + '\n'
      : yaml.dump(graphDoc, { lineWidth: -1, noRefs: true, sortKeys: false });

    updatedFiles.push({ path: graph_file_path, content: updatedGraphContent });

    // 6. Commit all files atomically
    const skippedSummary = body.skipped?.length
      ? `\nSkipped: ${body.skipped.map(s => `${s.param_id} (${s.reason})`).join(', ')}`
      : '';

    const commitMessage =
      `[bayes] Fitted ${body.edges.length} edges for ${body.graph_id}\n\n` +
      `fingerprint: ${fingerprint}\n` +
      `job_id: ${body.job_id}\n` +
      `edges: ${body.edges.length}\n` +
      `quality: r-hat ${body.quality?.max_rhat ?? '?'}, min ESS ${body.quality?.min_ess ?? '?'}` +
      skippedSummary;

    const result = await atomicCommitFiles(owner, repo, branch, token, updatedFiles, commitMessage);

    console.log(
      `[bayes-webhook] Committed ${updatedFiles.length} files → ${result.sha.slice(0, 8)}`,
    );

    return res.status(200).json({
      status: 'committed',
      graph_id: body.graph_id,
      job_id: body.job_id,
      edges_received: body.edges.length,
      files_committed: updatedFiles.length,
      files_committed_paths: updatedFiles.map(f => f.path),
      edge_diagnostics: edgeDiag,
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
