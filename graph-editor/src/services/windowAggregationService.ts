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
          if (value.dates && Array.isArray(value.dates)) {
            for (const date of value.dates) {
              const normalizedDate = normalizeDate(date);
              existingDates.add(normalizedDate);
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
 * Merge new time-series data with existing parameter file data
 * 
 * Appends a NEW value entry with only the new time-series data.
 * The window aggregator will aggregate across multiple value entries
 * when calculating statistics for a given window.
 * 
 * @param existingValues Existing values[] array from parameter file
 * @param newTimeSeries New time-series data to append
 * @param newWindow Window for the new data (should be the fetch window, not the full requested window)
 * @param newQuerySignature Query signature for the new data
 * @param queryParams Optional query parameters (DSL object) for debugging
 * @param fullQuery Optional full query string for debugging
 * @returns Values array with new entry appended
 */
export function mergeTimeSeriesIntoParameter(
  existingValues: ParameterValue[],
  newTimeSeries: Array<{ date: string; n: number; k: number; p: number }>,
  newWindow: DateRange,
  newQuerySignature?: string,
  queryParams?: any,
  fullQuery?: string,
  dataSourceType?: string,
  sliceDSL?: string // CRITICAL: Context slice (e.g., 'context(channel:other)') for isolateSlice matching
): ParameterValue[] {
  if (newTimeSeries.length === 0) {
    return existingValues;
  }

  const normalizedSlice = sliceDSL || '';
  
  // Separate existing values: same slice (to be merged) vs other slices (preserved as-is)
  const sameSliceValues = existingValues.filter(v => (v.sliceDSL || '') === normalizedSlice);
  const otherSliceValues = existingValues.filter(v => (v.sliceDSL || '') !== normalizedSlice);
  
  // Extract existing daily data for the SAME slice
  const existingDailyData: Array<{ date: string; n: number; k: number }> = [];
  for (const v of sameSliceValues) {
    if (v.dates && v.n_daily && v.k_daily) {
      for (let i = 0; i < v.dates.length; i++) {
        existingDailyData.push({
          date: normalizeToUK(v.dates[i]),
          n: v.n_daily[i] ?? 0,
          k: v.k_daily[i] ?? 0,
        });
      }
    }
  }
  
  // Merge with new data: use a Map so new data OVERWRITES existing for same date
  const dateMap = new Map<string, { n: number; k: number }>();
  
  // Add existing data first
  for (const point of existingDailyData) {
    dateMap.set(point.date, { n: point.n, k: point.k });
  }
  
  // Add new data (OVERWRITES existing for same date)
  for (const point of newTimeSeries) {
    const normalizedDate = normalizeToUK(point.date);
    dateMap.set(normalizedDate, { n: point.n, k: point.k });
  }
  
  // Convert back to arrays, sorted chronologically
  const mergedEntries = Array.from(dateMap.entries())
    .sort((a, b) => parseDate(a[0]).getTime() - parseDate(b[0]).getTime());
  
  const dates = mergedEntries.map(([d]) => d);
  const n_daily = mergedEntries.map(([, v]) => v.n);
  const k_daily = mergedEntries.map(([, v]) => v.k);
  
  // Calculate aggregate totals for merged data
  const totalN = n_daily.reduce((sum, n) => sum + n, 0);
  const totalK = k_daily.reduce((sum, k) => sum + k, 0);
  // Round mean to 3 decimal places
  const mean = totalN > 0 ? Math.round((totalK / totalN) * 1000) / 1000 : 0;
  
  // Determine window: union of existing and new windows
  const allWindowStarts = [
    ...sameSliceValues.filter(v => v.window_from).map(v => parseDate(v.window_from!)),
    parseDate(newWindow.start)
  ];
  const allWindowEnds = [
    ...sameSliceValues.filter(v => v.window_to).map(v => parseDate(v.window_to!)),
    parseDate(newWindow.end)
  ];
  const mergedWindowFrom = allWindowStarts.length > 0 
    ? normalizeToUK(new Date(Math.min(...allWindowStarts.map(d => d.getTime()))).toISOString())
    : normalizeToUK(newWindow.start);
  const mergedWindowTo = allWindowEnds.length > 0
    ? normalizeToUK(new Date(Math.max(...allWindowEnds.map(d => d.getTime()))).toISOString())
    : normalizeToUK(newWindow.end);

  // Create SINGLE merged value entry (replaces all previous entries for this slice)
  const mergedValue: ParameterValue = {
    mean,
    n: totalN,
    k: totalK,
    n_daily,
    k_daily,
    dates,
    window_from: mergedWindowFrom,
    window_to: mergedWindowTo,
    query_signature: newQuerySignature,
    // CRITICAL: sliceDSL enables isolateSlice to find this value entry
    // Without this, contexted data would be invisible to queries!
    sliceDSL: normalizedSlice,
    data_source: {
      type: dataSourceType || 'api',
      retrieved_at: new Date().toISOString(),
      ...(queryParams && { query: queryParams }),
      ...(fullQuery && { full_query: fullQuery }),
    },
  };

  // Return: other slices preserved + single merged entry for this slice
  return [...otherSliceValues, mergedValue];
}

