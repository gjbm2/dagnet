/**
 * bayesService.ts — FE service for Bayes fit submission, polling, and crypto.
 *
 * Handles:
 *   1. Config fetch from /api/bayes/config (cached per session)
 *   2. AES-GCM encryption of git credentials into a callback token
 *   3. Submission to Modal /submit endpoint
 *   4. Status polling of Modal /status endpoint
 */

import { sessionLogService } from './sessionLogService';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BayesConfig {
  modal_submit_url: string;
  modal_status_url: string;
  webhook_url: string;
  webhook_secret: string;
  db_connection: string;
}

export interface BayesJobRecord {
  job_id: string;
  graph_id: string;
  submitted_at: number;
  status: 'submitted' | 'running' | 'vendor-complete' | 'committed' | 'failed';
  last_polled_at: number;
  result?: BayesStatusResult;
  error?: string;
}

interface BayesStatusResult {
  status: 'complete' | 'running' | 'failed';
  result?: {
    status: string;
    duration_ms: number;
    edges_fitted: number;
    edges_skipped: number;
    quality: { max_rhat: number; min_ess: number };
    warnings: string[];
    log: string[];
    webhook_response: { status: number; body?: unknown } | null;
    error: string | null;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Config cache
// ---------------------------------------------------------------------------

let _configCache: BayesConfig | null = null;

export async function fetchBayesConfig(): Promise<BayesConfig> {
  if (_configCache) return _configCache;

  const resp = await fetch('/api/bayes/config');
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`Failed to fetch Bayes config: ${resp.status} ${body.error || ''}`);
  }

  _configCache = await resp.json();
  return _configCache!;
}

/** Clear cached config (e.g. on logout or credential change). */
export function clearBayesConfigCache(): void {
  _configCache = null;
}

// ---------------------------------------------------------------------------
// AES-GCM callback token encryption
// ---------------------------------------------------------------------------

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
    ['encrypt'],
  );
}

interface CallbackTokenInput {
  owner: string;
  repo: string;
  token: string;
  branch: string;
  graph_id: string;
  graph_file_path: string;
}

/**
 * Encrypt the user's git credentials into an opaque callback token.
 * The token is AES-GCM encrypted using the webhook_secret as the key
 * (via PBKDF2 derivation). Only the Vercel webhook handler can decrypt it.
 */
export async function encryptCallbackToken(
  input: CallbackTokenInput,
  webhookSecret: string,
): Promise<string> {
  const payload = {
    ...input,
    issued_at: Date.now(),
    expires_at: Date.now() + 60 * 60 * 1000, // 60 minutes
  };

  const key = await deriveKey(webhookSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext,
  );

  // Prepend IV to ciphertext, base64-encode the whole thing
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

interface SubmitBayesFitInput {
  graph_id: string;
  repo: string;
  branch: string;
  graph_file_path: string;
  graph_snapshot: unknown;
  parameters_index: unknown;
  parameter_files: Record<string, unknown>;
  settings: Record<string, unknown>;
  /** Pre-built callback token (from encryptCallbackToken). */
  callback_token: string;
  /** Config values (from fetchBayesConfig). */
  db_connection: string;
  webhook_url: string;
}

/**
 * Submit a Bayes fit directly to Modal's /submit endpoint.
 * Returns the job_id for status polling.
 */
export async function submitBayesFit(input: SubmitBayesFitInput): Promise<string> {
  sessionLogService.info('bayes', 'BAYES_FIT_SUBMITTING', `Submitting fit for ${input.graph_id}`);

  const config = await fetchBayesConfig();
  const resp = await fetch(config.modal_submit_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Modal submit failed: ${resp.status} ${text}`);
  }

  const { job_id } = await resp.json();
  if (!job_id) throw new Error('Modal submit returned no job_id');

  sessionLogService.success('bayes', 'BAYES_FIT_SUBMITTED', `Submitted fit for ${input.graph_id}`, undefined, { job_id, graph_id: input.graph_id });

  return job_id;
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

/**
 * Poll Modal's /status endpoint for a single job.
 * Returns the enriched status response (includes full worker result on completion).
 */
export async function pollBayesStatus(jobId: string): Promise<BayesStatusResult> {
  const config = await fetchBayesConfig();
  const url = `${config.modal_status_url}?call_id=${encodeURIComponent(jobId)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`Status poll failed: ${resp.status}`);
  }

  return resp.json();
}

/**
 * Poll a job until it completes or fails. Calls onUpdate on each poll.
 * Returns the final status result.
 */
export async function pollUntilDone(
  jobId: string,
  onUpdate?: (status: BayesStatusResult) => void,
  intervalMs = 10_000,
  timeoutMs = 10 * 60 * 1000,
): Promise<BayesStatusResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await pollBayesStatus(jobId);
    onUpdate?.(status);

    if (status.status === 'complete' || status.status === 'failed') {
      return status;
    }

    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  return { status: 'failed', error: 'FE wall-clock timeout' };
}
