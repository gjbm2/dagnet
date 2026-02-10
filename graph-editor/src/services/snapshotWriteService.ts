/**
 * Snapshot Write Service
 * 
 * Handles shadow-writing snapshot data to the database after successful fetches.
 * This is the frontend client for the /api/snapshots/append endpoint.
 * 
 * NOTE: This service does NOT log to sessionLogService directly.
 * Callers are responsible for logging with appropriate context (e.g., as child of parent operation).
 * This follows the codebase pattern where low-level services don't log, callers do.
 * 
 * Design reference: docs/current/project-db/snapshot-db-design.md
 * Hash architecture: docs/current/project-db/hash-fixes.md
 */

import { computeShortCoreHash } from './coreHashService';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SnapshotRow {
  /** Anchor day in ISO date format (YYYY-MM-DD) */
  anchor_day: string;
  /** Anchor entrants (cohort mode only) */
  A?: number;
  /** From-step count (n) */
  X?: number;
  /** To-step count / conversions (k) */
  Y?: number;
  /** Median conversion lag in days */
  median_lag_days?: number;
  /** Mean conversion lag in days */
  mean_lag_days?: number;
  /** Anchor-relative median lag in days */
  anchor_median_lag_days?: number;
  /** Anchor-relative mean lag in days */
  anchor_mean_lag_days?: number;
  /** Onset delay before conversions begin (from histogram) */
  onset_delta_days?: number;
}

export interface AppendSnapshotsParams {
  /** Workspace-prefixed parameter ID (e.g., 'repo-branch-param-id') */
  param_id: string;
  /**
   * Canonical semantic signature string (frontend `query_signature`).
   * The frontend computes `core_hash` from this and sends both to the backend.
   */
  canonical_signature: string;
  /** Evidence blob for audit + diff UI (must be a JSON object). */
  inputs_json: Record<string, any>;
  /** Signature algorithm identifier (see flexi_sigs.md). */
  sig_algo: string;
  /** Context slice DSL or '' for uncontexted */
  slice_key: string;
  /** Timestamp of data retrieval */
  retrieved_at: Date;
  /** Daily data points to append */
  rows: SnapshotRow[];
  /** If true, backend returns detailed diagnostic info */
  diagnostic?: boolean;
}

export interface SnapshotDiagnostic {
  /** Number of rows sent to DB */
  rows_attempted: number;
  /** Number of rows actually inserted */
  rows_inserted: number;
  /** Number of duplicates skipped (ON CONFLICT DO NOTHING) */
  duplicates_skipped: number;
  /** SQL execution time in milliseconds */
  sql_time_ms: number;
  /** Date range of data: "2025-12-01 to 2025-12-10" */
  date_range: string;
  /** Whether any latency columns were populated */
  has_latency: boolean;
  /** Whether A column was populated (cohort mode) */
  has_anchor: boolean;
  /** Slice key or "(uncontexted)" */
  slice_key: string;
  /** Reason if empty (e.g., "empty_rows") */
  reason?: string;
}

export interface AppendSnapshotsResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Number of rows inserted (excludes duplicates) */
  inserted: number;
  /** Short DB core_hash used for inserts (content-address of canonical_signature) */
  core_hash?: string;
  /** Error message if failed */
  error?: string;
  /** Diagnostic details (only present if diagnostic=true in request) */
  diagnostic?: SnapshotDiagnostic;
}

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

// Environment-aware base URL (same pattern as graphComputeClient.ts)
const PYTHON_API_BASE = import.meta.env.DEV 
  ? (import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:9000')  // Local Python dev server
  : '';                                                                 // Vercel serverless (same origin)

/** 
 * Feature flag for snapshot writes.
 * Can be disabled via environment variable if needed.
 */
const SNAPSHOTS_ENABLED = import.meta.env.VITE_SNAPSHOTS_ENABLED !== 'false';

// -----------------------------------------------------------------------------
// Service Implementation
// -----------------------------------------------------------------------------

/**
 * Append snapshot rows to the database.
 * 
 * This is called after successful data fetches to shadow-write the time-series
 * data for later retrieval by the read path.
 * 
 * The operation is fire-and-forget by design - failures are logged but do not
 * block the primary data flow. This ensures the snapshot feature is additive
 * and cannot break existing functionality.
 * 
 * @param params - Snapshot data to append
 * @returns Result with success status and inserted count
 * 
 * @example
 * ```typescript
 * await appendSnapshots({
 *   param_id: 'repo-main-checkout-conversion',
 *   core_hash: 'abc123def456',
 *   slice_key: 'context(channel:google)',
 *   retrieved_at: new Date(),
 *   rows: timeSeries.map(ts => ({
 *     anchor_day: ts.date,
 *     X: ts.n,
 *     Y: ts.k,
 *     median_lag_days: ts.median_lag_days,
 *   })),
 * });
 * ```
 */
export async function appendSnapshots(params: AppendSnapshotsParams): Promise<AppendSnapshotsResult> {
  // Check feature flag
  if (!SNAPSHOTS_ENABLED) {
    return { success: true, inserted: 0 };
  }
  
  // Skip if no rows to write
  if (!params.rows || params.rows.length === 0) {
    return { success: true, inserted: 0 };
  }
  
  try {
    // Frontend computes core_hash — backend uses it as an opaque DB key (hash-fixes.md)
    const core_hash = await computeShortCoreHash(params.canonical_signature);

    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        canonical_signature: params.canonical_signature,
        core_hash,
        inputs_json: params.inputs_json,
        sig_algo: params.sig_algo,
        slice_key: params.slice_key,
        retrieved_at: params.retrieved_at.toISOString(),
        rows: params.rows,
        diagnostic: params.diagnostic || false,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SnapshotWrite] Failed to append snapshots:', response.status, errorText);
      return { success: false, inserted: 0, error: errorText };
    }
    
    const result = await response.json();
    return {
      success: result.success,
      inserted: result.inserted,
      core_hash: result.core_hash,
      diagnostic: result.diagnostic,
    };
    
  } catch (error) {
    // Network or parsing error - return failure, don't throw
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SnapshotWrite] Error appending snapshots:', errorMessage);
    return { success: false, inserted: 0, error: errorMessage };
  }
}

/**
 * Check snapshot database health.
 * 
 * Used by the frontend to enable/disable snapshot-dependent features.
 * 
 * @returns Health status with db connectivity info
 */
export async function checkSnapshotHealth(): Promise<{ status: 'ok' | 'error'; db: string; error?: string }> {
  if (!SNAPSHOTS_ENABLED) {
    return { status: 'ok', db: 'disabled' };
  }
  
  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/health`);
    
    if (!response.ok) {
      return { status: 'error', db: 'unavailable', error: `HTTP ${response.status}` };
    }
    
    return await response.json();
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { status: 'error', db: 'unreachable', error: errorMessage };
  }
}

// -----------------------------------------------------------------------------
// Phase 2: Read Path — Inventory & Delete
// -----------------------------------------------------------------------------

export interface SnapshotInventory {
  /** Whether any snapshots exist */
  has_data: boolean;
  /** Parameter ID */
  param_id: string;
  /** Earliest retrieved_at (ISO datetime string) or null — when snapshotting first ran */
  earliest: string | null;
  /** Latest retrieved_at (ISO datetime string) or null — when snapshotting last ran */
  latest: string | null;
  /** Total row count */
  row_count: number;
  /** Number of unique anchor_days */
  unique_days: number;
  /** Number of unique slice_keys */
  unique_slices: number;
  /** Number of unique core_hashes */
  unique_hashes: number;
  /** Number of unique retrieval instances (distinct retrieved_at timestamps) */
  unique_retrievals: number;
  /**
   * Number of distinct retrieval DAYS (UTC) for this param_id.
   * This corresponds to "how many days did snapshotting operate?" and is what most users mean by "number of snapshots".
   */
  unique_retrieved_days?: number;
}

// -----------------------------------------------------------------------------
// Phase 2+: Inventory V2 (signature families)
// -----------------------------------------------------------------------------

export interface SnapshotInventoryOverallAllFamiliesV2 {
  row_count: number;
  unique_anchor_days: number;
  unique_retrievals: number;
  unique_retrieved_days: number;
  earliest_anchor_day: string | null;
  latest_anchor_day: string | null;
  earliest_retrieved_at: string | null;
  latest_retrieved_at: string | null;
}

export interface SnapshotInventoryFamilySliceV2 extends SnapshotInventoryOverallAllFamiliesV2 {
  slice_key: string;
}

export interface SnapshotInventoryFamilyV2 {
  family_id: string;
  family_size: number;
  member_core_hashes: string[];
  created_at_min: string | null;
  created_at_max: string | null;
  overall: SnapshotInventoryOverallAllFamiliesV2;
  by_slice_key: SnapshotInventoryFamilySliceV2[];
}

export interface SnapshotInventoryCurrentMatchV2 {
  provided_signature?: string;
  provided_core_hash?: string | null;
  matched_family_id?: string | null;
  match_mode: 'strict' | 'equivalent' | 'none';
  matched_core_hashes: string[];
}

export interface SnapshotInventoryV2Param {
  param_id: string;
  overall_all_families: SnapshotInventoryOverallAllFamiliesV2;
  current: SnapshotInventoryCurrentMatchV2;
  families: SnapshotInventoryFamilyV2[];
  unlinked_core_hashes: string[];
  warnings: string[];
}

export interface SnapshotInventoryV2Response {
  success: boolean;
  inventory_version: 2;
  inventory: Record<string, SnapshotInventoryV2Param>;
}

export interface SnapshotInventorySliceBreakdown {
  slice_key: string;
  earliest: string | null;
  latest: string | null;
  row_count: number;
  unique_days: number;
}

export interface SnapshotInventorySignatureBreakdown {
  core_hash: string;
  earliest: string | null;
  latest: string | null;
  row_count: number;
  unique_days: number;
  unique_slices: number;
  /** Distinct retrieval DAYS (UTC), deduped across slice_key for this signature */
  unique_retrieved_days: number;
  by_slice_key: SnapshotInventorySliceBreakdown[];
}

export interface SnapshotInventoryRich {
  overall: SnapshotInventory;
  by_core_hash: SnapshotInventorySignatureBreakdown[];
}

export interface DeleteSnapshotsResult {
  success: boolean;
  deleted: number;
  error?: string;
}

// -----------------------------------------------------------------------------
// Phase 2: Read Path — Query Full (download/export + analytics)
// -----------------------------------------------------------------------------

export interface SnapshotQueryRow {
  param_id: string;
  core_hash: string;
  slice_key: string;
  /** Anchor day in ISO date format (YYYY-MM-DD) */
  anchor_day: string;
  /** Retrieval timestamp in ISO date-time format */
  retrieved_at: string;
  /** Anchor entrants (cohort mode only) */
  a?: number | null;
  /** From-step count (n) */
  x?: number | null;
  /** To-step count / conversions (k) */
  y?: number | null;
  /** Median conversion lag in days */
  median_lag_days?: number | null;
  /** Mean conversion lag in days */
  mean_lag_days?: number | null;
  /** Anchor-relative median lag in days */
  anchor_median_lag_days?: number | null;
  /** Anchor-relative mean lag in days */
  anchor_mean_lag_days?: number | null;
  /** Onset delay before conversions begin (from histogram) */
  onset_delta_days?: number | null;
}

export interface QuerySnapshotsFullParams {
  /** Exact workspace-prefixed parameter ID */
  param_id: string;
  core_hash?: string;
  /** Canonical signature for audit provenance (optional; sent alongside core_hash) */
  canonical_signature?: string;
  slice_keys?: string[];
  anchor_from?: string; // ISO date
  anchor_to?: string; // ISO date
  as_at?: string; // ISO datetime
  /** Optional restriction to specific retrieved_at timestamps (ISO datetimes) */
  retrieved_ats?: string[];
  /** Max rows to return (default backend: 10000) */
  limit?: number;
}

export interface QuerySnapshotsFullResult {
  success: boolean;
  rows: SnapshotQueryRow[];
  count: number;
  error?: string;
}

/**
 * Query snapshot rows with full filtering support.
 *
 * This is the client for `POST /api/snapshots/query-full`.
 * It is used for exporting "full rows" as CSV and for snapshot-based analytics.
 */
export async function querySnapshotsFull(params: QuerySnapshotsFullParams): Promise<QuerySnapshotsFullResult> {
  if (!SNAPSHOTS_ENABLED) {
    return { success: true, rows: [], count: 0 };
  }

  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/query-full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        core_hash: params.core_hash,
        canonical_signature: params.canonical_signature,
        slice_keys: params.slice_keys,
        anchor_from: params.anchor_from,
        anchor_to: params.anchor_to,
        as_at: params.as_at,
        retrieved_ats: params.retrieved_ats,
        limit: params.limit,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SnapshotQueryFull] Failed:', response.status, errorText);
      return { success: false, rows: [], count: 0, error: errorText };
    }

    const body = await response.json();
    return {
      success: !!body.success,
      rows: Array.isArray(body.rows) ? body.rows : [],
      count: typeof body.count === 'number' ? body.count : (Array.isArray(body.rows) ? body.rows.length : 0),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SnapshotQueryFull] Error:', errorMessage);
    return { success: false, rows: [], count: 0, error: errorMessage };
  }
}

// -----------------------------------------------------------------------------
// Phase 3: Virtual Snapshot (asat) — Latest-per-anchor_day as-of
// -----------------------------------------------------------------------------

export interface QuerySnapshotsVirtualParams {
  /** Exact workspace-prefixed parameter ID */
  param_id: string;
  /** Point-in-time for snapshot retrieval (ISO datetime) */
  as_at: string;
  /** Start of anchor date range (ISO date) */
  anchor_from: string;
  /** End of anchor date range (ISO date) */
  anchor_to: string;
  /** Canonical semantic signature (frontend `query_signature`) */
  canonical_signature: string;
  /** List of slice keys to include (optional, undefined = all) */
  slice_keys?: string[];
  /** Max rows to return (default backend: 10000) */
  limit?: number;
}

export interface VirtualSnapshotRow {
  anchor_day: string;
  slice_key: string;
  core_hash: string;
  retrieved_at: string;
  a?: number | null;
  x?: number | null;
  y?: number | null;
  median_lag_days?: number | null;
  mean_lag_days?: number | null;
  anchor_median_lag_days?: number | null;
  anchor_mean_lag_days?: number | null;
  onset_delta_days?: number | null;
}

export interface QuerySnapshotsVirtualResult {
  success: boolean;
  rows: VirtualSnapshotRow[];
  count: number;
  /** Max retrieved_at among selected rows (ISO datetime or null if no rows) */
  latest_retrieved_at_used: string | null;
  /** Whether the result includes the requested anchor_to date */
  has_anchor_to: boolean;
  /** Whether ANY virtual rows exist for this param/window (any core_hash) */
  has_any_rows?: boolean;
  /** Whether ANY virtual rows exist for the requested core_hash */
  has_matching_core_hash?: boolean;
  error?: string;
}

export interface QuerySnapshotRetrievalsParams {
  /** Exact workspace-prefixed parameter ID */
  param_id: string;
  /** Canonical semantic signature (`query_signature`); optional filter */
  canonical_signature?: string;
  /** Core hash; preferred filter when available */
  core_hash?: string;
  /** Slice keys (context/case dimensions only), or omit to include all */
  slice_keys?: string[];
  /** ISO date (YYYY-MM-DD) lower bound on anchor_day, inclusive */
  anchor_from?: string;
  /** ISO date (YYYY-MM-DD) upper bound on anchor_day, inclusive */
  anchor_to?: string;
  /** If true, expand equivalence links when filtering by signature (default true) */
  include_equivalents?: boolean;
  /** If true, include per-retrieval summary rows (default false) */
  include_summary?: boolean;
  /** Hard cap on timestamps returned (default 200) */
  limit?: number;
}

export interface SnapshotRetrievalSummaryRow {
  retrieved_at: string; // ISO datetime
  slice_key: string;
  anchor_from: string | null; // ISO date
  anchor_to: string | null; // ISO date
  row_count: number;
  sum_x: number;
  sum_y: number;
}

export interface QuerySnapshotRetrievalsResult {
  success: boolean;
  retrieved_at: string[];
  retrieved_days: string[];
  latest_retrieved_at: string | null;
  count: number;
  summary?: SnapshotRetrievalSummaryRow[];
  error?: string;
}

/**
 * Query a "virtual snapshot": latest row per anchor_day (and slice_key) as-of a timestamp.
 *
 * This is the client for `POST /api/snapshots/query-virtual`.
 * It is used by the asat() DSL function for historical queries.
 *
 * Performance note: the backend executes at most one SQL query per param_id.
 */
export async function querySnapshotsVirtual(params: QuerySnapshotsVirtualParams): Promise<QuerySnapshotsVirtualResult> {
  if (!SNAPSHOTS_ENABLED) {
    return {
      success: true,
      rows: [],
      count: 0,
      latest_retrieved_at_used: null,
      has_anchor_to: false,
      has_any_rows: false,
      has_matching_core_hash: false,
    };
  }

  try {
    // Frontend computes core_hash — backend uses it as an opaque DB key (hash-fixes.md)
    const core_hash = await computeShortCoreHash(params.canonical_signature);

    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/query-virtual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        as_at: params.as_at,
        anchor_from: params.anchor_from,
        anchor_to: params.anchor_to,
        canonical_signature: params.canonical_signature,
        core_hash,
        slice_keys: params.slice_keys,
        include_equivalents: true,
        limit: params.limit,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SnapshotQueryVirtual] Failed:', response.status, errorText);
      return { success: false, rows: [], count: 0, latest_retrieved_at_used: null, has_anchor_to: false, error: errorText };
    }

    const body = await response.json();
    return {
      success: !!body.success,
      rows: Array.isArray(body.rows) ? body.rows : [],
      count: typeof body.count === 'number' ? body.count : (Array.isArray(body.rows) ? body.rows.length : 0),
      latest_retrieved_at_used: body.latest_retrieved_at_used ?? null,
      has_anchor_to: !!body.has_anchor_to,
      has_any_rows: typeof body.has_any_rows === 'boolean' ? body.has_any_rows : undefined,
      has_matching_core_hash: typeof body.has_matching_core_hash === 'boolean' ? body.has_matching_core_hash : undefined,
      error: body.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SnapshotQueryVirtual] Error:', errorMessage);
    return { success: false, rows: [], count: 0, latest_retrieved_at_used: null, has_anchor_to: false, error: errorMessage };
  }
}

/**
 * Query distinct snapshot retrieval timestamps for a subject (Phase 2 `@` UI).
 *
 * This is the client for `POST /api/snapshots/retrievals`.
 */
export async function querySnapshotRetrievals(params: QuerySnapshotRetrievalsParams): Promise<QuerySnapshotRetrievalsResult> {
  if (!SNAPSHOTS_ENABLED) {
    return {
      success: true,
      retrieved_at: [],
      retrieved_days: [],
      latest_retrieved_at: null,
      count: 0,
    };
  }

  try {
    // Prefer explicit core_hash; else compute from canonical_signature if provided (hash-fixes.md)
    const core_hash = params.core_hash
      ? params.core_hash
      : (params.canonical_signature ? await computeShortCoreHash(params.canonical_signature) : undefined);

    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/retrievals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        canonical_signature: params.canonical_signature,
        core_hash,
        slice_keys: params.slice_keys,
        anchor_from: params.anchor_from,
        anchor_to: params.anchor_to,
        include_equivalents: params.include_equivalents ?? true,
        include_summary: params.include_summary ?? false,
        limit: params.limit,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SnapshotRetrievals] Failed:', response.status, errorText);
      return { success: false, retrieved_at: [], retrieved_days: [], latest_retrieved_at: null, count: 0, error: errorText };
    }

    const body = await response.json();
    return {
      success: !!body.success,
      retrieved_at: Array.isArray(body.retrieved_at) ? body.retrieved_at : [],
      retrieved_days: Array.isArray(body.retrieved_days) ? body.retrieved_days : [],
      latest_retrieved_at: body.latest_retrieved_at ?? null,
      count: typeof body.count === 'number' ? body.count : (Array.isArray(body.retrieved_at) ? body.retrieved_at.length : 0),
      summary: Array.isArray(body.summary) ? body.summary : undefined,
      error: body.error,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SnapshotRetrievals] Error:', errorMessage);
    return { success: false, retrieved_at: [], retrieved_days: [], latest_retrieved_at: null, count: 0, error: errorMessage };
  }
}

/**
 * Batch-query distinct retrieved_day (UTC date) per param_id in a single request.
 *
 * Used by the aggregate as-at calendar when no edge is selected.
 * No core_hash filtering — broadest "any snapshots exist?" view.
 */
export async function getBatchRetrievalDays(
  paramIds: string[],
  limitPerParam = 200,
): Promise<Record<string, string[]>> {
  if (!SNAPSHOTS_ENABLED || paramIds.length === 0) {
    return {};
  }

  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/batch-retrieval-days`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_ids: paramIds,
        limit_per_param: limitPerParam,
      }),
    });

    if (!response.ok) {
      console.error('[getBatchRetrievalDays] Failed:', response.status);
      return {};
    }

    const data = await response.json();
    return (data.days_by_param || {}) as Record<string, string[]>;
  } catch (error) {
    console.error('[getBatchRetrievalDays] Error:', error);
    return {};
  }
}

// =============================================================================
// Batch Anchor Coverage — missing anchor-day ranges for Retrieve All preflight
// =============================================================================

export interface BatchAnchorCoverageSubject {
  param_id: string;
  core_hash: string;
  slice_keys: string[];
  /** ISO date (YYYY-MM-DD) */
  anchor_from: string;
  /** ISO date (YYYY-MM-DD) */
  anchor_to: string;
  include_equivalents?: boolean;
}

export interface BatchAnchorCoverageResult {
  subject_index: number;
  coverage_ok: boolean;
  missing_anchor_ranges: Array<{ start: string; end: string }>;
  /**
   * Optional: present ranges (normalised union) returned in diagnostic mode.
   * Inclusive ISO date bounds.
   */
  present_anchor_ranges?: Array<{ start: string; end: string }>;
  present_anchor_day_count: number;
  expected_anchor_day_count: number;
  equivalence_resolution: {
    core_hashes: string[];
    param_ids: string[];
  };
  /** Optional: slice-key normalisation evidence (diagnostic mode). */
  slice_keys_normalised?: string[];
  /** Optional: whether slice filter was applied (diagnostic mode). */
  slice_filter_kind?: 'none' | 'families' | 'empty';
  error?: string;
}

/**
 * Query the snapshot DB for missing anchor-day ranges per subject.
 *
 * Used by Retrieve All DB preflight (bd-pre-fetch-pass.md) to detect
 * historic gaps caused by hash drift or late-start snapshotting.
 *
 * Graceful degradation: returns empty/error results on failure so the
 * caller can fall back to file-only planning.
 */
export async function batchAnchorCoverage(
  subjects: BatchAnchorCoverageSubject[],
  opts?: { diagnostic?: boolean }
): Promise<BatchAnchorCoverageResult[]> {
  if (!SNAPSHOTS_ENABLED || subjects.length === 0) {
    return subjects.map((_, i) => ({
      subject_index: i,
      coverage_ok: true, // assume covered when snapshots disabled
      missing_anchor_ranges: [],
      present_anchor_day_count: 0,
      expected_anchor_day_count: 0,
      equivalence_resolution: { core_hashes: [], param_ids: [] },
    }));
  }

  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/batch-anchor-coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diagnostic: opts?.diagnostic === true,
        subjects: subjects.map(s => ({
          param_id: s.param_id,
          core_hash: s.core_hash,
          slice_keys: s.slice_keys,
          anchor_from: s.anchor_from,
          anchor_to: s.anchor_to,
          include_equivalents: s.include_equivalents ?? true,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[batchAnchorCoverage] Failed:', response.status, errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    console.error('[batchAnchorCoverage] Error:', error);
    // Graceful degradation: return "assume covered" so caller falls back
    return subjects.map((_, i) => ({
      subject_index: i,
      coverage_ok: true,
      missing_anchor_ranges: [],
      present_anchor_day_count: 0,
      expected_anchor_day_count: 0,
      equivalence_resolution: { core_hashes: [], param_ids: [] },
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Get snapshot inventory for multiple parameters in one request.
 *
 * Legacy wrapper maintained for existing call sites.
 * Internally adapts from Inventory V2 (signature families) into the older `SnapshotInventory` shape.
 */
export async function getBatchInventory(paramIds: string[]): Promise<Record<string, SnapshotInventory>> {
  if (!SNAPSHOTS_ENABLED || paramIds.length === 0) {
    const result: Record<string, SnapshotInventory> = {};
    for (const pid of paramIds) {
      result[pid] = {
        has_data: false,
        param_id: pid,
        earliest: null,
        latest: null,
        row_count: 0,
        unique_days: 0,
        unique_slices: 0,
        unique_hashes: 0,
        unique_retrievals: 0,
        unique_retrieved_days: 0,
      };
    }
    return result;
  }

  try {
    const v2 = await getBatchInventoryV2(paramIds, { include_equivalents: true });
    const out: Record<string, SnapshotInventory> = {};

    for (const pid of paramIds) {
      const overallAll = v2?.[pid]?.overall_all_families;
      out[pid] = overallAll
        ? {
            has_data: overallAll.row_count > 0,
            param_id: pid,
            earliest: overallAll.earliest_anchor_day,
            latest: overallAll.latest_anchor_day,
            row_count: overallAll.row_count,
            unique_days: overallAll.unique_anchor_days,
            unique_slices: 0,
            unique_hashes: 0,
            unique_retrievals: overallAll.unique_retrievals,
            unique_retrieved_days: overallAll.unique_retrieved_days,
          }
        : {
            has_data: false,
            param_id: pid,
            earliest: null,
            latest: null,
            row_count: 0,
            unique_days: 0,
            unique_slices: 0,
            unique_hashes: 0,
            unique_retrievals: 0,
            unique_retrieved_days: 0,
          };
    }

    return out;
  } catch (error) {
    console.error('[SnapshotInventory] Error:', error);
    const result: Record<string, SnapshotInventory> = {};
    for (const pid of paramIds) {
      result[pid] = {
        has_data: false,
        param_id: pid,
        earliest: null,
        latest: null,
        row_count: 0,
        unique_days: 0,
        unique_slices: 0,
        unique_hashes: 0,
        unique_retrievals: 0,
        unique_retrieved_days: 0,
      };
    }
    return result;
  }
}

/**
 * Get inventory V2 (signature families) for multiple parameters.
 *
 * This is the canonical inventory shape for flexi_sigs.
 */
export async function getBatchInventoryV2(
  paramIds: string[]
  , options?: {
    current_signatures?: Record<string, string>;
    slice_keys?: Record<string, string[]>;
    include_equivalents?: boolean;
    limit_families_per_param?: number;
    limit_slices_per_family?: number;
  }
): Promise<Record<string, SnapshotInventoryV2Param>> {
  if (!SNAPSHOTS_ENABLED || paramIds.length === 0) {
    return {};
  }

  try {
    // Pre-compute core_hashes for all current_signatures (hash-fixes.md)
    let current_core_hashes: Record<string, string> | undefined;
    if (options?.current_signatures) {
      const entries = Object.entries(options.current_signatures);
      const hashPromises = entries.map(async ([pid, sig]) => {
        try {
          const ch = await computeShortCoreHash(sig);
          return [pid, ch] as const;
        } catch {
          return null; // Skip entries with invalid signatures
        }
      });
      const results = (await Promise.all(hashPromises)).filter(Boolean) as Array<readonly [string, string]>;
      if (results.length > 0) {
        current_core_hashes = Object.fromEntries(results);
      }
    }

    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_ids: paramIds,
        current_signatures: options?.current_signatures,
        current_core_hashes,
        slice_keys: options?.slice_keys,
        include_equivalents: options?.include_equivalents ?? true,
        limit_families_per_param: options?.limit_families_per_param,
        limit_slices_per_family: options?.limit_slices_per_family,
      }),
    });

    if (!response.ok) {
      console.error('[SnapshotInventoryRich] Failed:', response.status);
      throw new Error(`HTTP ${response.status}`);
    }

    const data = (await response.json()) as SnapshotInventoryV2Response;
    return (data.inventory || {}) as Record<string, SnapshotInventoryV2Param>;
  } catch (error) {
    console.error('[SnapshotInventoryRich] Error:', error);
    return {};
  }
}

/**
 * Get snapshot inventory for a single parameter.
 *
 * Legacy wrapper maintained for existing call sites.
 */
export async function getInventory(paramId: string): Promise<SnapshotInventory> {
  const batch = await getBatchInventory([paramId]);
  return batch[paramId];
}

/**
 * Delete snapshots for a specific parameter, optionally scoped to core_hashes.
 * 
 * When core_hashes is omitted, deletes ALL rows for the param_id (param-wide).
 * When core_hashes is provided, deletes only rows matching those core_hashes.
 * 
 * @param paramId - Exact workspace-prefixed parameter ID
 * @param core_hashes - Optional list of core_hash values to scope the delete
 * @returns Result with deleted count
 */
export async function deleteSnapshots(
  paramId: string,
  core_hashes?: string[],
  retrieved_ats?: string[],
): Promise<DeleteSnapshotsResult> {
  if (!SNAPSHOTS_ENABLED) {
    return { success: true, deleted: 0 };
  }
  
  try {
    const body: Record<string, unknown> = { param_id: paramId };
    if (core_hashes && core_hashes.length > 0) {
      body.core_hashes = core_hashes;
    }
    if (retrieved_ats && retrieved_ats.length > 0) {
      body.retrieved_ats = retrieved_ats;
    }
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[SnapshotDelete] Failed:', response.status, errorText);
      return { success: false, deleted: 0, error: errorText };
    }
    
    return await response.json();
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SnapshotDelete] Error:', errorMessage);
    return { success: false, deleted: 0, error: errorMessage };
  }
}
