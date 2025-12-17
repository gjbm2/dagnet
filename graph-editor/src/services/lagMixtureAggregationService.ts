/**
 * Lag Mixture Aggregation Service
 *
 * Implements mathematically defensible aggregation across multiple context pools by treating
 * each pool as a component distribution and computing mixture quantiles (not averages of medians).
 *
 * We approximate each pool's lag distribution as lognormal using (median, mean) moments where possible.
 */
import { fitLagDistribution, logNormalCDF } from './lagDistributionUtils';

export interface LagComponent {
  /** Component median lag (days) */
  medianDays?: number;
  /** Component mean lag (days); optional (uses default sigma if missing) */
  meanDays?: number;
  /** Weight for this component (typically conversions K for edge lag; N for anchor lag) */
  weight: number;
}

/**
 * Compute mixture quantile for a mixture of (approximate) lognormal components.
 *
 * Returns undefined if total weight <= 0 or no components have a finite median.
 */
export function mixtureLogNormalQuantile(
  percentile: number,
  components: LagComponent[]
): number | undefined {
  if (!(percentile > 0 && percentile < 1)) return undefined;

  const usable = components
    .filter((c) => Number.isFinite(c.weight) && c.weight > 0 && Number.isFinite(c.medianDays) && (c.medianDays as number) > 0)
    .map((c) => ({
      w: c.weight,
      median: c.medianDays as number,
      mean: Number.isFinite(c.meanDays) && (c.meanDays as number) > 0 ? (c.meanDays as number) : undefined,
    }));

  if (usable.length === 0) return undefined;

  // Exact fast-path: single component → mixture quantile is the component quantile.
  // For the median specifically, this should return the original median exactly.
  if (usable.length === 1) {
    if (percentile === 0.5) return usable[0].median;
  }

  const totalW = usable.reduce((s, c) => s + c.w, 0);
  if (totalW <= 0) return undefined;

  // Fit per-component params. Use totalK as weight for the quality gate so small components still fit conservatively.
  const fitted = usable.map((c) => {
    const fit = fitLagDistribution(c.median, c.mean, Math.max(1, Math.floor(c.w)));
    return { w: c.w, mu: fit.mu, sigma: fit.sigma, median: c.median };
  });

  // Establish a search bracket for t:
  // - lower: min median / 100 (but > 0)
  // - upper: max median * 100 (but allow expansion if needed)
  const minMedian = Math.min(...fitted.map((f) => f.median));
  const maxMedian = Math.max(...fitted.map((f) => f.median));

  let lo = Math.max(minMedian / 100, 1e-6);
  let hi = Math.max(maxMedian * 100, lo * 2);

  const mixtureCdf = (t: number): number => {
    const s = fitted.reduce((acc, f) => acc + f.w * logNormalCDF(t, f.mu, f.sigma), 0);
    return s / totalW;
  };

  // Expand upper bound if needed (rare; but keep safe)
  for (let i = 0; i < 8; i++) {
    if (mixtureCdf(hi) >= percentile) break;
    hi *= 2;
  }

  // Binary search
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const cdf = mixtureCdf(mid);
    if (cdf >= percentile) hi = mid;
    else lo = mid;
  }

  return hi;
}

export function mixtureLogNormalMedian(components: LagComponent[]): number | undefined {
  return mixtureLogNormalQuantile(0.5, components);
}


