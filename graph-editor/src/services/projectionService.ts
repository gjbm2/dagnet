/**
 * Projection Service
 *
 * Given a historical entry stream (n_daily), a fitted log-normal lag distribution
 * (p∞, μ, σ, onset), and an optional observed conversion series (k_daily), computes:
 *
 *   k_expected[T] = Σ_{D ≤ T} n_daily[D] × p∞ × [F(T−D−onset; μ,σ) − F(T−D−1−onset; μ,σ)]
 *
 * For future days (T > today) only cohorts that have already started are included,
 * giving a forward projection tail of in-flight users.
 *
 * Pure functions only — no side effects, no API calls.
 */

import { logNormalCDF } from './lagDistributionUtils';
import { parseUKDate, formatDateUK } from '../lib/dateFormat';

export interface ProjectionPoint {
  /** Date in d-MMM-yy format */
  date: string;
  /** Observed k on this day (undefined for future dates) */
  kObserved?: number;
  /** Model-expected k on this day from the convolution */
  kExpected: number;
  /** True for dates after today */
  isFuture: boolean;
}

export interface ProjectionInput {
  /** Daily entry counts aligned with `dates` */
  nDaily: number[];
  /** Daily observed conversion counts aligned with `dates` (may be shorter than nDaily for recent dates) */
  kDaily?: number[];
  /** Dates in d-MMM-yy format corresponding to nDaily/kDaily entries */
  dates: string[];
  /** Asymptotic conversion probability p∞ */
  pInfinity: number;
  /** Log-normal location parameter μ = ln(median_lag) */
  mu: number;
  /** Log-normal scale parameter σ */
  sigma: number;
  /** Dead-time onset in days before conversions begin (default 0) */
  onsetDeltaDays?: number;
  /** How many days beyond today to project (default 60) */
  horizonDays?: number;
}

/**
 * Discretized log-normal lag PMF: probability that a conversion from a cohort
 * starting on day D arrives exactly on day T (i.e., lag = T - D days).
 *
 * P(lag = t) ≈ F(t - onset) - F(t - 1 - onset)   where F = logNormalCDF(·; μ, σ)
 */
function lagPMF(t: number, mu: number, sigma: number, onset: number): number {
  if (t < 0) return 0;
  const modelT = t - onset;
  const modelT1 = t - 1 - onset;
  return logNormalCDF(Math.max(0, modelT), mu, sigma) - logNormalCDF(Math.max(0, modelT1), mu, sigma);
}

/** Add `days` calendar days to a d-MMM-yy date, returning a new d-MMM-yy date. */
function addDays(dateStr: string, days: number): string {
  const d = parseUKDate(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateUK(d);
}

/** Days between two d-MMM-yy dates (end - start). */
function daysBetween(startStr: string, endStr: string): number {
  const start = parseUKDate(startStr);
  const end = parseUKDate(endStr);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Compute the daily in-flight projection for a single edge.
 *
 * @returns Array of ProjectionPoints covering the historical window plus `horizonDays` into the future.
 */
export function projectDailyConversions(opts: ProjectionInput): ProjectionPoint[] {
  const {
    nDaily,
    kDaily,
    dates,
    pInfinity,
    mu,
    sigma,
    onsetDeltaDays = 0,
    horizonDays = 60,
  } = opts;

  if (dates.length === 0 || nDaily.length === 0) return [];

  const today = formatDateUK(new Date());

  // Build the full date range: historical dates + future horizon
  const lastHistoricalDate = dates[dates.length - 1];
  const daysToProject = Math.max(0, daysBetween(lastHistoricalDate, today)) + horizonDays;

  const allDates: string[] = [...dates];
  for (let i = 1; i <= daysToProject; i++) {
    allDates.push(addDays(lastHistoricalDate, i));
  }

  // Build a lookup: date → n_daily entry count (only for historical dates with data)
  const nByDate: Map<string, number> = new Map();
  for (let i = 0; i < dates.length; i++) {
    nByDate.set(dates[i], nDaily[i] ?? 0);
  }

  // Build a lookup: date → k_daily observed count
  const kByDate: Map<string, number> = new Map();
  if (kDaily) {
    for (let i = 0; i < dates.length && i < kDaily.length; i++) {
      kByDate.set(dates[i], kDaily[i] ?? 0);
    }
  }

  const points: ProjectionPoint[] = [];

  for (const date of allDates) {
    const isFuture = daysBetween(today, date) > 0;

    // Expected k arriving on `date` = sum over all cohort start dates D that have already started
    let kExpected = 0;
    for (const [cohortDate, n] of nByDate.entries()) {
      if (n <= 0) continue;
      const lag = daysBetween(cohortDate, date);
      if (lag < 0) continue; // cohort hasn't started yet relative to this date
      const pmf = lagPMF(lag, mu, sigma, onsetDeltaDays);
      kExpected += n * pInfinity * pmf;
    }

    const kObserved = kByDate.has(date) ? kByDate.get(date)! : undefined;

    points.push({ date, kObserved, kExpected, isFuture });
  }

  return points;
}
