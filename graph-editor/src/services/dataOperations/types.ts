/**
 * Shared types for data operations modules.
 *
 * Extracted from dataOperationsService.ts to avoid circular imports
 * between the facade and its extracted modules.
 */

export type PermissionCopyMode = 'copy_all' | 'copy_if_false' | 'do_not_copy';

export interface PutToFileCopyOptions {
  includeValues?: boolean;
  includeMetadata?: boolean;
  permissionsMode?: PermissionCopyMode;
}

export interface GetFromFileCopyOptions {
  /**
   * If true, copy scalar/value fields from file → graph.
   * Default true for explicit GET.
   */
  includeValues?: boolean;
  /**
   * If true, copy metadata/config fields from file → graph (query/connection/latency config/etc).
   * Default true for explicit GET.
   */
  includeMetadata?: boolean;
  /**
   * Controls copying of permission flags (override flags) from file → graph.
   * Default do_not_copy to avoid unexpected permission changes.
   */
  permissionsMode?: PermissionCopyMode;
}

/**
 * Cache analysis result - reported immediately after cache check, before any API fetch.
 * Used by retrieve-all to show real-time progress ("fetching 5d across 2 gaps").
 */
export interface CacheAnalysisResult {
  /** True if all requested data is fully cached (no API call needed) */
  cacheHit: boolean;
  /** Number of days that need to be fetched from API (0 if cache hit) */
  daysToFetch: number;
  /** Number of contiguous gaps in the cache (0 if cache hit) */
  gapCount: number;
  /** Number of days already available from cache */
  daysFromCache: number;
  /** Total days in the requested window */
  totalDays: number;
}

/**
 * Fetch windows plan for a single getFromSource call.
 *
 * Emitted after cache analysis + maturity/refetch policy resolution, immediately before any external API calls.
 * This allows batch workflows (Retrieve All) to emit a precise end-of-run "what was fetched" artefact.
 *
 * IMPORTANT:
 * - Dates are UK format (d-MMM-yy) for internal/logging use.
 * - `windows` are the *actual* chained gap windows that execution will attempt.
 */
export interface FetchWindowsPlanResult {
  /** The authoritative per-item slice DSL that drove this fetch (e.g. context(channel:paid-search).window(-100d:)) */
  targetSlice: string;
  /** Window/cohort mode for this item */
  mode: 'window' | 'cohort';
  /** The resolved requested window (UK dates) */
  requestedWindow: { start: string; end: string };
  /** Planned windows to execute (UK dates), in order */
  windows: Array<{ start: string; end: string }>;
  /** True if execution will skip external fetch (fully cached and no refetch policy forces a fetch) */
  shouldSkipFetch: boolean;
  /** Optional: refetch policy classification (if available) */
  refetchPolicyType?: string;
}

/**
 * Result from getFromSource/getFromSourceDirect with fetch statistics.
 * Used by retrieve-all to aggregate stats for summary reporting.
 */
export interface GetFromSourceResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** True if all data was served from cache (no API call made) */
  cacheHit: boolean;
  /** Number of days actually fetched from API (0 if cache hit) */
  daysFetched: number;
  /** Number of days served from cache */
  daysFromCache: number;
}
