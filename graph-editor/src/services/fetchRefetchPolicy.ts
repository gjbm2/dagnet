/**
 * Fetch/Refetch Policy for Latency Edges
 * 
 * Implements maturity-aware fetch decisions as specified in design.md §4.7.3.
 * 
 * This module determines:
 * - Whether to fetch from source at all (use cache vs refetch)
 * - Which portion of a window to fetch (mature vs immature segments)
 * - Whether to replace or merge existing slice data
 */

import { parseDate, normalizeDate } from './windowAggregationService';
import { LATENCY_REFETCH_COOLDOWN_MINUTES } from '../constants/latency';
import type { DateRange } from '../types';
import type { ParameterValue } from '../types/parameterData';

// =============================================================================
// Types
// =============================================================================

export type RefetchType = 
  | 'gaps_only'      // Non-latency: only fetch missing date gaps
  | 'partial'        // Window with latency: refetch immature portion
  | 'replace_slice'  // Cohort with latency: replace entire slice
  | 'use_cache';     // Data is sufficiently mature, no refetch needed

export interface RefetchDecision {
  type: RefetchType;
  
  /** For 'partial' type: dates after this are immature and need refetch */
  matureCutoff?: string;
  
  /** For 'partial' type: specific date range to refetch */
  refetchWindow?: DateRange;
  
  /** For 'replace_slice' type: reason for replacement */
  reason?: string;
  
  /** Whether any immature cohorts exist */
  hasImmatureCohorts?: boolean;

  /** Cooldown metadata (when we suppress latency-aware refetch shortly after a successful fetch). */
  cooldownApplied?: boolean;
  cooldownMinutes?: number;
  lastRetrievedAt?: string;
  lastRetrievedAgeMinutes?: number;
  /** If cooldown suppressed a latency-aware refetch, this captures the window we *would* have refetched. */
  wouldRefetchWindow?: DateRange;
}

export interface LatencyConfig {
  /** Explicit enablement flag (Phase 2). true = latency tracking enabled. */
  latency_parameter?: boolean;
  anchor_node_id?: string;
  t95?: number;
  path_t95?: number;  // Cumulative latency from anchor, computed by statisticalEnhancementService
}

export interface RefetchPolicyInput {
  /** Existing slice from parameter file (if any) */
  existingSlice?: ParameterValue;
  
  /** Latency configuration from edge */
  latencyConfig?: LatencyConfig;
  
  /** Requested query window */
  requestedWindow: DateRange;
  
  /** Whether this is a cohort() query (vs window() query) */
  isCohortQuery: boolean;
  
  /** Reference date for maturity calculations (defaults to today) */
  referenceDate?: Date;
}

// =============================================================================
// Main Policy Function
// =============================================================================

/**
 * Determine refetch policy for a given slice and edge configuration.
 * 
 * Implements the design.md §4.7.3 policy table:
 * 
 * | Slice Type                | Cache Policy                    | Merge Policy                    |
 * |---------------------------|--------------------------------|--------------------------------|
 * | window() with maturity=0  | Incremental gaps               | Merge by date                  |
 * | window() with maturity>0  | Re-fetch immature portion      | Replace immature, merge mature |
 * | cohort()                  | Re-fetch if immature OR stale  | Replace entire slice           |
 * 
 * @param input Policy decision inputs
 * @returns Refetch decision with type and parameters
 */
export function shouldRefetch(input: RefetchPolicyInput): RefetchDecision {
  const {
    existingSlice,
    latencyConfig,
    requestedWindow,
    isCohortQuery,
    referenceDate = new Date(),
  } = input;

  // Phase 2: latency_parameter is canonical enablement flag
  const isLatencyEnabled = latencyConfig?.latency_parameter === true;

  // Non-latency edge: standard gap-based incremental fetch
  if (!isLatencyEnabled) {
    return { type: 'gaps_only' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EFFECTIVE MATURITY CALCULATION (design.md §5.4, §11.1.I)
  // 
  // Window mode uses edge-local t95 as the effective maturity threshold.
  // Cohort mode prefers path_t95 (cumulative lag) and falls back to t95.
  // If t95 is missing, Phase 2 relies on default injection and uses a conservative fallback.
  // ═══════════════════════════════════════════════════════════════════════════
  const effectiveT95Days = isCohortQuery
    ? computeEffectiveCohortMaturity(latencyConfig)
    : computeEffectiveMaturity(latencyConfig);

  // COHORT MODE: Check if any cohorts are still immature
  if (isCohortQuery) {
    return evaluateCohortRefetch(existingSlice, effectiveT95Days, requestedWindow, referenceDate);
  }

  // WINDOW MODE with latency: partial refetch for immature dates
  return evaluateWindowRefetch(existingSlice, effectiveT95Days, requestedWindow, referenceDate);
}

/**
 * Compute effective maturity threshold for refetch decisions.
 * 
 * Prefers t95 (95th percentile lag from CDF fitting) when available,
 * otherwise falls back to a conservative default.
 * 
 * @param latencyConfig Latency configuration from edge
 * @returns Effective maturity in days
 */
export function computeEffectiveMaturity(latencyConfig?: LatencyConfig): number {
  const t95 = latencyConfig?.t95;
  
  // If t95 is available and positive, use it as the effective maturity
  // t95 represents the 95th percentile lag time, which is a better indicator
  // of when cohorts are "mature"
  if (t95 !== undefined && t95 > 0) {
    // Round up to ensure we're conservative (don't declare mature too early)
    const effectiveMaturity = Math.ceil(t95);
    
    console.log('[fetchRefetchPolicy] Using t95 for effective maturity:', {
      t95,
      effectiveMaturity,
    });
    
    return effectiveMaturity;
  }
  
  // If t95 is missing, the Phase 2 invariant is that default injection has not yet
  // occurred or data is incomplete. Be conservative.
  return 30;
}

/**
 * Compute effective maturity threshold for cohort() refetch decisions.
 *
 * Cohort maturity is governed by cumulative lag from the anchor, so we prefer
 * path_t95 where available, and fall back to edge-local t95.
 */
export function computeEffectiveCohortMaturity(latencyConfig?: LatencyConfig): number {
  const pathT95 = latencyConfig?.path_t95;
  if (pathT95 !== undefined && pathT95 > 0) {
    const effectiveMaturity = Math.ceil(pathT95);
    console.log('[fetchRefetchPolicy] Using path_t95 for cohort effective maturity:', {
      pathT95,
      effectiveMaturity,
    });
    return effectiveMaturity;
  }

  // Fallback to edge-local t95 (legacy behaviour)
  return computeEffectiveMaturity(latencyConfig);
}

// =============================================================================
// Cohort Refetch Evaluation
// =============================================================================

/**
 * Evaluate refetch decision for cohort() slices.
 * 
 * Cohort slices should be refetched when:
 * - No existing slice exists
 * - Any cohorts in the slice are still immature (age < effective maturity)
 * - Slice is stale (retrieved_at is old relative to effective t95 days)
 */
function evaluateCohortRefetch(
  existingSlice: ParameterValue | undefined,
  effectiveT95Days: number,
  requestedWindow: DateRange,
  referenceDate: Date
): RefetchDecision {
  // No existing slice: need full fetch
  if (!existingSlice) {
    return {
      type: 'replace_slice',
      reason: 'no_existing_slice',
      hasImmatureCohorts: true,
    };
  }

  // Check cohort dates for immaturity
  const cohortDates = existingSlice.dates || [];
  if (cohortDates.length === 0) {
    return {
      type: 'replace_slice',
      reason: 'no_cohort_dates',
      hasImmatureCohorts: true,
    };
  }

  // Calculate maturity cutoff date (cohorts before this are mature)
  const maturityCutoffMs = referenceDate.getTime() - (effectiveT95Days * 24 * 60 * 60 * 1000);
  const maturityCutoffDate = new Date(maturityCutoffMs);

  // Check if any cohort dates are immature (date >= maturityCutoff means immature)
  let hasImmatureCohorts = false;
  for (const dateStr of cohortDates) {
    const cohortDate = parseDate(dateStr);
    if (cohortDate.getTime() >= maturityCutoffMs) {
      hasImmatureCohorts = true;
      break;
    }
  }

  if (hasImmatureCohorts) {
    // Cooldown: if we just fetched this slice, do not immediately replace it again.
    // Missing gaps will still be handled by incremental cache cutting.
    const retrievedAt = existingSlice.data_source?.retrieved_at;
    const cooldown = getCooldownDecision(retrievedAt, referenceDate);
    if (cooldown.withinCooldown) {
      return {
        type: 'gaps_only',
        reason: 'recent_fetch_cooldown',
        hasImmatureCohorts: true,
        cooldownApplied: true,
        cooldownMinutes: LATENCY_REFETCH_COOLDOWN_MINUTES,
        lastRetrievedAt: retrievedAt,
        lastRetrievedAgeMinutes: cooldown.ageMinutes,
      };
    }
    return {
      type: 'replace_slice',
      reason: 'immature_cohorts',
      hasImmatureCohorts: true,
      matureCutoff: normalizeDate(maturityCutoffDate.toISOString()),
    };
  }

  // Check staleness: if retrieved_at is older than effective maturity ago, refetch
  const retrievedAt = existingSlice.data_source?.retrieved_at;
  if (retrievedAt) {
    const retrievedDate = new Date(retrievedAt);
    const staleThresholdMs = referenceDate.getTime() - (effectiveT95Days * 24 * 60 * 60 * 1000);
    
    if (retrievedDate.getTime() < staleThresholdMs) {
      return {
        type: 'replace_slice',
        reason: 'stale_data',
        hasImmatureCohorts: false,
      };
    }
  }

  // All cohorts mature and data is fresh: use cache
  return {
    type: 'use_cache',
    hasImmatureCohorts: false,
  };
}

// =============================================================================
// Window Refetch Evaluation
// =============================================================================

/**
 * Evaluate refetch decision for window() slices with latency.
 * 
 * Window slices use partial refetch:
 * - Mature portion (dates older than effective maturity): use cache
 * - Immature portion (recent dates): always refetch
 */
function evaluateWindowRefetch(
  existingSlice: ParameterValue | undefined,
  effectiveT95Days: number,
  requestedWindow: DateRange,
  referenceDate: Date
): RefetchDecision {
  // Calculate maturity cutoff: dates before this are mature
  // Immature portion = last effective maturity + 1 day buffer
  const maturityCutoffMs = referenceDate.getTime() - ((effectiveT95Days + 1) * 24 * 60 * 60 * 1000);
  const maturityCutoffDate = new Date(maturityCutoffMs);
  const matureCutoff = normalizeDate(maturityCutoffDate.toISOString());

  // Parse requested window
  const requestedStart = parseDate(requestedWindow.start);
  const requestedEnd = parseDate(requestedWindow.end);

  // Determine immature portion of requested window
  // Immature = dates after maturity cutoff
  const immatureStart = new Date(Math.max(maturityCutoffMs, requestedStart.getTime()));
  const immatureEnd = requestedEnd;

  // If entire requested window is mature, we can use cache (but still check gaps)
  if (requestedEnd.getTime() < maturityCutoffMs) {
    return { type: 'gaps_only' };
  }

  // Partial refetch needed for immature portion
  const refetchWindow: DateRange = {
    start: normalizeDate(immatureStart.toISOString()),
    end: normalizeDate(immatureEnd.toISOString()),
  };

  // Cooldown: if we just fetched this slice recently, suppress the immature refetch.
  // Cache completeness wins; we will still fill missing gaps.
  const retrievedAt = existingSlice?.data_source?.retrieved_at;
  const cooldown = getCooldownDecision(retrievedAt, referenceDate);
  if (cooldown.withinCooldown) {
    return {
      type: 'gaps_only',
      reason: 'recent_fetch_cooldown',
      cooldownApplied: true,
      cooldownMinutes: LATENCY_REFETCH_COOLDOWN_MINUTES,
      lastRetrievedAt: retrievedAt,
      lastRetrievedAgeMinutes: cooldown.ageMinutes,
      wouldRefetchWindow: refetchWindow,
    };
  }

  return {
    type: 'partial',
    matureCutoff,
    refetchWindow,
  };
}

function getCooldownDecision(
  retrievedAt: string | undefined,
  referenceDate: Date
): { withinCooldown: boolean; ageMinutes?: number } {
  if (!retrievedAt) return { withinCooldown: false };
  const retrievedDate = new Date(retrievedAt);
  if (Number.isNaN(retrievedDate.getTime())) return { withinCooldown: false };
  const ageMs = referenceDate.getTime() - retrievedDate.getTime();
  const cooldownMs = LATENCY_REFETCH_COOLDOWN_MINUTES * 60 * 1000;
  const withinCooldown = ageMs >= 0 && ageMs <= cooldownMs;
  return { withinCooldown, ageMinutes: ageMs / (60 * 1000) };
}

// =============================================================================
// Helper: Check if Slice Covers Requested Window
// =============================================================================

/**
 * Check if an existing slice provides coverage for the requested window.
 * 
 * For mature portions, checks if dates exist in the slice.
 * For immature portions, always returns false (needs refetch).
 * 
 * @param existingSlice Slice from parameter file
 * @param requestedWindow Window requested by query
 * @param matureCutoff Date before which data is considered mature
 * @returns Coverage analysis
 */
export function analyzeSliceCoverage(
  existingSlice: ParameterValue | undefined,
  requestedWindow: DateRange,
  matureCutoff: string
): {
  matureCoverage: 'full' | 'partial' | 'none';
  immatureDates: string[];
  missingMatureDates: string[];
} {
  if (!existingSlice) {
    return {
      matureCoverage: 'none',
      immatureDates: [],
      missingMatureDates: [],
    };
  }

  const existingDates = new Set(existingSlice.dates?.map(d => normalizeDate(d)) || []);
  const cutoffTime = parseDate(matureCutoff).getTime();
  
  const requestedStart = parseDate(requestedWindow.start);
  const requestedEnd = parseDate(requestedWindow.end);
  
  const immatureDates: string[] = [];
  const missingMatureDates: string[] = [];
  
  // Iterate through all dates in requested window
  const currentDate = new Date(requestedStart);
  while (currentDate <= requestedEnd) {
    const dateStr = normalizeDate(currentDate.toISOString());
    
    if (currentDate.getTime() > cutoffTime) {
      // Immature date
      immatureDates.push(dateStr);
    } else if (!existingDates.has(dateStr)) {
      // Mature but missing
      missingMatureDates.push(dateStr);
    }
    
    // CRITICAL: Use UTC iteration to avoid DST/local-time drift across long ranges.
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }
  
  const totalMatureDates = Math.max(0, 
    Math.floor((cutoffTime - requestedStart.getTime()) / (24 * 60 * 60 * 1000)) + 1
  );
  
  let matureCoverage: 'full' | 'partial' | 'none';
  if (totalMatureDates === 0 || missingMatureDates.length === 0) {
    matureCoverage = 'full';
  } else if (missingMatureDates.length >= totalMatureDates) {
    matureCoverage = 'none';
  } else {
    matureCoverage = 'partial';
  }
  
  return {
    matureCoverage,
    immatureDates,
    missingMatureDates,
  };
}

// =============================================================================
// Helper: Compute Effective Fetch Window
// =============================================================================

/**
 * Given a refetch decision and coverage analysis, compute the actual window to fetch.
 * 
 * @param decision Refetch decision from shouldRefetch()
 * @param coverage Coverage analysis from analyzeSliceCoverage()
 * @param requestedWindow Original requested window
 * @returns Window to fetch (may be reduced), or null if no fetch needed
 */
export function computeFetchWindow(
  decision: RefetchDecision,
  coverage: { missingMatureDates: string[]; immatureDates: string[] },
  requestedWindow: DateRange
): DateRange | null {
  switch (decision.type) {
    case 'use_cache':
      return null; // No fetch needed
      
    case 'gaps_only':
      // Only fetch if there are missing dates.
      //
      // IMPORTANT: During cooldown (recent fetch), we suppress *immaturity-driven* refetch.
      // In that case, immature dates should NOT be treated as missing; only genuine cache gaps
      // in the mature portion should trigger a fetch.
      const allMissing =
        decision.reason === 'recent_fetch_cooldown' && decision.cooldownApplied
          ? [...coverage.missingMatureDates]
          : [...coverage.missingMatureDates, ...coverage.immatureDates];
      if (allMissing.length === 0) return null;
      
      // Return window spanning all missing dates
      const sortedMissing = allMissing.sort();
      return {
        start: sortedMissing[0],
        end: sortedMissing[sortedMissing.length - 1],
      };
      
    case 'partial':
      // Fetch immature window plus any gaps in mature portion
      if (decision.refetchWindow) {
        // If there are also mature gaps, extend to cover them
        if (coverage.missingMatureDates.length > 0) {
          const sortedMature = [...coverage.missingMatureDates].sort();
          const earliestMissing = sortedMature[0];
          
          // Extend window to include mature gaps
          const immatureStart = parseDate(decision.refetchWindow.start);
          const gapStart = parseDate(earliestMissing);
          
          if (gapStart.getTime() < immatureStart.getTime()) {
            return {
              start: earliestMissing,
              end: decision.refetchWindow.end,
            };
          }
        }
        return decision.refetchWindow;
      }
      return requestedWindow;
      
    case 'replace_slice':
      // Full window fetch for cohort replacement
      return requestedWindow;
      
    default:
      return requestedWindow;
  }
}

