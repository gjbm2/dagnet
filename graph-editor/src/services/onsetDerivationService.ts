const MS_PER_DAY = 86_400_000;

export type LagHistogramBin = {
  start: number; // ms
  end?: number; // ms (optional in some payloads)
  bin_dist?: {
    totals?: number;
    uniques?: number;
  };
};

export type LagHistogram = {
  bins?: LagHistogramBin[];
};

function finiteNumberOr(value: unknown, fallback: number): number {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function roundTo1dp(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Derive onset_delta_days from a window() lag histogram using a mass threshold.
 *
 * Policy:
 * - α is a mass fraction (e.g. 0.01 = 1%).
 * - Mass uses bin_dist.totals when present; falls back to bin_dist.uniques.
 * - Returns days (floating) rounded by caller; null when no mass.
 */
export function deriveOnsetDeltaDaysFromLagHistogram(
  histogram: LagHistogram | undefined,
  alpha: number
): number | null {
  const bins = histogram?.bins;
  if (!Array.isArray(bins) || bins.length === 0) return null;

  const a = clamp01(alpha);
  // Sort by start time to be safe.
  const sorted = [...bins].sort((x, y) => finiteNumberOr(x.start, 0) - finiteNumberOr(y.start, 0));

  const masses = sorted.map((b) => {
    const totals = finiteNumberOr(b.bin_dist?.totals, NaN);
    if (Number.isFinite(totals)) return Math.max(0, totals);
    const uniques = finiteNumberOr(b.bin_dist?.uniques, NaN);
    if (Number.isFinite(uniques)) return Math.max(0, uniques);
    return 0;
  });

  const total = masses.reduce((s, m) => s + m, 0);
  if (!(total > 0)) return null;

  const threshold = a * total;
  let cum = 0;

  for (let i = 0; i < sorted.length; i++) {
    const m = masses[i];
    if (!(m > 0)) continue;

    const next = cum + m;
    if (next >= threshold) {
      const start = finiteNumberOr(sorted[i].start, 0);
      const end = finiteNumberOr(sorted[i].end, start);
      const span = Math.max(0, end - start);

      // Fraction of this bin needed to reach the threshold.
      const frac = m > 0 ? clamp01((threshold - cum) / m) : 0;
      const t = start + frac * span;
      return t / MS_PER_DAY;
    }
    cum = next;
  }

  // If alpha is 1.0 and numerical issues prevent threshold crossing, return end-of-mass.
  const last = sorted[sorted.length - 1];
  const fallbackT = finiteNumberOr(last.end, finiteNumberOr(last.start, 0));
  return fallbackT / MS_PER_DAY;
}

