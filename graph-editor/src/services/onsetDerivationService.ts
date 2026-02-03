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

  // If alpha is 0, define onset as 0 days (immediate).
  if (a <= 0) return 0;

  // Onset policy (as specified):
  //
  // - Iterate bins (in time order) accumulating mass fraction.
  // - FIRST non-zero bin: treat onset time candidate as the UPPER bound (end).
  // - Subsequent non-zero bins: treat onset time candidate as the MIDPOINT of the bin.
  // - Stop at the first point where cumulative mass fraction >= α.
  //
  // This treats Amplitude's adaptive bins as informative: the earliest non-zero bin is assumed
  // to be shaped to contain the first conversion, so its size carries information.
  const threshold = a * total;
  let cumMass = 0;
  let seenFirstNonZero = false;

  for (let i = 0; i < sorted.length; i++) {
    const m = masses[i];
    if (!(m > 0)) continue;

    const start = finiteNumberOr(sorted[i].start, 0);
    const end = finiteNumberOr(sorted[i].end, start);
    const span = Math.max(0, end - start);

    let xMs: number;
    if (!seenFirstNonZero) {
      // First non-zero bin: use the upper bound as the de facto first conversion time.
      xMs = end;
      seenFirstNonZero = true;
    } else {
      // Subsequent non-zero bins: use bin midpoint.
      xMs = start + span / 2;
    }

    cumMass += m;
    if (cumMass >= threshold) {
      return xMs / MS_PER_DAY;
    }
  }

  // If α is 1.0 (or numerical issues prevent threshold crossing), return end-of-mass.
  const last = sorted[sorted.length - 1];
  const fallbackT = finiteNumberOr(last.end, finiteNumberOr(last.start, 0));
  return fallbackT / MS_PER_DAY;
}

