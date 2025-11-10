/**
 * Time Series Merge Utility
 * 
 * Utilities for merging time-series data from multiple sources (e.g., cached + live fetch).
 */

import type { TimeSeriesPoint } from '../types';

/**
 * Merge multiple time-series arrays, deduplicating by date (newer data wins)
 * 
 * @param series Array of time-series arrays to merge
 * @returns Merged time-series, sorted by date
 */
export function mergeTimeSeries(...series: TimeSeriesPoint[][]): TimeSeriesPoint[] {
  // Create a map by date (newer data overwrites older)
  const dateMap = new Map<string, TimeSeriesPoint>();

  // Process all series in order (later series overwrite earlier ones)
  for (const ts of series) {
    for (const point of ts) {
      dateMap.set(point.date, point);
    }
  }

  // Convert to array and sort by date
  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Merge time-series from parameter file format (n_daily, k_daily, dates)
 * 
 * @param series Array of parameter data objects with n_daily, k_daily, dates
 * @returns Merged time-series
 */
export function mergeParameterTimeSeries(
  ...series: Array<{
    n_daily?: number[];
    k_daily?: number[];
    dates?: string[];
  }>
): TimeSeriesPoint[] {
  const timeSeriesArrays: TimeSeriesPoint[][] = series.map((s) => {
    if (!s.n_daily || !s.k_daily || !s.dates) {
      return [];
    }

    if (
      s.n_daily.length !== s.k_daily.length ||
      s.n_daily.length !== s.dates.length
    ) {
      throw new Error(
        'n_daily, k_daily, and dates arrays must have the same length'
      );
    }

    return s.n_daily.map((n, i) => ({
      date: s.dates![i],
      n,
      k: s.k_daily![i],
      p: n > 0 ? s.k_daily![i] / n : 0,
    }));
  });

  return mergeTimeSeries(...timeSeriesArrays);
}

