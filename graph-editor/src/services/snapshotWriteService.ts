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

const PYTHON_API_BASE = import.meta.env.VITE_PYTHON_API_URL || 'http://localhost:8000';

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
