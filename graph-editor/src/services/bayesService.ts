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

// Environment-aware base URL — same pattern as graphComputeClient
const API_BASE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')
  : '';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BayesConfig {
  modal_submit_url: string;
  modal_status_url: string;
  modal_cancel_url?: string;
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

export interface BayesProgress {
  stage: string;
  pct: number;
  detail?: string;
}

interface BayesStatusResult {
  status: 'complete' | 'running' | 'failed' | 'cancelled';
  progress?: BayesProgress;
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

  const resp = await fetch(`${API_BASE_URL}/api/bayes/config`);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`Failed to fetch Bayes config: ${resp.status} ${body.error || body.detail || ''}`);
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
 * Submit a Bayes fit to the submit endpoint (Modal or local dev server).
 * Pass submitUrl to override the config value (used by local dev mode).
 * Returns the job_id for status polling.
 */
export async function submitBayesFit(
  input: SubmitBayesFitInput,
  submitUrl?: string,
): Promise<string> {
  sessionLogService.info('bayes', 'BAYES_FIT_SUBMITTING', `Submitting fit for ${input.graph_id}`);

  const config = await fetchBayesConfig();
  const resp = await fetch(submitUrl || config.modal_submit_url, {
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
 * Poll the status endpoint for a single job (Modal or local dev server).
 * Pass statusUrl to override the config value (used by local dev mode).
 */
export async function pollBayesStatus(jobId: string, statusUrl?: string): Promise<BayesStatusResult> {
  const config = await fetchBayesConfig();
  const baseUrl = statusUrl || config.modal_status_url;
  const url = `${baseUrl}?call_id=${encodeURIComponent(jobId)}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error(`Status poll failed: ${resp.status}`);
  }

  return resp.json();
}

/**
 * Poll a job until it completes, fails, or is cancelled. Calls onUpdate on each poll.
 * Pass an AbortSignal to stop polling early (e.g. when the user cancels).
 * Returns the final status result.
 */
export async function pollUntilDone(
  jobId: string,
  onUpdate?: (status: BayesStatusResult) => void,
  intervalMs = 10_000,
  timeoutMs = 10 * 60 * 1000,
  statusUrl?: string,
  signal?: AbortSignal,
): Promise<BayesStatusResult> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      return { status: 'cancelled', error: 'Cancelled by user' };
    }

    const status = await pollBayesStatus(jobId, statusUrl);
    onUpdate?.(status);

    if (status.status === 'complete' || status.status === 'failed' || status.status === 'cancelled') {
      return status;
    }

    // Wait for interval, but break early if aborted
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  return { status: 'failed', error: 'FE wall-clock timeout' };
}


// ---------------------------------------------------------------------------
// Job cancellation
// ---------------------------------------------------------------------------

/**
 * Cancel a running Bayes job. For Modal jobs, hits Modal's cancel endpoint
 * which terminates the container (via FunctionCall.cancel). For local jobs,
 * marks the job as cancelled in the in-memory store.
 *
 * Pass cancelUrl to override (used by local dev mode).
 * Falls back to modal_cancel_url from config, then local dev server.
 */
export async function cancelBayesJob(jobId: string, cancelUrl?: string): Promise<void> {
  let url = cancelUrl;
  if (!url) {
    const config = await fetchBayesConfig();
    url = config.modal_cancel_url || 'http://localhost:9000/api/bayes/cancel';
  }
  const fullUrl = `${url}?call_id=${encodeURIComponent(jobId)}`;

  const resp = await fetch(fullUrl, { method: 'POST' });

  if (!resp.ok) {
    throw new Error(`Cancel request failed: ${resp.status}`);
  }

  const result = await resp.json();
  sessionLogService.info('bayes', 'BAYES_CANCEL', `Cancelled job ${jobId}: ${result.status}`, undefined, { jobId });
}
