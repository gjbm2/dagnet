/**
 * Window Aggregation Service
 * 
 * Aggregates daily time-series data (n_daily, k_daily) into aggregate statistics
 * for a given date window. Used when user selects a date range in WindowSelector.
 * 
 * Architecture:
 *   Parameter File (n_daily/k_daily/dates) → WindowAggregationService → Aggregate (n, k, mean, stdev)
 */

import type { TimeSeriesPoint, DateRange } from '../types';

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
function parseDate(dateStr: string): Date {
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
function normalizeDate(dateStr: string): string {
  const date = parseDate(dateStr);
  return date.toISOString().split('T')[0];
}

/**
 * Check if a date is within a range (inclusive)
 */
function isDateInRange(date: string, range: DateRange): boolean {
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

    const daysMissing = daysInWindow - filtered.length;

    // Naive aggregation: sum n and k
    const totalN = filtered.reduce((sum, point) => sum + point.n, 0);
    const totalK = filtered.reduce((sum, point) => sum + point.k, 0);

    // Calculate mean (p = k/n)
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
      days_missing: daysMissing,
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

// Singleton instance
export const windowAggregationService = new WindowAggregationService();

