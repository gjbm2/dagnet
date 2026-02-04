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
 */

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
  /** Query signature hash for semantic matching */
  core_hash: string;
  /** Context definition hashes for future strict matching */
  context_def_hashes?: Record<string, string>;
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
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/append`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        core_hash: params.core_hash,
        context_def_hashes: params.context_def_hashes || null,
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
  /** Earliest anchor_day (ISO date string) or null */
  earliest: string | null;
  /** Latest anchor_day (ISO date string) or null */
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
  slice_keys?: string[];
  anchor_from?: string; // ISO date
  anchor_to?: string; // ISO date
  as_at?: string; // ISO datetime
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
        slice_keys: params.slice_keys,
        anchor_from: params.anchor_from,
        anchor_to: params.anchor_to,
        as_at: params.as_at,
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
  /** Query signature hash (REQUIRED for semantic integrity) */
  core_hash: string;
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
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/query-virtual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        param_id: params.param_id,
        as_at: params.as_at,
        anchor_from: params.anchor_from,
        anchor_to: params.anchor_to,
        core_hash: params.core_hash,
        slice_keys: params.slice_keys,
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
 * Get snapshot inventory for multiple parameters in one request.
 * 
 * Efficient batch query for UI that needs to show snapshot counts.
 * 
 * @param paramIds - List of workspace-prefixed parameter IDs
 * @returns Map of param_id to inventory
 */
export async function getBatchInventory(
  paramIds: string[]
): Promise<Record<string, SnapshotInventory>> {
  if (!SNAPSHOTS_ENABLED || paramIds.length === 0) {
    // Return empty inventory for all requested params
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
      };
    }
    return result;
  }

  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/inventory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_ids: paramIds }),
    });
    
    if (!response.ok) {
      console.error('[SnapshotInventory] Failed:', response.status);
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    return data.inventory;
    
  } catch (error) {
    console.error('[SnapshotInventory] Error:', error);
    // Return empty inventory on error
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
      };
    }
    return result;
  }
}

/**
 * Get snapshot inventory for a single parameter.
 * 
 * Convenience wrapper around getBatchInventory for single-param use.
 * 
 * @param paramId - Workspace-prefixed parameter ID
 * @returns Inventory for the parameter
 */
export async function getInventory(paramId: string): Promise<SnapshotInventory> {
  const batch = await getBatchInventory([paramId]);
  return batch[paramId];
}

/**
 * Delete all snapshots for a specific parameter.
 * 
 * Used by the "Delete snapshots (X)" UI feature.
 * 
 * @param paramId - Exact workspace-prefixed parameter ID
 * @returns Result with deleted count
 */
export async function deleteSnapshots(paramId: string): Promise<DeleteSnapshotsResult> {
  if (!SNAPSHOTS_ENABLED) {
    return { success: true, deleted: 0 };
  }
  
  try {
    const response = await fetch(`${PYTHON_API_BASE}/api/snapshots/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ param_id: paramId }),
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
