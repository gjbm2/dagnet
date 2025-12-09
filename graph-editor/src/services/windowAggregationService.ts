/**
 * Window Aggregation Service
 * 
 * Aggregates daily time-series data (n_daily, k_daily) into aggregate statistics
 * for a given date window. Used when user selects a date range in WindowSelector.
 * 
 * Also provides incremental fetching utilities to avoid re-fetching existing data.
 * 
 * Architecture:
 *   Parameter File (n_daily/k_daily/dates) → WindowAggregationService → Aggregate (n, k, mean, stdev)
 */

import type { TimeSeriesPoint, DateRange } from '../types';
import type { ParameterValue } from './paramRegistryService';
import { isolateSlice, hasContextAny, expandContextAny, extractSliceDimensions } from './sliceIsolation';
import { parseConstraints } from '../lib/queryDSL';
import { normalizeToUK, isUKDate, parseUKDate } from '../lib/dateFormat';
// LAG: Import statistical enhancement for forecast recomputation on merge
import type { CohortData, EdgeLatencyStats } from './statisticalEnhancementService';
import { computeEdgeLatencyStats } from './statisticalEnhancementService';

export interface RawAggregation {
  method: 'naive';
  n: number;
  k: number;
  mean: number;
  stdev: number;
  raw_data: TimeSeriesPoint[];
  window: DateRange;
  days_included: number;
  days_missing: number;
  /** Specific dates that are missing from the requested window */
  missing_dates: string[];
  /** Information about gaps in the data (consecutive missing dates) */
  gaps: Array<{
    start: string; // First missing date in gap
    end: string;   // Last missing date in gap
    length: number; // Number of consecutive missing days
  }>;
  /** Whether data is missing at the beginning of the window */
  missing_at_start: boolean;
  /** Whether data is missing at the end of the window */
  missing_at_end: boolean;
  /** Whether there are gaps in the middle of the window */
  has_middle_gaps: boolean;
}

/**
 * Case schedule entry (from case file schema)
 */
export interface CaseSchedule {
  window_from: string;  // UK format (d-MMM-yy)
  window_to?: string | null;  // ISO timestamp or YYYY-MM-DD, or null if ongoing
  variants: Array<{
    name: string;
    weight: number;
    description?: string;
  }>;
}

/**
 * Aggregated case variant weights for a window
 * Similar to RawAggregation but for case schedules
 */
export interface RawCaseAggregation {
  method: 'time-weighted' | 'simple-latest' | 'latest-fallback';
  variants: Array<{
    name: string;
    weight: number;
  }>;
  window: DateRange;
  schedules_included: number;
  /** Original schedules that contributed to this aggregation */
  raw_schedules: CaseSchedule[];
  /** Coverage information (for incomplete data warnings) */
  coverage?: {
    /** Percentage of window covered by schedules (0.0 to 1.0) */
    coverage_pct: number;
    /** Milliseconds of window covered by schedules */
    covered_duration_ms: number;
    /** Total window duration in milliseconds */
    total_duration_ms: number;
    /** Whether window has complete coverage */
    is_complete: boolean;
    /** Whether we fell back to latest schedule (no schedules in window) */
    used_fallback: boolean;
    /** Human-readable message about coverage */
    message: string;
  };
}

/**
 * Result of incremental fetch calculation
 */
export interface IncrementalFetchResult {
  /** Dates that already exist in parameter file */
  existingDates: Set<string>;
  /** Dates that need to be fetched */
  missingDates: string[];
  /** Array of contiguous gaps, each requiring a separate fetch */
  fetchWindows: DateRange[];
  /** Single combined window (for backward compatibility) - spans all missing dates */
  fetchWindow: DateRange | null;
  /** Whether any fetching is needed */
  needsFetch: boolean;
  /** Total days in requested window */
  totalDays: number;
  /** Days already available */
  daysAvailable: number;
  /** Days that need fetching */
  daysToFetch: number;
}

/**
 * Check whether a given requested window is fully covered by previously
 * fetched slices in the appropriate slice family, based on slice header
 * date ranges (window_from/window_to or cohort_from/cohort_to) and
 * context/case dimensions.
 *
 * This is used to drive **auto-fetch behaviour** (read-from-cache vs
 * show Fetch button), and therefore:
 *
 * - Considers **only** slice header ranges for coverage.
 * - Enforces context / MECE semantics via slice isolation.
 * - Ignores maturity, sparsity, and per-day n_daily/k_daily gaps.
 */
export function hasFullSliceCoverageByHeader(
  paramFileData: { values?: ParameterValue[] },
  requestedWindow: DateRange,
  targetSlice: string,
): boolean {
  const values = paramFileData.values ?? [];
  if (values.length === 0) return false;

  const wantsCohort = targetSlice.includes('cohort(');
  const wantsWindow = targetSlice.includes('window(');

  // Normalise requested window to UK dates for comparison
  const queryStart = normalizeDate(requestedWindow.start);
  const queryEnd = normalizeDate(requestedWindow.end);
  const queryStartDate = parseDate(queryStart);
  const queryEndDate = parseDate(queryEnd);

  const coversWindow = (slice: ParameterValue): boolean => {
    // Choose appropriate header fields based on query mode
    let sliceStartRaw: string | undefined | null;
    let sliceEndRaw: string | undefined | null;

    if (wantsCohort) {
      sliceStartRaw = (slice as any).cohort_from ?? (slice as any).window_from;
      sliceEndRaw = (slice as any).cohort_to ?? (slice as any).window_to;
    } else if (wantsWindow) {
      sliceStartRaw = (slice as any).window_from ?? (slice as any).cohort_from;
      sliceEndRaw = (slice as any).window_to ?? (slice as any).cohort_to;
    } else {
      // Fallback: treat as window-style coverage using whatever headers exist
      sliceStartRaw = (slice as any).window_from ?? (slice as any).cohort_from;
      sliceEndRaw = (slice as any).window_to ?? (slice as any).cohort_to;
    }

    if (!sliceStartRaw || !sliceEndRaw) {
      // If no header dates, we cannot assert coverage based on headers alone.
      return false;
    }

    const sliceStart = normalizeDate(String(sliceStartRaw));
    const sliceEnd = normalizeDate(String(sliceEndRaw));
    const sliceStartDate = parseDate(sliceStart);
    const sliceEndDate = parseDate(sliceEnd);

    // Coverage: query window is entirely inside slice header range
    return sliceStartDate <= queryStartDate && sliceEndDate >= queryEndDate;
  };

  // Detect MECE scenario: uncontexted query, file has only contexted data
  const normalizedTarget = extractSliceDimensions(targetSlice);
  const hasContextedData = values.some(v => {
    const id = extractSliceDimensions(v.sliceDSL ?? '');
    return id !== '';
  });
  const hasUncontextedData = values.some(v => {
    const id = extractSliceDimensions(v.sliceDSL ?? '');
    return id === '';
  });

  if (normalizedTarget === '' && hasContextedData && !hasUncontextedData) {
    // MECE aggregation: uncontexted query over contexted-only file.
    // Coverage requires ALL component slices to cover the requested window.
    const uniqueSlices = new Set<string>();
    for (const value of values) {
      const sliceId = extractSliceDimensions(value.sliceDSL ?? '');
      if (sliceId) uniqueSlices.add(sliceId);
    }

    // For each MECE slice, require at least one header that covers the window
    for (const sliceId of uniqueSlices) {
      const sliceValues = values.filter(v => extractSliceDimensions(v.sliceDSL ?? '') === sliceId);

      // Filter by slice type where possible
      const typeFiltered = sliceValues.filter(v => {
        const dsl = v.sliceDSL ?? '';
        if (wantsCohort) return dsl.includes('cohort(');
        if (wantsWindow) return dsl.includes('window(');
        return true;
      });

      const anyCovering = typeFiltered.some(coversWindow);
      if (!anyCovering) {
        return false;
      }
    }

    return uniqueSlices.size > 0;
  }

  // Standard slice family coverage:
  // - For contexted queries, isolate to that slice family.
  // - For contextAny, isolateSlice already returns union of matching slices.
  const sliceValues = isolateSlice(values, targetSlice);

  if (sliceValues.length === 0) {
    return false;
  }

  // Filter by slice type where possible
  const typeFiltered = sliceValues.filter(v => {
    const dsl = v.sliceDSL ?? '';
    if (wantsCohort) return dsl.includes('cohort(');
    if (wantsWindow) return dsl.includes('window(');
    return true;
  });

  if (typeFiltered.length === 0) {
    return false;
  }

  // Coverage if ANY header in the family fully contains the requested window
  return typeFiltered.some(coversWindow);
}

/**
 * Convert parameter file format (n_daily, k_daily, dates arrays) to TimeSeriesPoint[]
 */
export function parameterToTimeSeries(
  n_daily: number[] | undefined,
  k_daily: number[] | undefined,
  dates: string[] | undefined
): TimeSeriesPoint[] {
  if (!n_daily || !k_daily || !dates) {
    return [];
  }

  if (n_daily.length !== k_daily.length || n_daily.length !== dates.length) {
    throw new Error('n_daily, k_daily, and dates arrays must have the same length');
  }

  return n_daily.map((n, i) => ({
    date: dates[i],
    n,
    k: k_daily[i],
    p: n > 0 ? k_daily[i] / n : 0,
  }));
}

/**
 * Parse date string (YYYY-MM-DD, ISO 8601, or UK format) to Date for comparison
 * Handles hybrid formats like "1-Dec-25T00:00:00Z" (UK date with ISO time suffix)
 */
export function parseDate(dateStr: string): Date {
  // Strip time portion for UK format detection (handles hybrid like "1-Dec-25T00:00:00Z")
  const datePart = dateStr.split('T')[0];
  
  // Handle UK format (d-MMM-yy) first
  if (isUKDate(datePart)) {
    return parseUKDate(datePart);
  }
  
  // Handle ISO 8601 (with time) or YYYY-MM-DD
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date format: ${dateStr}`);
  }
  return date;
}

/**
 * Normalize date string to YYYY-MM-DD format
 */
/**
 * Normalize a date string to a consistent format for comparisons.
 * Returns UK format (d-MMM-yy) for all inputs.
 * 
 * @param dateStr - Date in any recognized format (ISO, UK, etc.)
 * @returns Normalized date string in UK format
 */
export function normalizeDate(dateStr: string): string {
  const date = parseDate(dateStr);
  // Return UK format for consistent storage and display
  return normalizeToUK(date.toISOString().split('T')[0]);
}

/**
 * Check if a date is within a range (inclusive)
 */
export function isDateInRange(date: string, range: DateRange): boolean {
  const dateObj = parseDate(date);
  const start = parseDate(range.start);
  const end = parseDate(range.end);
  
  // Normalize to start of day for comparison
  const dateDay = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  
  return dateDay >= startDay && dateDay <= endDay;
}

/**
 * Calculate standard deviation for binomial distribution
 * Formula: sqrt(p * (1-p) / n) where p = k/n
 */
function calculateStdev(n: number, k: number): number {
  if (n === 0) {
    return 0;
  }
  const p = k / n;
  if (p === 0 || p === 1) {
    return 0;
  }
  return Math.sqrt((p * (1 - p)) / n);
}

/**
 * Aggregate time-series data for a given window
 */
export class WindowAggregationService {
  /**
   * Get case variant weights for a window (Phase 1: Simple - most recent schedule)
   * 
   * @param schedules Array of case schedules from case file
   * @param window Date range (optional - if not provided, returns latest)
   * @returns Aggregated variant weights
   */
  getCaseWeightsForWindow(
    schedules: CaseSchedule[],
    window?: DateRange
  ): RawCaseAggregation {
    if (!schedules || schedules.length === 0) {
      return {
        method: 'simple-latest',
        variants: [],
        window: window || { start: '', end: '' },
        schedules_included: 0,
        raw_schedules: []
      };
    }

    // If no window specified, return most recent schedule
    if (!window) {
      const latest = schedules[schedules.length - 1];
      return {
        method: 'simple-latest',
        variants: latest.variants.map(v => ({ name: v.name, weight: v.weight })),
        window: {
          start: latest.window_from,
          end: latest.window_to || new Date().toISOString()
        },
        schedules_included: 1,
        raw_schedules: [latest]
      };
    }

    // Filter schedules that overlap with the requested window
    const relevantSchedules = this.filterSchedulesForWindow(schedules, window);

    if (relevantSchedules.length === 0) {
      // No schedules in window, return empty
      return {
        method: 'simple-latest',
        variants: [],
        window,
        schedules_included: 0,
        raw_schedules: []
      };
    }

    // Phase 1: Return most recent schedule in window
    const latest = relevantSchedules[relevantSchedules.length - 1];
    return {
      method: 'simple-latest',
      variants: latest.variants.map(v => ({ name: v.name, weight: v.weight })),
      window,
      schedules_included: relevantSchedules.length,
      raw_schedules: relevantSchedules
    };
  }

  /**
   * Aggregate case schedules for a window (Phase 2: Time-weighted averaging)
   * 
   * Handles incomplete data gracefully:
   * - If window has no schedules but file has schedules: fall back to latest schedule with warning
   * - If window has partial coverage: show coverage percentage
   * 
   * @param schedules Array of case schedules from case file
   * @param window Date range to aggregate
   * @returns Time-weighted average of variant weights with coverage metadata
   */
  aggregateCaseSchedulesForWindow(
    schedules: CaseSchedule[],
    window: DateRange
  ): RawCaseAggregation {
    if (!schedules || schedules.length === 0) {
      return {
        method: 'time-weighted',
        variants: [],
        window,
        schedules_included: 0,
        raw_schedules: [],
        coverage: {
          coverage_pct: 0,
          covered_duration_ms: 0,
          total_duration_ms: 0,
          is_complete: false,
          used_fallback: false,
          message: 'No schedules available'
        }
      };
    }

    const relevantSchedules = this.filterSchedulesForWindow(schedules, window);

    // Fall back to latest schedule if window has no data
    if (relevantSchedules.length === 0) {
      const latest = schedules[schedules.length - 1];
      const windowStart = parseDate(window.start);
      const windowEnd = parseDate(window.end);
      const totalDurationMs = windowEnd.getTime() - windowStart.getTime();
      
      return {
        method: 'latest-fallback',
        variants: latest.variants.map(v => ({ name: v.name, weight: v.weight })),
        window,
        schedules_included: 0,
        raw_schedules: [latest],
        coverage: {
          coverage_pct: 0,
          covered_duration_ms: 0,
          total_duration_ms: totalDurationMs,
          is_complete: false,
          used_fallback: true,
          message: `⚠️ No schedules in window. Using latest schedule (from ${latest.window_from}) as fallback.`
        }
      };
    }

    // Calculate window duration and coverage
    const windowStart = parseDate(window.start);
    const windowEnd = parseDate(window.end);
    const windowDurationMs = windowEnd.getTime() - windowStart.getTime();
    
    // If only one schedule, no need for time-weighting
    if (relevantSchedules.length === 1) {
      const schedule = relevantSchedules[0];
      
      // Calculate coverage for this single schedule
      const scheduleStart = Math.max(
        parseDate(schedule.window_from).getTime(),
        windowStart.getTime()
      );
      let scheduleEnd: number;
      if (schedule.window_to && schedule.window_to !== null) {
        scheduleEnd = Math.min(
          parseDate(schedule.window_to).getTime(),
          windowEnd.getTime()
        );
      } else {
        scheduleEnd = windowEnd.getTime();
      }
      const coveredDurationMs = Math.max(0, scheduleEnd - scheduleStart);
      const coveragePct = windowDurationMs > 0 ? coveredDurationMs / windowDurationMs : 0;
      const isComplete = coveragePct >= 0.99; // Consider >99% as complete (rounding tolerance)
      
      return {
        method: 'time-weighted',
        variants: schedule.variants.map(v => ({ name: v.name, weight: v.weight })),
        window,
        schedules_included: 1,
        raw_schedules: relevantSchedules,
        coverage: {
          coverage_pct: coveragePct,
          covered_duration_ms: coveredDurationMs,
          total_duration_ms: windowDurationMs,
          is_complete: isComplete,
          used_fallback: false,
          message: isComplete 
            ? '✓ Complete coverage'
            : `⚠️ Partial coverage: ${(coveragePct * 100).toFixed(0)}% of window`
        }
      };
    }

    // Collect all variant names
    const variantNames = new Set<string>();
    relevantSchedules.forEach(schedule => {
      schedule.variants.forEach(v => variantNames.add(v.name));
    });

    // Calculate time-weighted average for each variant AND track coverage
    let totalCoveredDuration = 0;
    
    const aggregatedVariants = Array.from(variantNames).map(variantName => {
      let totalWeight = 0;
      let totalDuration = 0;

      relevantSchedules.forEach((schedule, index) => {
        // Determine the effective start/end for this schedule within the window
        const scheduleStart = Math.max(
          parseDate(schedule.window_from).getTime(),
          windowStart.getTime()
        );

        let scheduleEnd: number;
        if (schedule.window_to && schedule.window_to !== null) {
          scheduleEnd = Math.min(
            parseDate(schedule.window_to).getTime(),
            windowEnd.getTime()
          );
        } else {
          // Schedule is ongoing - use next schedule's start or window end
          if (index < relevantSchedules.length - 1) {
            scheduleEnd = Math.min(
              parseDate(relevantSchedules[index + 1].window_from).getTime(),
              windowEnd.getTime()
            );
          } else {
            scheduleEnd = windowEnd.getTime();
          }
        }

        const duration = scheduleEnd - scheduleStart;
        if (duration > 0) {
          const variant = schedule.variants.find(v => v.name === variantName);
          const weight = variant?.weight || 0;
          
          totalWeight += weight * duration;
          totalDuration += duration;
        }
      });

      // Track total covered duration (only count once, not per variant)
      if (variantNames.size > 0 && variantNames.values().next().value === variantName) {
        totalCoveredDuration = totalDuration;
      }

      const avgWeight = totalDuration > 0 ? totalWeight / totalDuration : 0;
      return { name: variantName, weight: avgWeight };
    });

    // Calculate coverage
    const coveragePct = windowDurationMs > 0 ? totalCoveredDuration / windowDurationMs : 0;
    const isComplete = coveragePct >= 0.99; // Consider >99% as complete (rounding tolerance)

    return {
      method: 'time-weighted',
      variants: aggregatedVariants,
      window,
      schedules_included: relevantSchedules.length,
      raw_schedules: relevantSchedules,
      coverage: {
        coverage_pct: coveragePct,
        covered_duration_ms: totalCoveredDuration,
        total_duration_ms: windowDurationMs,
        is_complete: isComplete,
        used_fallback: false,
        message: isComplete 
          ? '✓ Complete coverage'
          : `⚠️ Partial coverage: ${(coveragePct * 100).toFixed(0)}% of window (${relevantSchedules.length} schedule${relevantSchedules.length > 1 ? 's' : ''})`
      }
    };
  }

  /**
   * Filter schedules that overlap with a given window
   */
  private filterSchedulesForWindow(
    schedules: CaseSchedule[],
    window: DateRange
  ): CaseSchedule[] {
    const windowStart = parseDate(window.start);
    const windowEnd = parseDate(window.end);

    return schedules.filter(schedule => {
      const scheduleStart = parseDate(schedule.window_from);
      
      // Determine schedule end
      let scheduleEnd: Date;
      if (schedule.window_to && schedule.window_to !== null) {
        scheduleEnd = parseDate(schedule.window_to);
      } else {
        // Ongoing schedule - use current time
        scheduleEnd = new Date();
      }

      // Check for overlap: schedule overlaps window if:
      // scheduleStart <= windowEnd AND scheduleEnd >= windowStart
      return scheduleStart <= windowEnd && scheduleEnd >= windowStart;
    });
  }

  /**
   * Aggregate daily data for a date window
   * 
   * @param timeSeries Array of daily data points
   * @param window Date range to aggregate
   * @returns Aggregated statistics (naive pooling - sum n and k)
   */
  aggregateWindow(
    timeSeries: TimeSeriesPoint[],
    window: DateRange
  ): RawAggregation {
    // Normalize window dates
    const normalizedWindow: DateRange = {
      start: normalizeDate(window.start),
      end: normalizeDate(window.end),
    };

    // Filter to window
    const filtered = timeSeries.filter((point) =>
      isDateInRange(point.date, normalizedWindow)
    );

    if (filtered.length === 0) {
      throw new Error(
        `No data available for window ${normalizedWindow.start} to ${normalizedWindow.end}`
      );
    }

    // Calculate total days in window
    const startDate = parseDate(normalizedWindow.start);
    const endDate = parseDate(normalizedWindow.end);
    const daysInWindow = Math.floor(
      (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)
    ) + 1;

    // Generate all expected dates in the window
    const expectedDates: string[] = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      expectedDates.push(normalizeDate(currentDate.toISOString()));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Create a set of available dates for quick lookup
    const availableDates = new Set(filtered.map(p => normalizeDate(p.date)));

    // Find missing dates
    const missingDates = expectedDates.filter(date => !availableDates.has(date));

    // Identify gaps (consecutive missing dates)
    const gaps: Array<{ start: string; end: string; length: number }> = [];
    if (missingDates.length > 0) {
      let gapStart = missingDates[0];
      let gapEnd = gapStart;
      
      for (let i = 1; i < missingDates.length; i++) {
        const currentDate = parseDate(missingDates[i]);
        const prevDate = parseDate(missingDates[i - 1]);
        const daysDiff = Math.floor(
          (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
        );
        
        if (daysDiff === 1) {
          // Consecutive date - extend current gap
          gapEnd = missingDates[i];
        } else {
          // Gap ended - save it and start a new one
          const gapLength = Math.floor(
            (parseDate(gapEnd).getTime() - parseDate(gapStart).getTime()) / (1000 * 60 * 60 * 24)
          ) + 1;
          gaps.push({
            start: gapStart,
            end: gapEnd,
            length: gapLength,
          });
          gapStart = missingDates[i];
          gapEnd = gapStart;
        }
      }
      
      // Don't forget the last gap
      const gapLength = Math.floor(
        (parseDate(gapEnd).getTime() - parseDate(gapStart).getTime()) / (1000 * 60 * 60 * 24)
      ) + 1;
      gaps.push({
        start: gapStart,
        end: gapEnd,
        length: gapLength,
      });
    }

    // Check for missing dates at start/end
    const missingAtStart = missingDates.length > 0 && missingDates[0] === expectedDates[0];
    const missingAtEnd = missingDates.length > 0 && missingDates[missingDates.length - 1] === expectedDates[expectedDates.length - 1];
    
    // Check for middle gaps (gaps that don't start at the beginning or end)
    const hasMiddleGaps = gaps.some(gap => 
      gap.start !== expectedDates[0] && gap.end !== expectedDates[expectedDates.length - 1]
    );

    // Naive aggregation: sum n and k
    const totalN = filtered.reduce((sum, point) => sum + point.n, 0);
    const totalK = filtered.reduce((sum, point) => sum + point.k, 0);

    // Calculate mean (p = k/n) with sufficient precision for calculations
    const mean = totalN > 0 ? totalK / totalN : 0;

    // Calculate standard deviation (binomial)
    const stdev = calculateStdev(totalN, totalK);

    return {
      method: 'naive',
      n: totalN,
      k: totalK,
      mean,
      stdev,
      raw_data: filtered,
      window: normalizedWindow,
      days_included: filtered.length,
      days_missing: missingDates.length,
      missing_dates: missingDates,
      gaps,
      missing_at_start: missingAtStart,
      missing_at_end: missingAtEnd,
      has_middle_gaps: hasMiddleGaps,
    };
  }

  /**
   * Aggregate from parameter file format (n_daily, k_daily, dates)
   */
  aggregateFromParameter(
    n_daily: number[] | undefined,
    k_daily: number[] | undefined,
    dates: string[] | undefined,
    window: DateRange
  ): RawAggregation {
    const timeSeries = parameterToTimeSeries(n_daily, k_daily, dates);
    return this.aggregateWindow(timeSeries, window);
  }
}

/**
 * Calculate which dates need to be fetched incrementally
 * 
 * Checks existing parameter file values for daily data and determines
 * which dates in the requested window are missing.
 * 
 * @param paramFileData Parameter file data (with values[] array)
 * @param requestedWindow Date range requested for fetching
 * @param querySignature Optional: only consider values with matching query signature
 * @param bustCache If true, ignore existing dates and return all dates as missing
 * @returns Incremental fetch result with missing dates and reduced window
 */
export function calculateIncrementalFetch(
  paramFileData: { values?: ParameterValue[] },
  requestedWindow: DateRange,
  querySignature?: string,
  bustCache: boolean = false,
  targetSlice: string = ''  // NEW: Slice DSL to isolate (default '' = uncontexted)
): IncrementalFetchResult {
  // Normalize requested window dates
  const normalizedWindow: DateRange = {
    start: normalizeDate(requestedWindow.start),
    end: normalizeDate(requestedWindow.end),
  };

  // Generate all dates in requested window (needed for both paths)
  const startDate = parseDate(normalizedWindow.start);
  const endDate = parseDate(normalizedWindow.end);
  const allDatesInWindow: string[] = [];
  
  const currentDateIter = new Date(startDate);
  while (currentDateIter <= endDate) {
    const dateStr = normalizeDate(currentDateIter.toISOString());
    allDatesInWindow.push(dateStr);
    currentDateIter.setDate(currentDateIter.getDate() + 1);
  }

  // FAST PATH: Check if any matching slice has AGGREGATE values (mean, n)
  // If a slice has aggregate values, we don't need daily data - data is "available".
  // IMPORTANT: If slice isolation fails (e.g. uncontexted query on contexted-only file),
  // we SKIP this fast path and fall back to the full MECE / incremental logic below.
  // CRITICAL: Also verify the slice's date range overlaps with the requested window!
  // Otherwise we'd incorrectly report "data available" for dates outside the cached range.
  if (!bustCache && paramFileData.values && Array.isArray(paramFileData.values)) {
    try {
      const sliceValues = isolateSlice(paramFileData.values, targetSlice);
      
      // Check if any slice has aggregate data AND covers the requested window
      const hasAggregateDataWithCoverage = sliceValues.some(v => {
        // Must have aggregate values
        const hasAggregate = v.mean !== undefined && v.mean !== null && 
          (v.n !== undefined || (v as any).evidence?.n !== undefined);
        if (!hasAggregate) return false;
        
        // Must have date coverage that overlaps with requested window
        // Check window_from/window_to or cohort_from/cohort_to
        const sliceStart = v.window_from || v.cohort_from;
        const sliceEnd = v.window_to || v.cohort_to;
        
        if (!sliceStart || !sliceEnd) {
          // No date range info - check if dates array covers the window
          if (v.dates && Array.isArray(v.dates) && v.dates.length > 0) {
            const sliceDates = new Set(v.dates.map((d: string) => normalizeDate(d)));
            // Check if ANY of the requested dates are in the slice
            const hasOverlap = allDatesInWindow.some(reqDate => sliceDates.has(reqDate));
            return hasOverlap;
          }
          // No date information at all - can't verify coverage, skip fast path
          return false;
        }
        
        // Check if windows overlap
        const reqStart = parseDate(normalizedWindow.start);
        const reqEnd = parseDate(normalizedWindow.end);
        const sStart = parseDate(sliceStart);
        const sEnd = parseDate(sliceEnd);
        
        // Windows overlap if: reqStart <= sEnd AND reqEnd >= sStart
        const overlaps = reqStart <= sEnd && reqEnd >= sStart;
        return overlaps;
      });
      
      if (hasAggregateDataWithCoverage) {
        console.log(`[calculateIncrementalFetch] FAST PATH: Found aggregate data with coverage for slice`, {
          targetSlice,
          matchingSlicesCount: sliceValues.length,
        });
        // Data available - no fetch needed
        return {
          existingDates: new Set(allDatesInWindow),
          missingDates: [],
          fetchWindows: [],
          fetchWindow: null,
          needsFetch: false,
          totalDays: allDatesInWindow.length,
          daysAvailable: allDatesInWindow.length,
          daysToFetch: 0,
        };
      }
    } catch (error) {
      console.warn('[calculateIncrementalFetch] FAST PATH slice isolation failed, falling back to full path:', error);
      // Continue to full incremental/MECE logic
    }
  }

  // Extract all existing dates from parameter file values
  const existingDates = new Set<string>();
  let missingDates: string[];
  
  // If bustCache is true, skip checking existing dates
  if (!bustCache && paramFileData.values && Array.isArray(paramFileData.values)) {
    // Check for contextAny: need to verify ALL component slices have data
    if (hasContextAny(targetSlice)) {
      const parsed = parseConstraints(targetSlice);
      const expandedSlices = expandContextAny(parsed);
      
      // For contextAny, a date is "existing" only if it exists in ALL component slices
      // (i.e., we need complete coverage across all slices)
      const datesPerSlice: Map<string, Set<string>> = new Map();
      
      for (const sliceId of expandedSlices) {
        const sliceDates = new Set<string>();
        // Filter values matching this specific slice
        const sliceValues = paramFileData.values.filter(v => {
          const valueSlice = extractSliceDimensions(v.sliceDSL ?? '');
          return valueSlice === sliceId;
        });
        
        for (const value of sliceValues) {
          if (value.dates && Array.isArray(value.dates)) {
            for (const date of value.dates) {
              sliceDates.add(normalizeDate(date));
            }
          }
        }
        datesPerSlice.set(sliceId, sliceDates);
      }
      
      // A date exists only if ALL slices have it
      for (const date of allDatesInWindow) {
        const allSlicesHaveDate = expandedSlices.every(sliceId => {
          const sliceDates = datesPerSlice.get(sliceId);
          return sliceDates && sliceDates.has(date);
        });
        if (allSlicesHaveDate) {
          existingDates.add(date);
        }
      }
      
      console.log(`[calculateIncrementalFetch] contextAny expansion:`, {
        targetSlice,
        expandedSlices,
        sliceCoverage: Object.fromEntries(
          expandedSlices.map(s => [s, datesPerSlice.get(s)?.size ?? 0])
        ),
        datesWithFullCoverage: existingDates.size,
        totalDatesRequested: allDatesInWindow.length,
      });
    } else {
      // Standard path: single slice
      // Check if query has no context but file has ONLY contexted data (no uncontexted)
      // In that case, we need MECE aggregation across all contexted slices
      const normalizedTarget = extractSliceDimensions(targetSlice);
      const hasContextedData = paramFileData.values.some(v => v.sliceDSL && v.sliceDSL !== '');
      const hasUncontextedData = paramFileData.values.some(v => !v.sliceDSL || v.sliceDSL === '');
      
      if (normalizedTarget === '' && hasContextedData && !hasUncontextedData) {
        // Query has no context, but file has contexted data
        // Extract all unique slices from the file and check ALL have data (MECE aggregation)
        const uniqueSlices = new Set<string>();
        for (const value of paramFileData.values) {
          const sliceDSL = extractSliceDimensions(value.sliceDSL ?? '');
          if (sliceDSL) uniqueSlices.add(sliceDSL);
        }
        
        const expandedSlices = Array.from(uniqueSlices).sort();
        
        // For MECE, a date is "existing" only if it exists in ALL slices
        const datesPerSlice: Map<string, Set<string>> = new Map();
        
        for (const sliceId of expandedSlices) {
          const sliceDates = new Set<string>();
          const sliceValues = paramFileData.values.filter(v => {
            const valueSlice = extractSliceDimensions(v.sliceDSL ?? '');
            return valueSlice === sliceId;
          });
          
          for (const value of sliceValues) {
            // CRITICAL: Only count dates with VALID data (non-null n_daily/k_daily)
            if (value.dates && Array.isArray(value.dates)) {
              for (let i = 0; i < value.dates.length; i++) {
                const date = value.dates[i];
                const hasValidN = value.n_daily && value.n_daily[i] !== null && value.n_daily[i] !== undefined;
                const hasValidK = value.k_daily && value.k_daily[i] !== null && value.k_daily[i] !== undefined;
                
                if (hasValidN || hasValidK) {
                  sliceDates.add(normalizeDate(date));
                }
              }
            }
          }
          datesPerSlice.set(sliceId, sliceDates);
        }
        
        // A date exists only if ALL slices have it
        for (const date of allDatesInWindow) {
          const allSlicesHaveDate = expandedSlices.every(sliceId => {
            const sliceDates = datesPerSlice.get(sliceId);
            return sliceDates && sliceDates.has(date);
          });
          if (allSlicesHaveDate) {
            existingDates.add(date);
          }
        }
        
        console.log(`[calculateIncrementalFetch] MECE aggregation (uncontexted query with contexted data):`, {
          targetSlice,
          expandedSlices,
          sliceCoverage: Object.fromEntries(
            expandedSlices.map(s => [s, datesPerSlice.get(s)?.size ?? 0])
          ),
          datesWithFullCoverage: existingDates.size,
          totalDatesRequested: allDatesInWindow.length,
        });
      } else {
        // CRITICAL: Isolate to target slice first
        const sliceValues = isolateSlice(paramFileData.values, targetSlice);
        
        for (const value of sliceValues) {
          // Extract dates from this value entry
          // CRITICAL: Only count dates that have VALID data (non-null n_daily/k_daily)
          // Without this check, dates with null values would be counted as "cached"
          // and no fetch would be triggered, leaving graph with stale data
          if (value.dates && Array.isArray(value.dates)) {
            for (let i = 0; i < value.dates.length; i++) {
              const date = value.dates[i];
              // Check if this date has valid data
              const hasValidN = value.n_daily && value.n_daily[i] !== null && value.n_daily[i] !== undefined;
              const hasValidK = value.k_daily && value.k_daily[i] !== null && value.k_daily[i] !== undefined;
              
              if (hasValidN || hasValidK) {
                const normalizedDate = normalizeDate(date);
                existingDates.add(normalizedDate);
              }
            }
          }
        }
      }
    }
  }
  
  // Find missing dates (dates in requested window that don't exist)
  missingDates = allDatesInWindow.filter(date => !existingDates.has(date));
  
  // Debug logging for date comparison
  if (allDatesInWindow.length <= 7) {
    const existingDatesArray = Array.from(existingDates).sort();
    console.log(`[calculateIncrementalFetch] Window dates:`, {
      normalizedWindow,
      allDatesInWindow,
      existingDatesArray,
      existingDatesSize: existingDates.size,
      missingDates,
      // Check if dates match format
      firstRequestedDate: allDatesInWindow[0],
      lastRequestedDate: allDatesInWindow[allDatesInWindow.length - 1],
      firstExistingDate: existingDatesArray[0],
      lastExistingDate: existingDatesArray[existingDatesArray.length - 1],
      // Check if requested dates are in existing set
      firstRequestedInExisting: existingDates.has(allDatesInWindow[0]),
      lastRequestedInExisting: existingDates.has(allDatesInWindow[allDatesInWindow.length - 1]),
    });
    
    // Explicitly log the missing date
    if (missingDates.length > 0) {
      console.log(`[calculateIncrementalFetch] MISSING DATE: "${missingDates[0]}"`);
      console.log(`[calculateIncrementalFetch] Checking if missing date exists in file:`, {
        missingDate: missingDates[0],
        existsInSet: existingDates.has(missingDates[0]),
        allRequestedDates: allDatesInWindow,
        existingDatesSample: existingDatesArray.slice(0, 10),
      });
    }
  }

  // Count how many of the REQUESTED dates are available (not total dates in file)
  const daysAvailableInWindow = allDatesInWindow.filter(date => existingDates.has(date)).length;

  // Identify contiguous gaps (each gap requires a separate API request)
  const fetchWindows: DateRange[] = [];
  let fetchWindow: DateRange | null = null;
  
  if (missingDates.length > 0) {
    // Sort missing dates CHRONOLOGICALLY (not lexicographically!)
    // UK dates like "1-Nov-25", "10-Nov-25", "2-Nov-25" must be sorted by actual date
    const sortedMissing = [...missingDates].sort((a, b) => 
      parseDate(a).getTime() - parseDate(b).getTime()
    );
    
    // Helper: Convert UK format date (e.g., "1-Nov-25") to ISO format (e.g., "2025-11-01")
    // This is critical because the DAS adapter pre-request scripts expect ISO format dates
    const toISODate = (ukDate: string): string => {
      return parseDate(ukDate).toISOString().split('T')[0];
    };
    
    // Group into contiguous gaps
    let gapStart = sortedMissing[0];
    let gapEnd = gapStart;
    
    for (let i = 1; i < sortedMissing.length; i++) {
      const currentDate = parseDate(sortedMissing[i]);
      const prevDate = parseDate(sortedMissing[i - 1]);
      const daysDiff = Math.floor(
        (currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24)
      );
      
      if (daysDiff === 1) {
        // Consecutive date - extend current gap
        gapEnd = sortedMissing[i];
      } else {
        // Gap ended - save it and start a new one
        // CRITICAL: Convert to ISO format for DAS adapter compatibility
        fetchWindows.push({
          start: toISODate(gapStart) + 'T00:00:00Z',
          end: toISODate(gapEnd) + 'T23:59:59Z',
        });
        gapStart = sortedMissing[i];
        gapEnd = gapStart;
      }
    }
    
    // Don't forget the last gap
    // CRITICAL: Convert to ISO format for DAS adapter compatibility
    fetchWindows.push({
      start: toISODate(gapStart) + 'T00:00:00Z',
      end: toISODate(gapEnd) + 'T23:59:59Z',
    });
    
    // For backward compatibility, also provide single combined window
    // CRITICAL: Convert to ISO format for DAS adapter compatibility
    fetchWindow = {
      start: toISODate(sortedMissing[0]) + 'T00:00:00Z',
      end: toISODate(sortedMissing[sortedMissing.length - 1]) + 'T23:59:59Z',
    };
  }

  return {
    existingDates,
    missingDates,
    fetchWindows,
    fetchWindow,
    needsFetch: missingDates.length > 0,
    totalDays: allDatesInWindow.length,
    daysAvailable: daysAvailableInWindow, // Count of dates in requested window that exist
    daysToFetch: missingDates.length,
  };
}

/**
 * Extended time-series point with optional latency data (for cohort mode)
 */
export interface TimeSeriesPointWithLatency {
  date: string;
  n: number;
  k: number;
  p: number;
  median_lag_days?: number;  // For cohort mode: X→Y median lag
  mean_lag_days?: number;    // For cohort mode: X→Y mean lag
}

/**
 * Options for merging time-series data
 */
export interface MergeOptions {
  isCohortMode?: boolean;    // If true, use cohort_from/cohort_to instead of window_from/window_to
  latencySummary?: {         // Aggregate latency summary (for cohort mode)
    median_lag_days?: number;
    mean_lag_days?: number;
  };
  
  // === LAG: Latency configuration for forecast recomputation (design.md §3.2) ===
  latencyConfig?: {
    maturity_days?: number;   // Cohorts younger than this are "immature"
    anchor_node_id?: string;  // Anchor node for cohort queries
  };
  
  /** 
   * If true, recompute forecast (p_infinity) and latency scalars after merge.
   * Only applies to window mode with latencyConfig present.
   * When false, preserves existing forecast/latency on the slice.
   */
  recomputeForecast?: boolean;
}

/**
 * Merge new time-series data into a parameter's values array.
 * 
 * DESIGN ALIGNMENT:
 * - For `window()` slices (non-cohort mode), this function now performs a
 *   **canonical merge** for the target slice family (same context/case dims):
 *   - Dates from the new fetch REPLACE existing dates for that slice.
 *   - Dates outside the new window are preserved from existing data.
 *   - A SINGLE merged value entry is written for that slice family, with:
 *     - `dates[]`, `n_daily[]`, `k_daily[]` covering the full union of dates.
 *     - `window_from` / `window_to` set to `<earliest>:<latest>` (UK format).
 *     - `sliceDSL` canonicalised to `window(<earliest>:<latest>)[.context(...)]`.
 * 
 * - For `cohort()` slices (cohort mode), this function REPLACES the existing
 *   cohort slice for the same context/case dims:
 *   - Existing cohort-mode values for that dims are dropped.
 *   - A single new value entry is written with updated `cohort_from`/`cohort_to`.
 * 
 * - Values for OTHER slice families (different context/case dims or other modes)
 *   are preserved unchanged.
 * 
 * @param existingValues Existing values[] array from parameter file
 * @param newTimeSeries New time-series data to merge (may include latency fields for cohort mode)
 * @param newWindow Window for the new data (the actual fetch window)
 * @param newQuerySignature Query signature for the new data
 * @param queryParams Optional query parameters (DSL object) for debugging
 * @param fullQuery Optional full query string for debugging
 * @param dataSourceType Type of data source (e.g., 'amplitude', 'api')
 * @param sliceDSL Context slice / DSL (e.g., 'context(channel:google)' or full DSL)
 * @param mergeOptions Additional options (cohort mode, latency summary)
 * @returns Values array with merged entry for this slice family
 */
export function mergeTimeSeriesIntoParameter(
  existingValues: ParameterValue[],
  newTimeSeries: Array<TimeSeriesPointWithLatency>,
  newWindow: DateRange,
  newQuerySignature?: string,
  queryParams?: any,
  fullQuery?: string,
  dataSourceType?: string,
  sliceDSL?: string, // CRITICAL: Context slice (e.g., 'context(channel:other)') for isolateSlice matching
  mergeOptions?: MergeOptions
): ParameterValue[] {
  if (newTimeSeries.length === 0) {
    return existingValues;
  }

  const normalizedSlice = sliceDSL || '';
  const isCohortMode = mergeOptions?.isCohortMode ?? false;
  
  // Convert new time series to arrays, sorted chronologically
  const sortedTimeSeries = [...newTimeSeries].sort((a, b) => 
    parseDate(a.date).getTime() - parseDate(b.date).getTime()
  );
  
  const dates = sortedTimeSeries.map(p => normalizeToUK(p.date));
  const n_daily = sortedTimeSeries.map(p => p.n);
  const k_daily = sortedTimeSeries.map(p => p.k);
  
  // Extract latency arrays if present (cohort mode)
  const hasLatencyData = sortedTimeSeries.some(p => p.median_lag_days !== undefined);
  const median_lag_days = hasLatencyData 
    ? sortedTimeSeries.map(p => p.median_lag_days ?? 0) 
    : undefined;
  const mean_lag_days = hasLatencyData 
    ? sortedTimeSeries.map(p => p.mean_lag_days ?? 0) 
    : undefined;
  
  // Helper: build canonical context suffix from slice dimensions
  const targetDims = extractSliceDimensions(normalizedSlice);
  const contextSuffix = targetDims ? `.${targetDims}` : '';

  // COHORT MODE: replace entire slice for this context/case family
  if (isCohortMode) {
    // Calculate aggregate totals for THIS fetch only
    const totalN = n_daily.reduce((sum, n) => sum + n, 0);
    const totalK = k_daily.reduce((sum, k) => sum + k, 0);
    const mean = totalN > 0 ? Math.round((totalK / totalN) * 1000) / 1000 : 0;

    const cohortFrom = normalizeToUK(newWindow.start);
    const cohortTo = normalizeToUK(newWindow.end);

    // Build canonical cohort sliceDSL: cohort(<anchor>,<earliest>:<latest>)[.context(...)]
    // Anchor comes from latencyConfig if available, otherwise empty (edge case: non-latency cohort)
    const anchorNodeId = mergeOptions?.latencyConfig?.anchor_node_id || '';
    const anchorPart = anchorNodeId ? `${anchorNodeId},` : '';
    const canonicalSliceDSL = `cohort(${anchorPart}${cohortFrom}:${cohortTo})${contextSuffix}`;

    const newValue: ParameterValue = {
      mean,
      n: totalN,
      k: totalK,
      n_daily,
      k_daily,
      dates,
      cohort_from: cohortFrom,
      cohort_to: cohortTo,
      query_signature: newQuerySignature,
      sliceDSL: canonicalSliceDSL,
      ...(median_lag_days && { median_lag_days }),
      ...(mean_lag_days && { mean_lag_days }),
      ...(mergeOptions?.latencySummary && { 
        latency: mergeOptions.latencySummary 
      }),
      data_source: {
        type: (dataSourceType || 'api') as 'amplitude' | 'api' | 'manual' | 'sheets' | 'statsig',
        retrieved_at: new Date().toISOString(),
        ...(fullQuery && { full_query: fullQuery }),
      },
    };

    // Drop existing cohort-mode values for this context/case family
    const remaining = existingValues.filter(v => {
      if (!isCohortModeValue(v)) return true;
      const dims = extractSliceDimensions(v.sliceDSL ?? '');
      return dims !== targetDims;
    });

    return [...remaining, newValue];
  }

  // WINDOW MODE: canonical merge by date for this context/case family
  // 1) Collect existing window-mode values for this slice family
  const existingForSlice = existingValues.filter(v => {
    if (isCohortModeValue(v)) return false;
    const dims = extractSliceDimensions(v.sliceDSL ?? '');
    return dims === targetDims;
  });

  // 2) Build date → { n, k } map
  const dateMap = new Map<string, { n: number; k: number }>();

  // Helper to add existing data without overriding newer data
  const addExistingFromValue = (v: ParameterValue) => {
    if (!v.dates || !v.n_daily || !v.k_daily) return;
    for (let i = 0; i < v.dates.length; i++) {
      const ukDate = normalizeDate(v.dates[i]);
      if (!dateMap.has(ukDate)) {
        dateMap.set(ukDate, { n: v.n_daily[i], k: v.k_daily[i] });
      }
    }
  };

  // Seed map from existing window-mode values
  for (const v of existingForSlice) {
    addExistingFromValue(v);
  }

  // 3) Overlay new time-series data (new fetch wins for overlapping dates)
  for (const point of sortedTimeSeries) {
    const ukDate = normalizeDate(point.date);
    dateMap.set(ukDate, { n: point.n, k: point.k });
  }

  // 4) Build merged arrays sorted by date
  const mergedDates = Array.from(dateMap.keys()).sort((a, b) =>
    parseDate(a).getTime() - parseDate(b).getTime()
  );

  const mergedN = mergedDates.map(d => dateMap.get(d)!.n);
  const mergedK = mergedDates.map(d => dateMap.get(d)!.k);

   // Propagate latency arrays where provided in new time series (if any)
   let mergedMedianLag: number[] | undefined;
   let mergedMeanLag: number[] | undefined;
   if (hasLatencyData) {
     const latencyMap = new Map<string, { median?: number; mean?: number }>();
     for (const point of sortedTimeSeries) {
       const ukDate = normalizeDate(point.date);
       latencyMap.set(ukDate, {
         median: point.median_lag_days,
         mean: point.mean_lag_days,
       });
     }
     mergedMedianLag = mergedDates.map(d => latencyMap.get(d)?.median ?? 0);
     mergedMeanLag = mergedDates.map(d => latencyMap.get(d)?.mean ?? 0);
   }

  const mergedTotalN = mergedN.reduce((sum, n) => sum + n, 0);
  const mergedTotalK = mergedK.reduce((sum, k) => sum + k, 0);
  const mergedMean = mergedTotalN > 0 ? Math.round((mergedTotalK / mergedTotalN) * 1000) / 1000 : 0;

  const windowFrom = mergedDates.length > 0 ? mergedDates[0] : normalizeToUK(newWindow.start);
  const windowTo = mergedDates.length > 0 ? mergedDates[mergedDates.length - 1] : normalizeToUK(newWindow.end);

  const canonicalWindowSliceDSL = `window(${windowFrom}:${windowTo})${contextSuffix}`;

  // ═══════════════════════════════════════════════════════════════════════════
  // LAG: Recompute forecast and latency scalars after merge (design.md §3.2)
  // For latency edges, the merged window slice must have an up-to-date forecast
  // (p_infinity) and latency summary based on the newly merged data.
  // ═══════════════════════════════════════════════════════════════════════════
  let recomputedForecast: number | undefined;
  let recomputedLatencySummary: { median_lag_days?: number; mean_lag_days?: number; completeness?: number; t95?: number } | undefined;
  
  if (mergeOptions?.recomputeForecast && mergeOptions?.latencyConfig?.maturity_days && mergeOptions.latencyConfig.maturity_days > 0) {
    try {
      // Build cohort data from merged window data for LAG calculations
      const queryDate = new Date();
      const cohortData: CohortData[] = [];
      
      for (let i = 0; i < mergedDates.length; i++) {
        const cohortDate = parseDate(mergedDates[i]);
        const ageMs = queryDate.getTime() - cohortDate.getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        
        cohortData.push({
          date: mergedDates[i],
          n: mergedN[i],
          k: mergedK[i],
          age: Math.max(0, ageDays),
          median_lag_days: mergedMedianLag?.[i],
          mean_lag_days: mergedMeanLag?.[i],
        });
      }
      
      // Compute aggregate lag stats from cohort data
      // Note: aggregateLatencyStats is defined later in this file, but hoisting makes it available
      const lagStats = aggregateLatencyStats(cohortData);
      const aggregateMedianLag = lagStats?.median_lag_days ?? mergeOptions.latencyConfig.maturity_days / 2;
      const aggregateMeanLag = lagStats?.mean_lag_days;
      
      // Call the statistical enhancement service (imported at top of file)
      const latencyStats: EdgeLatencyStats = computeEdgeLatencyStats(
        cohortData,
        aggregateMedianLag,
        aggregateMeanLag,
        mergeOptions.latencyConfig.maturity_days
      );
      
      // Extract recomputed values
      recomputedForecast = latencyStats.p_infinity;
      recomputedLatencySummary = {
        median_lag_days: aggregateMedianLag,
        mean_lag_days: aggregateMeanLag,
        completeness: latencyStats.completeness,
        t95: latencyStats.t95,
      };
      
      console.log('[mergeTimeSeriesIntoParameter] Recomputed forecast after merge:', {
        p_infinity: recomputedForecast,
        t95: latencyStats.t95,
        completeness: latencyStats.completeness,
        cohortCount: cohortData.length,
        maturityDays: mergeOptions.latencyConfig.maturity_days,
      });
    } catch (error) {
      console.warn('[mergeTimeSeriesIntoParameter] Failed to recompute forecast:', error);
      // Continue without recomputed forecast - preserve existing or omit
    }
  }

  const mergedValue: ParameterValue = {
    mean: mergedMean,
    n: mergedTotalN,
    k: mergedTotalK,
    n_daily: mergedN,
    k_daily: mergedK,
    dates: mergedDates,
    window_from: windowFrom,
    window_to: windowTo,
    query_signature: newQuerySignature,
    ...(mergedMedianLag && { median_lag_days: mergedMedianLag }),
    ...(mergedMeanLag && { mean_lag_days: mergedMeanLag }),
    sliceDSL: canonicalWindowSliceDSL,
    // LAG: Include recomputed forecast if available
    ...(recomputedForecast !== undefined && { forecast: recomputedForecast }),
    // LAG: Include recomputed latency summary if available
    ...(recomputedLatencySummary && { latency: recomputedLatencySummary }),
    data_source: {
      type: (dataSourceType || 'api') as 'amplitude' | 'api' | 'manual' | 'sheets' | 'statsig',
      retrieved_at: new Date().toISOString(),
      ...(fullQuery && { full_query: fullQuery }),
    },
  };

  // 5) Remove existing window-mode values for this slice family and append merged value
  const remainingValues = existingValues.filter(v => !existingForSlice.includes(v));
  return [...remainingValues, mergedValue];
}

// =============================================================================
// Cohort Aggregation Functions (LAG support)
// Design reference: design.md §5.3-5.6
// =============================================================================

// NOTE: CohortData type is imported at the top of the file

/**
 * Convert stored parameter values to CohortData array for LAG statistical calculations.
 * 
 * This extracts per-cohort data (n, k, age, lag stats) from a ParameterValue entry
 * that was stored with cohort mode enabled.
 * 
 * @param value - Single ParameterValue entry from parameter file (cohort mode)
 * @param queryDate - The date to use for computing cohort ages (typically "today")
 * @returns Array of CohortData for use with statisticalEnhancementService functions
 */
export function parameterValueToCohortData(
  value: ParameterValue,
  queryDate: Date
): CohortData[] {
  const { dates, n_daily, k_daily, median_lag_days, mean_lag_days } = value;

  if (!dates || !n_daily || !k_daily) {
    return [];
  }

  if (dates.length !== n_daily.length || dates.length !== k_daily.length) {
    console.warn('parameterValueToCohortData: Array length mismatch');
    return [];
  }

  const cohorts: CohortData[] = [];

  for (let i = 0; i < dates.length; i++) {
    const cohortDate = parseDate(dates[i]);
    const ageMs = queryDate.getTime() - cohortDate.getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    cohorts.push({
      date: dates[i],
      n: n_daily[i],
      k: k_daily[i],
      age: Math.max(0, ageDays), // Ensure non-negative
      median_lag_days: median_lag_days?.[i],
      mean_lag_days: mean_lag_days?.[i],
    });
  }

  return cohorts;
}

/**
 * Aggregate cohort data from multiple ParameterValue entries.
 * 
 * For latency edges, we may have multiple slices (different contexts, etc.)
 * that need to be combined. This function handles the combination by:
 * 1. Collecting all cohorts from all slices
 * 2. For overlapping dates/contexts, using the most recent retrieved_at
 * 3. Returning a unified CohortData array
 * 
 * @param values - Array of ParameterValue entries (cohort mode)
 * @param queryDate - The date to use for computing cohort ages
 * @returns Aggregated CohortData array
 */
export function aggregateCohortData(
  values: ParameterValue[],
  queryDate: Date
): CohortData[] {
  // Collect all cohorts from all values
  const allCohorts: CohortData[] = [];
  const dateMap = new Map<string, { cohort: CohortData; retrieved_at: string }>();

  for (const value of values) {
    const cohorts = parameterValueToCohortData(value, queryDate);
    const retrievedAt = value.data_source?.retrieved_at || '';

    for (const cohort of cohorts) {
      const existing = dateMap.get(cohort.date);
      
      // Keep the more recent data for each date
      if (!existing || retrievedAt > existing.retrieved_at) {
        dateMap.set(cohort.date, { cohort, retrieved_at: retrievedAt });
      }
    }
  }

  // Extract cohorts sorted by date
  const result = Array.from(dateMap.values())
    .map(item => item.cohort)
    .sort((a, b) => parseDate(a.date).getTime() - parseDate(b.date).getTime());

  return result;
}

/**
 * Calculate aggregate latency statistics from cohort data.
 * 
 * Computes weighted median and mean lag from per-cohort lag arrays.
 * Weights by k (number of converters) since lag is only meaningful for converters.
 * 
 * @param cohorts - Array of CohortData with lag information
 * @returns Aggregate latency stats, or undefined if no lag data
 */
export function aggregateLatencyStats(
  cohorts: CohortData[]
): { median_lag_days: number; mean_lag_days: number } | undefined {
  // Filter to cohorts with lag data
  const withLag = cohorts.filter(c => 
    c.k > 0 && 
    c.median_lag_days !== undefined && 
    c.median_lag_days > 0
  );

  if (withLag.length === 0) {
    return undefined;
  }

  // Weighted average by k (converters)
  let totalK = 0;
  let weightedMedian = 0;
  let weightedMean = 0;

  for (const cohort of withLag) {
    totalK += cohort.k;
    weightedMedian += cohort.k * (cohort.median_lag_days || 0);
    weightedMean += cohort.k * (cohort.mean_lag_days || cohort.median_lag_days || 0);
  }

  if (totalK === 0) {
    return undefined;
  }

  return {
    median_lag_days: weightedMedian / totalK,
    mean_lag_days: weightedMean / totalK,
  };
}

/**
 * Check if a ParameterValue entry is in cohort mode.
 * 
 * Cohort mode entries have cohort_from/cohort_to instead of window_from/window_to,
 * or have sliceDSL containing 'cohort('.
 * 
 * @param value - ParameterValue entry to check
 * @returns True if this is cohort mode data
 */
export function isCohortModeValue(value: ParameterValue): boolean {
  // Has cohort date fields
  if (value.cohort_from || value.cohort_to) {
    return true;
  }

  // sliceDSL contains cohort function
  if (value.sliceDSL && value.sliceDSL.includes('cohort(')) {
    return true;
  }

  return false;
}

/**
 * Get the effective date range from a ParameterValue.
 * 
 * Returns cohort_from/cohort_to for cohort mode, window_from/window_to for window mode.
 * 
 * @param value - ParameterValue entry
 * @returns Date range, or undefined if no dates set
 */
export function getValueDateRange(value: ParameterValue): DateRange | undefined {
  if (isCohortModeValue(value)) {
    if (value.cohort_from && value.cohort_to) {
      return { start: value.cohort_from, end: value.cohort_to };
    }
  } else {
    if (value.window_from && value.window_to) {
      return { start: value.window_from, end: value.window_to };
    }
  }
  return undefined;
}

