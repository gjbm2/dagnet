/**
 * Signature Links API (flexi-sigs)
 *
 * Frontend client for:
 * - /api/sigs/list
 * - /api/sigs/get
 * - /api/sigs/links/list
 * - /api/sigs/links/create
 * - /api/sigs/links/deactivate
 * - /api/sigs/resolve
 *
 * This file intentionally does not log to sessionLogService.
 * Callers should log with appropriate context.
 */

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const PYTHON_API_BASE =
  import.meta.env.DEV
    ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')
    : '';

const SIGS_ENABLED = import.meta.env.VITE_SNAPSHOTS_ENABLED !== 'false';

// -----------------------------------------------------------------------------
// Types (mirror backend handlers)
// -----------------------------------------------------------------------------

export interface SigRegistryRow {
  param_id: string;
  core_hash: string;
  created_at: string;
  canonical_signature: string;
  canonical_sig_hash_full: string;
  sig_algo: string;
  inputs_json?: any;
}

export interface ListSignaturesParams {
  param_id: string;
  limit?: number;
  include_inputs?: boolean;
}

export interface ListSignaturesResult {
  success: boolean;
  rows: SigRegistryRow[];
  count: number;
  error?: string;
}

export interface GetSignatureParams {
  param_id: string;
  core_hash: string;
}

export interface GetSignatureResult {
  success: boolean;
  row?: SigRegistryRow;
  error?: string;
}

export interface SigEquivalenceLinkRow {
  param_id: string;
  core_hash: string;
  equivalent_to: string;
  created_at: string;
  created_by?: string | null;
  reason?: string | null;
  active: boolean;
}

export interface ListEquivalenceLinksParams {
  param_id: string;
  core_hash?: string;
  include_inactive?: boolean;
  limit?: number;
}

export interface ListEquivalenceLinksResult {
  success: boolean;
  rows: SigEquivalenceLinkRow[];
  count: number;
  error?: string;
}

export interface CreateEquivalenceLinkParams {
  param_id: string;
  core_hash: string;
  equivalent_to: string;
  created_by: string;
  reason: string;
}

export interface CreateEquivalenceLinkResult {
  success: boolean;
  error?: string;
}

export interface DeactivateEquivalenceLinkParams {
  param_id: string;
  core_hash: string;
  equivalent_to: string;
  created_by: string;
  reason: string;
}

export interface DeactivateEquivalenceLinkResult {
  success: boolean;
  error?: string;
}

export interface ResolveEquivalentHashesParams {
  param_id: string;
  core_hash: string;
  include_equivalents?: boolean;
}

export interface ResolveEquivalentHashesResult {
  success: boolean;
  core_hashes: string[];
  count: number;
  error?: string;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

async function postJson<T>(path: string, body: any): Promise<T> {
  const response = await fetch(`${PYTHON_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Try to parse response body even on non-2xx (backend returns JSON errors).
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const err = parsed?.detail || parsed?.error || text || `HTTP ${response.status}`;
    throw new Error(String(err));
  }

  return (parsed as T) ?? ({} as T);
}

export async function listSignatures(params: ListSignaturesParams): Promise<ListSignaturesResult> {
  if (!SIGS_ENABLED) return { success: true, rows: [], count: 0 };
  try {
    return await postJson<ListSignaturesResult>('/api/sigs/list', {
      param_id: params.param_id,
      limit: params.limit,
      include_inputs: params.include_inputs ?? false,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] listSignatures failed:', errorMessage);
    return { success: false, rows: [], count: 0, error: errorMessage };
  }
}

export async function getSignature(params: GetSignatureParams): Promise<GetSignatureResult> {
  if (!SIGS_ENABLED) return { success: false, error: 'disabled' };
  try {
    return await postJson<GetSignatureResult>('/api/sigs/get', {
      param_id: params.param_id,
      core_hash: params.core_hash,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] getSignature failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

export async function listEquivalenceLinks(params: ListEquivalenceLinksParams): Promise<ListEquivalenceLinksResult> {
  if (!SIGS_ENABLED) return { success: true, rows: [], count: 0 };
  try {
    return await postJson<ListEquivalenceLinksResult>('/api/sigs/links/list', {
      param_id: params.param_id,
      core_hash: params.core_hash,
      include_inactive: params.include_inactive ?? false,
      limit: params.limit,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] listEquivalenceLinks failed:', errorMessage);
    return { success: false, rows: [], count: 0, error: errorMessage };
  }
}

export async function createEquivalenceLink(params: CreateEquivalenceLinkParams): Promise<CreateEquivalenceLinkResult> {
  if (!SIGS_ENABLED) return { success: false, error: 'disabled' };
  try {
    return await postJson<CreateEquivalenceLinkResult>('/api/sigs/links/create', {
      param_id: params.param_id,
      core_hash: params.core_hash,
      equivalent_to: params.equivalent_to,
      created_by: params.created_by,
      reason: params.reason,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] createEquivalenceLink failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

export async function deactivateEquivalenceLink(params: DeactivateEquivalenceLinkParams): Promise<DeactivateEquivalenceLinkResult> {
  if (!SIGS_ENABLED) return { success: false, error: 'disabled' };
  try {
    return await postJson<DeactivateEquivalenceLinkResult>('/api/sigs/links/deactivate', {
      param_id: params.param_id,
      core_hash: params.core_hash,
      equivalent_to: params.equivalent_to,
      created_by: params.created_by,
      reason: params.reason,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] deactivateEquivalenceLink failed:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

export async function resolveEquivalentHashes(params: ResolveEquivalentHashesParams): Promise<ResolveEquivalentHashesResult> {
  if (!SIGS_ENABLED) return { success: true, core_hashes: [params.core_hash], count: 1 };
  try {
    return await postJson<ResolveEquivalentHashesResult>('/api/sigs/resolve', {
      param_id: params.param_id,
      core_hash: params.core_hash,
      include_equivalents: params.include_equivalents ?? true,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SignatureLinks] resolveEquivalentHashes failed:', errorMessage);
    return { success: false, core_hashes: [params.core_hash], count: 1, error: errorMessage };
  }
}

