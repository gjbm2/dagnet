/**
 * Cohort Retrieval Horizon Helper
 * 
 * Computes bounded cohort retrieval windows based on t95/path_t95.
 * 
 * Design reference: retrieval-date-logic-implementation-plan.md §6
 * 
 * Key responsibilities:
 * - Compute maximum look-back for cohort entry dates based on path_t95
 * - Derive bounded retrieval windows that don't fetch unnecessarily old cohorts
 * - Never widen the user's DSL window, only potentially narrow it
 * - Separate missing cohorts from stale/refreshable cohorts
 * 
 * This is a pure helper module - no side effects, no state.
 */

import type { DateRange } from '../types';
import { parseDate, normalizeDate } from './windowAggregationService';
import type { ParameterValue } from '../types/parameterData';
import {
  COHORT_HORIZON_MIN_DAYS,
  COHORT_HORIZON_BUFFER_DAYS,
  DEFAULT_T95_DAYS,
} from '../constants/latency';

// =============================================================================
// Types
// =============================================================================

export interface CohortHorizonInput {
  /** The user's requested cohort window from DSL */
  requestedWindow: DateRange;
  
  /** Edge-level t95 (persisted, from CDF fitting) */
  edgeT95?: number;
  
  /** Path-level t95 (cumulative from anchor, computed on-demand) */
  pathT95?: number;
  
  /** Reference date for horizon calculations (defaults to today) */
  referenceDate?: Date;
  
  /** Existing coverage dates in the parameter file (for incremental decisions) */
  existingCoverage?: {
    /** Dates already covered in file */
    dates: string[];
    /** When the existing data was retrieved */
    retrievedAt?: string;
  };
}

export interface CohortHorizonResult {
  /** Original cohort window from DSL (unchanged) */
  originalWindow: DateRange;
  
  /** Recommended bounded retrieval window */
  boundedWindow: DateRange;
  
  /** Whether the window was bounded (narrowed from original) */
  wasBounded: boolean;
  
  /** Effective t95 used for horizon calculation */
  effectiveT95: number;
  
  /** Source of effective t95 */
  t95Source: 'path_t95' | 'edge_t95' | 'default';
  
  /** Days trimmed from the start of the original window */
  daysTrimmed: number;
  
  /** Classification of cohorts within the bounded window */
  cohortClassification: {
    /** Strictly missing: never fetched, must fetch now */
    missingCount: number;
    /** Stale: covered but retrieved when immature, may benefit from refresh */
    staleCount: number;
    /** Stable: covered and mature beyond horizon */
    stableCount: number;
  };
  
  /** Human-readable summary for logging */
  summary: string;
}

// =============================================================================
// Constants
// =============================================================================

// Re-export for local use with shorter names
const DEFAULT_HORIZON_DAYS = DEFAULT_T95_DAYS;
const MIN_HORIZON_DAYS = COHORT_HORIZON_MIN_DAYS;
const HORIZON_BUFFER_DAYS = COHORT_HORIZON_BUFFER_DAYS;

// =============================================================================
// Main Helper Function
// =============================================================================

/**
 * Compute bounded cohort retrieval window based on t95/path_t95.
 * 
 * The core insight is that cohorts older than `path_t95` days from today
 * are "mature" - they've had enough time to convert, so refetching them
 * won't materially change the data. We can skip fetching them unless they're
 * genuinely missing.
 * 
 * For cohort queries, we use `path_t95` (cumulative from anchor) because
 * downstream edges accumulate latency from all upstream edges.
 * 
 * @param input - Horizon calculation inputs
 * @returns Bounded window and classification
 */
export function computeCohortRetrievalHorizon(input: CohortHorizonInput): CohortHorizonResult {
  const {
    requestedWindow,
    edgeT95,
    pathT95,
    referenceDate = new Date(),
    existingCoverage,
  } = input;
  
  // Determine effective t95 with fallback chain
  const { effectiveT95, t95Source } = selectEffectiveT95(pathT95, edgeT95);
  
  // Add buffer and enforce minimum
  const horizonDays = Math.max(
    effectiveT95 + HORIZON_BUFFER_DAYS,
    MIN_HORIZON_DAYS
  );
  
  // Parse requested window dates
  const requestedStart = parseDate(requestedWindow.start);
  const requestedEnd = parseDate(requestedWindow.end);
  
  // Calculate horizon cutoff: cohorts older than this are "mature"
  // Horizon = referenceDate - horizonDays
  const horizonCutoffMs = referenceDate.getTime() - (horizonDays * 24 * 60 * 60 * 1000);
  const horizonCutoffDate = new Date(horizonCutoffMs);
  
  // FIRST-PRINCIPLES DESIGN: Never trim the start of the requested window.
  // 
  // The old logic tried to skip "mature" cohorts to save API calls, but this
  // caused missing data when files were cleared or incomplete. The correct
  // approach is to always fetch the full requested window.
  //
  // Staleness detection (for refresh recommendations) is handled separately
  // by the FetchPlan builder using shouldRefetch().
  const boundedStartMs = requestedStart.getTime();
  const boundedEndMs = requestedEnd.getTime();
  const wasBounded = false;
  const daysTrimmed = 0;
  
  // Build bounded window
  const boundedWindow: DateRange = {
    start: normalizeDate(new Date(boundedStartMs).toISOString()),
    end: normalizeDate(new Date(boundedEndMs).toISOString()),
  };
  
  // Classify cohorts within the bounded window
  const cohortClassification = classifyCohorts(
    boundedWindow,
    horizonCutoffDate,
    referenceDate,
    existingCoverage
  );
  
  // Build summary
  const summary = buildSummary(
    requestedWindow,
    boundedWindow,
    wasBounded,
    daysTrimmed,
    effectiveT95,
    t95Source,
    cohortClassification
  );
  
  return {
    originalWindow: requestedWindow,
    boundedWindow,
    wasBounded,
    effectiveT95,
    t95Source,
    daysTrimmed,
    cohortClassification,
    summary,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Select effective t95 with fallback chain.
 * Priority: path_t95 > edge_t95 > default
 */
function selectEffectiveT95(
  pathT95: number | undefined,
  edgeT95: number | undefined
): { effectiveT95: number; t95Source: CohortHorizonResult['t95Source'] } {
  if (pathT95 !== undefined && pathT95 > 0) {
    return { effectiveT95: pathT95, t95Source: 'path_t95' };
  }
  if (edgeT95 !== undefined && edgeT95 > 0) {
    return { effectiveT95: edgeT95, t95Source: 'edge_t95' };
  }
  return { effectiveT95: DEFAULT_HORIZON_DAYS, t95Source: 'default' };
}

/**
 * Classify cohorts within the bounded window.
 */
function classifyCohorts(
  boundedWindow: DateRange,
  horizonCutoff: Date,
  referenceDate: Date,
  existingCoverage?: CohortHorizonInput['existingCoverage']
): CohortHorizonResult['cohortClassification'] {
  const boundedStart = parseDate(boundedWindow.start);
  const boundedEnd = parseDate(boundedWindow.end);
  
  // Build set of existing coverage dates
  const coveredDates = new Set(
    (existingCoverage?.dates || []).map(d => normalizeDate(d))
  );
  
  // Parse retrieval timestamp if available
  let retrievedAtMs: number | undefined;
  if (existingCoverage?.retrievedAt) {
    retrievedAtMs = new Date(existingCoverage.retrievedAt).getTime();
  }
  
  let missingCount = 0;
  let staleCount = 0;
  let stableCount = 0;
  
  // Iterate through each day in bounded window
  const currentDate = new Date(boundedStart);
  while (currentDate <= boundedEnd) {
    const dateStr = normalizeDate(currentDate.toISOString());
    const dateMs = currentDate.getTime();
    
    if (!coveredDates.has(dateStr)) {
      // Not covered: missing
      missingCount++;
    } else {
      // Covered: check if stale or stable
      // A cohort is "stale" if it was retrieved before it had time to mature
      // (i.e., retrieved_at + horizon < now AND cohort_date + horizon > retrieved_at)
      if (retrievedAtMs !== undefined) {
        const cohortMatureByMs = dateMs + (horizonCutoff.getTime() - referenceDate.getTime());
        
        if (cohortMatureByMs > retrievedAtMs) {
          // Cohort was immature when retrieved - it's stale
          staleCount++;
        } else {
          // Cohort was mature when retrieved - it's stable
          stableCount++;
        }
      } else {
        // No retrieval timestamp: assume stable (conservative)
        stableCount++;
      }
    }
    
    // CRITICAL: Use UTC iteration to avoid DST/local-time drift across long ranges.
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }
  
  return { missingCount, staleCount, stableCount };
}

/**
 * Build human-readable summary for logging.
 */
function buildSummary(
  originalWindow: DateRange,
  boundedWindow: DateRange,
  wasBounded: boolean,
  daysTrimmed: number,
  effectiveT95: number,
  t95Source: CohortHorizonResult['t95Source'],
  classification: CohortHorizonResult['cohortClassification']
): string {
  const parts: string[] = [];
  
  if (wasBounded) {
    parts.push(`Bounded from ${originalWindow.start}:${originalWindow.end} to ${boundedWindow.start}:${boundedWindow.end}`);
    parts.push(`(trimmed ${daysTrimmed}d using ${t95Source}=${effectiveT95.toFixed(1)}d)`);
  } else {
    parts.push(`Using full window ${originalWindow.start}:${originalWindow.end}`);
    parts.push(`(within ${t95Source}=${effectiveT95.toFixed(1)}d horizon)`);
  }
  
  const { missingCount, staleCount, stableCount } = classification;
  if (missingCount > 0 || staleCount > 0) {
    parts.push(`[${missingCount} missing, ${staleCount} stale, ${stableCount} stable]`);
  }
  
  return parts.join(' ');
}

// =============================================================================
// Convenience: Get effective t95 for an edge
// =============================================================================

/**
 * Get the effective t95 for cohort horizon calculations.
 * 
 * @param edge - Graph edge with latency config
 * @param computedPathT95 - Optionally pre-computed path_t95
 * @returns Effective t95 and its source
 */
export function getEffectiveT95ForCohort(
  edge: { p?: { latency?: { t95?: number; path_t95?: number } } },
  computedPathT95?: number
): { effectiveT95: number; source: CohortHorizonResult['t95Source'] } {
  const latency = edge?.p?.latency;
  const pathT95 = computedPathT95 ?? latency?.path_t95;
  const edgeT95 = latency?.t95;
  
  const { effectiveT95, t95Source } = selectEffectiveT95(pathT95, edgeT95);
  return { effectiveT95, source: t95Source };
}

