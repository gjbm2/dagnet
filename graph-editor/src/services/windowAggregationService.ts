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
 * Parse date string (YYYY-MM-DD or ISO 8601) to Date for comparison
 */
export function parseDate(dateStr: string): Date {
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
export function normalizeDate(dateStr: string): string {
  const date = parseDate(dateStr);
  return date.toISOString().split('T')[0];
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
  bustCache: boolean = false
): IncrementalFetchResult {
  // Normalize requested window dates
  const normalizedWindow: DateRange = {
    start: normalizeDate(requestedWindow.start),
    end: normalizeDate(requestedWindow.end),
  };

  // Extract all existing dates from parameter file values
  const existingDates = new Set<string>();
  
  // If bustCache is true, skip checking existing dates
  if (!bustCache && paramFileData.values && Array.isArray(paramFileData.values)) {
    for (const value of paramFileData.values) {
      // If query signature is provided, only consider matching values
      if (querySignature && value.query_signature !== querySignature) {
        continue;
      }
      
      // Extract dates from this value entry
      if (value.dates && Array.isArray(value.dates)) {
        for (const date of value.dates) {
          const normalizedDate = normalizeDate(date);
          existingDates.add(normalizedDate);
        }
      }
    }
  }

  // Generate all dates in requested window
  const startDate = parseDate(normalizedWindow.start);
  const endDate = parseDate(normalizedWindow.end);
  const allDatesInWindow: string[] = [];
  
  const currentDate = new Date(startDate);
  while (currentDate <= endDate) {
    const dateStr = normalizeDate(currentDate.toISOString());
    allDatesInWindow.push(dateStr);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  // Find missing dates (dates in requested window that don't exist)
  const missingDates = allDatesInWindow.filter(date => !existingDates.has(date));
  
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
    // Sort missing dates
    const sortedMissing = [...missingDates].sort();
    
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
        fetchWindows.push({
          start: gapStart + 'T00:00:00Z',
          end: gapEnd + 'T23:59:59Z',
        });
        gapStart = sortedMissing[i];
        gapEnd = gapStart;
      }
    }
    
    // Don't forget the last gap
    fetchWindows.push({
      start: gapStart + 'T00:00:00Z',
      end: gapEnd + 'T23:59:59Z',
    });
    
    // For backward compatibility, also provide single combined window
    fetchWindow = {
      start: sortedMissing[0] + 'T00:00:00Z',
      end: sortedMissing[sortedMissing.length - 1] + 'T23:59:59Z',
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
  dataSourceType?: string
): ParameterValue[] {
  if (newTimeSeries.length === 0) {
    return existingValues;
  }

  // Extract dates, n_daily, k_daily from new time-series
  const dates = newTimeSeries.map(point => point.date);
  const n_daily = newTimeSeries.map(point => point.n);
  const k_daily = newTimeSeries.map(point => point.k);

  // Calculate aggregate totals for this new entry
  const totalN = n_daily.reduce((sum, n) => sum + n, 0);
  const totalK = k_daily.reduce((sum, k) => sum + k, 0);
  // Round mean to 3 decimal places
  const mean = totalN > 0 ? Math.round((totalK / totalN) * 1000) / 1000 : 0;

  // Create NEW value entry with only the new days
  const newValue: ParameterValue = {
    mean,
    n: totalN,
    k: totalK,
    n_daily,
    k_daily,
    dates,
    window_from: newWindow.start,
    window_to: newWindow.end,
    query_signature: newQuerySignature,
    data_source: {
      type: dataSourceType || 'api',
      retrieved_at: new Date().toISOString(),
      ...(queryParams && { query: queryParams }),
      ...(fullQuery && { full_query: fullQuery }),
    },
  };

  // Append the new value entry (don't merge with existing)
  // Window aggregator will aggregate across multiple entries
  return [...existingValues, newValue];
}

