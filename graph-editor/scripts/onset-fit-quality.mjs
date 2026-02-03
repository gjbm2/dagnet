/**
 * Compute onset-vs-unshifted fit quality from Amplitude lag histogram fixtures.
 *
 * Produces plot-ready JSON + CSV:
 * - Histogram bars (bin start/end days, mass, empirical CDF)
 * - Predicted CDF (unshifted, shifted) evaluated at each bin end
 * - Summary metrics (weighted CDF MSE, onset, fitted μ/σ)
 *
 * Usage:
 *   cd graph-editor
 *   node scripts/onset-fit-quality.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MS_PER_DAY = 86_400_000;

// Keep this script dependency-free (Node only). These constants/functions mirror the
// implementations in:
// - src/constants/latency.ts
// - src/services/onsetDerivationService.ts
// - src/services/lagDistributionUtils.ts
const ONSET_MASS_FRACTION_ALPHA = 0.01;
const LATENCY_DEFAULT_SIGMA = 0.5;
const LATENCY_MIN_FIT_CONVERTERS = 30;
const LATENCY_MIN_MEAN_MEDIAN_RATIO = 0.9;
const LATENCY_MAX_MEAN_MEDIAN_RATIO = 3.0;
const ONSET_EPSILON_DAYS = 1e-6;

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function deriveOnsetDeltaDaysFromLagHistogram(histogram, alpha) {
  const bins = histogram?.bins;
  if (!Array.isArray(bins) || bins.length === 0) return null;

  const a = clamp01(alpha);
  const sorted = [...bins].sort((x, y) => (x?.start ?? 0) - (y?.start ?? 0));

  const masses = sorted.map((b) => {
    const totals = b?.bin_dist?.totals;
    if (typeof totals === 'number' && Number.isFinite(totals)) return Math.max(0, totals);
    const uniques = b?.bin_dist?.uniques;
    if (typeof uniques === 'number' && Number.isFinite(uniques)) return Math.max(0, uniques);
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
      const start = (typeof sorted[i].start === 'number' && Number.isFinite(sorted[i].start)) ? sorted[i].start : 0;
      const end = (typeof sorted[i].end === 'number' && Number.isFinite(sorted[i].end)) ? sorted[i].end : start;
      const span = Math.max(0, end - start);
      const frac = m > 0 ? clamp01((threshold - cum) / m) : 0;
      const t = start + frac * span;
      return t / MS_PER_DAY;
    }
    cum = next;
  }

  const last = sorted[sorted.length - 1];
  const fallbackT = (typeof last?.end === 'number' && Number.isFinite(last.end))
    ? last.end
    : ((typeof last?.start === 'number' && Number.isFinite(last.start)) ? last.start : 0);
  return fallbackT / MS_PER_DAY;
}

function clampPositiveDays(valueDays) {
  if (!Number.isFinite(valueDays)) return ONSET_EPSILON_DAYS;
  return valueDays > ONSET_EPSILON_DAYS ? valueDays : ONSET_EPSILON_DAYS;
}

function toModelSpaceLagDays(onsetDeltaDays, valueTDays) {
  const delta = (typeof onsetDeltaDays === 'number' && Number.isFinite(onsetDeltaDays)) ? Math.max(0, onsetDeltaDays) : 0;
  return clampPositiveDays(valueTDays - delta);
}

function erf(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y =
    1.0 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) *
      Math.exp(-x * x);
  return sign * y;
}

function standardNormalCDF(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function logNormalCDF(t, mu, sigma) {
  if (t <= 0) return 0;
  if (sigma <= 0) return t >= Math.exp(mu) ? 1 : 0;
  return standardNormalCDF((Math.log(t) - mu) / sigma);
}

function fitLagDistribution(medianLag, meanLag, totalK) {
  if (!Number.isFinite(medianLag)) {
    return { mu: 0, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: false, total_k: totalK };
  }
  if (totalK < LATENCY_MIN_FIT_CONVERTERS) {
    return {
      mu: medianLag > 0 ? Math.log(medianLag) : 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }
  if (medianLag <= 0) {
    return { mu: 0, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: false, total_k: totalK };
  }

  const mu = Math.log(medianLag);

  if (meanLag === undefined || meanLag <= 0) {
    return { mu, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: true, total_k: totalK };
  }

  const ratio = meanLag / medianLag;
  if (ratio < 1.0) {
    const isCloseToOne = ratio >= LATENCY_MIN_MEAN_MEDIAN_RATIO;
    return { mu, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: isCloseToOne, total_k: totalK };
  }

  if (ratio > LATENCY_MAX_MEAN_MEDIAN_RATIO) {
    return { mu, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: false, total_k: totalK };
  }

  const sigma = Math.sqrt(2 * Math.log(ratio));
  if (!Number.isFinite(sigma) || sigma < 0) {
    return { mu, sigma: LATENCY_DEFAULT_SIGMA, empirical_quality_ok: false, total_k: totalK };
  }

  return { mu, sigma, empirical_quality_ok: true, total_k: totalK };
}

const FIXTURES = [
  'param-registry/test/amplitude/window-other-day2.json',
  'param-registry/test/amplitude/window-paid-social-day2.json',
  'param-registry/test/amplitude/window-influencer-day2.json',
  'param-registry/test/amplitude/window-paid-search-day2.json',
];

function loadJsonFromRepoRoot(pathFromRepoRoot) {
  const abs = join(process.cwd(), '..', pathFromRepoRoot);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function getHistogramForStep2(payload) {
  const d0 = payload?.data?.[0];
  const stepBins = d0?.stepTransTimeDistribution?.step_bins;
  const bins = stepBins?.[1]?.bins; // step index 1: step1 → step2
  return { bins: Array.isArray(bins) ? bins : [] };
}

function getDaySeriesStep2(payload) {
  const d0 = payload?.data?.[0];
  const xValues = d0?.dayFunnels?.xValues;
  const series = d0?.dayFunnels?.series;
  if (!Array.isArray(xValues) || !Array.isArray(series)) return [];
  // series is array-of-arrays; index 1 is step2 conversions for that day (in these fixtures)
  const rows = [];
  for (let i = 0; i < xValues.length; i++) {
    const date = xValues[i];
    const dayRow = series[i];
    const k2 = Array.isArray(dayRow) ? dayRow[1] : undefined;
    if (typeof date !== 'string') continue;
    rows.push({
      date,
      step2_k: (typeof k2 === 'number' && Number.isFinite(k2)) ? k2 : 0,
    });
  }
  return rows;
}

function massOfBin(b) {
  const totals = b?.bin_dist?.totals;
  if (typeof totals === 'number' && Number.isFinite(totals)) return Math.max(0, totals);
  const uniques = b?.bin_dist?.uniques;
  if (typeof uniques === 'number' && Number.isFinite(uniques)) return Math.max(0, uniques);
  return 0;
}

function totalMass(hist) {
  return hist.bins.reduce((s, b) => s + massOfBin(b), 0);
}

function buildSeries(hist, predictedCdfAtDays) {
  const bins = [...hist.bins].sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0));
  const masses = bins.map(massOfBin);
  const total = masses.reduce((s, m) => s + m, 0);
  if (!(total > 0)) return { points: [], mse: Infinity };

  let cum = 0;
  let se = 0;
  const points = [];
  for (let i = 0; i < bins.length; i++) {
    const m = masses[i];
    if (!(m > 0)) continue;
    cum += m;

    const startMs = (typeof bins[i]?.start === 'number' && Number.isFinite(bins[i].start)) ? bins[i].start : 0;
    const endMs = (typeof bins[i]?.end === 'number' && Number.isFinite(bins[i].end)) ? bins[i].end : startMs;
    const startDays = startMs / MS_PER_DAY;
    const endDays = endMs / MS_PER_DAY;
    const midDays = (startDays + endDays) / 2;

    const empiricalCdf = cum / total;
    const predictedCdf = predictedCdfAtDays(endDays);
    const err = predictedCdf - empiricalCdf;
    se += m * err * err;

    points.push({
      i,
      start_days: startDays,
      end_days: endDays,
      mid_days: midDays,
      mass: m,
      empirical_cdf_at_end: empiricalCdf,
      predicted_cdf_at_end: predictedCdf,
    });
  }

  return { points, mse: se / total };
}

function buildDayBins10(hist) {
  // 10 bins:
  // - day 0..8 represent [d, d+1)
  // - day 9 represents [9, +∞)
  const bins = [...hist.bins].sort((a, b) => (a?.start ?? 0) - (b?.start ?? 0));
  const masses = new Array(10).fill(0);

  for (const b of bins) {
    const m = massOfBin(b);
    if (!(m > 0)) continue;

    const startMs = (typeof b?.start === 'number' && Number.isFinite(b.start)) ? b.start : 0;
    const endMs = (typeof b?.end === 'number' && Number.isFinite(b.end)) ? b.end : startMs;

    const startDays = Math.max(0, startMs / MS_PER_DAY);
    const endDays = Math.max(0, endMs / MS_PER_DAY);

    // Point-mass bin: assign to the bin containing startDays.
    if (!(endDays > startDays)) {
      const idx = startDays >= 9 ? 9 : Math.floor(startDays);
      masses[idx] += m;
      continue;
    }

    const span = endDays - startDays;

    // Distribute mass proportionally to time overlap.
    for (let day = 0; day < 9; day++) {
      const lo = day;
      const hi = day + 1;
      const overlap = Math.max(0, Math.min(endDays, hi) - Math.max(startDays, lo));
      if (overlap > 0) masses[day] += m * (overlap / span);
    }

    // 9+ bin: everything from day 9 onwards.
    const overlap9p = Math.max(0, endDays - Math.max(startDays, 9));
    if (overlap9p > 0) masses[9] += m * (overlap9p / span);
  }

  const total = masses.reduce((s, x) => s + x, 0);
  return { masses, total };
}

function buildDayBinPoints10(dayBins10, predictedCdfAtDays) {
  const masses = dayBins10.masses;
  const total = dayBins10.total;
  if (!(total > 0)) return { points: [], mse: Infinity };

  let cum = 0;
  let se = 0;
  const points = [];
  for (let day = 0; day < 10; day++) {
    const m = masses[day];
    const startDays = day;
    const endDays = day === 9 ? Infinity : day + 1;
    const midDays = day === 9 ? 9.5 : (startDays + endDays) / 2;

    cum += m;
    const empiricalCdf = cum / total;
    const predictedCdf = predictedCdfAtDays(endDays);
    const err = predictedCdf - empiricalCdf;
    se += m * err * err;

    points.push({
      day,
      start_days: startDays,
      end_days: endDays === Infinity ? '' : endDays,
      mid_days: midDays,
      mass: m,
      empirical_cdf_at_end: empiricalCdf,
      predicted_cdf_at_end: predictedCdf,
    });
  }

  return { points, mse: se / total };
}

function toCsv(points, extraCols) {
  const cols = [
    'i',
    'start_days',
    'end_days',
    'mid_days',
    'mass',
    'empirical_cdf_at_end',
    ...extraCols,
  ];
  const header = cols.join(',');
  const rows = points.map((p) =>
    cols
      .map((c) => {
        const v = p[c];
        if (v === undefined) return '';
        return typeof v === 'number' ? String(v) : JSON.stringify(v);
      })
      .join(',')
  );
  return [header, ...rows].join('\n') + '\n';
}

function baseNameFromFixturePath(p) {
  return p.split('/').pop().replace('.json', '');
}

function wideCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const header = cols.join(',');
  const lines = rows.map((r) =>
    cols
      .map((c) => {
        const v = r[c];
        if (v === undefined || v === null) return '';
        if (typeof v === 'number') return String(v);
        return JSON.stringify(v);
      })
      .join(',')
  );
  return [header, ...lines].join('\n') + '\n';
}

function main() {
  const outDir = join(process.cwd(), 'tmp', 'onset-fit-quality');
  mkdirSync(outDir, { recursive: true });

  const summary = [];
  const wideRows = [];
  const byDateRows = [];

  for (const fixturePath of FIXTURES) {
    const payload = loadJsonFromRepoRoot(fixturePath);
    const hist = getHistogramForStep2(payload);
    if (hist.bins.length === 0) {
      summary.push({ fixture: fixturePath, error: 'no bins' });
      continue;
    }

    const daySeries = getDaySeriesStep2(payload);

    const d0 = payload?.data?.[0];
    const medianMs = d0?.medianTransTimes?.[1];
    const meanMs = d0?.avgTransTimes?.[1];
    if (!(typeof medianMs === 'number' && typeof meanMs === 'number')) {
      summary.push({ fixture: fixturePath, error: 'missing median/mean' });
      continue;
    }

    const medianTDays = medianMs / MS_PER_DAY;
    const meanTDays = meanMs / MS_PER_DAY;

    const onset = deriveOnsetDeltaDaysFromLagHistogram(hist, ONSET_MASS_FRACTION_ALPHA);
    const onsetDays = onset ?? 0;

    const totK = totalMass(hist);
    const fitUnshifted = fitLagDistribution(medianTDays, meanTDays, totK);
    const fitShifted = fitLagDistribution(
      toModelSpaceLagDays(onsetDays, medianTDays),
      toModelSpaceLagDays(onsetDays, meanTDays),
      totK
    );

    const unshifted = buildSeries(hist, (tDays) => logNormalCDF(tDays, fitUnshifted.mu, fitUnshifted.sigma));
    const shifted = buildSeries(hist, (tDays) => (tDays <= onsetDays ? 0 : logNormalCDF(tDays - onsetDays, fitShifted.mu, fitShifted.sigma)));

    const points = unshifted.points.map((p, idx) => ({
      ...p,
      predicted_cdf_unshifted_at_end: p.predicted_cdf_at_end,
      predicted_cdf_shifted_at_end: shifted.points[idx]?.predicted_cdf_at_end,
    }));

    // Day-binned view (10 bins: 0..8, 9+). This is what Excel can plot cleanly.
    const dayBins10 = buildDayBins10(hist);
    const dayUnshifted = buildDayBinPoints10(dayBins10, (tDays) => (tDays === Infinity ? 1 : logNormalCDF(tDays, fitUnshifted.mu, fitUnshifted.sigma)));
    const dayShifted = buildDayBinPoints10(dayBins10, (tDays) => {
      if (tDays === Infinity) return 1;
      if (tDays <= onsetDays) return 0;
      return logNormalCDF(tDays - onsetDays, fitShifted.mu, fitShifted.sigma);
    });

    const dayPoints = dayUnshifted.points.map((p, idx) => {
      const endDays = idx === 9 ? Infinity : idx + 1;
      const startDays = idx;
      const cdfUStart = startDays <= 0 ? 0 : logNormalCDF(startDays, fitUnshifted.mu, fitUnshifted.sigma);
      const cdfUEnd = endDays === Infinity ? 1 : logNormalCDF(endDays, fitUnshifted.mu, fitUnshifted.sigma);
      const massU = cdfUEnd - cdfUStart;

      const cdfSStart =
        startDays <= onsetDays ? 0 : logNormalCDF(startDays - onsetDays, fitShifted.mu, fitShifted.sigma);
      const cdfSEnd =
        endDays === Infinity ? 1 : (endDays <= onsetDays ? 0 : logNormalCDF(endDays - onsetDays, fitShifted.mu, fitShifted.sigma));
      const massS = cdfSEnd - cdfSStart;

      return {
        ...p,
        i: idx,
        predicted_cdf_unshifted_at_end: dayUnshifted.points[idx]?.predicted_cdf_at_end,
        predicted_cdf_shifted_at_end: dayShifted.points[idx]?.predicted_cdf_at_end,
        predicted_mass_unshifted_in_bin: massU,
        predicted_mass_shifted_in_bin: massS,
      };
    });

    const mseU = unshifted.mse;
    const mseS = shifted.mse;
    const abs = mseU - mseS;
    const rel = mseU > 0 ? abs / mseU : null;

    const base = baseNameFromFixturePath(fixturePath);
    const jsonOut = join(outDir, `${base}.plot.json`);
    const csvOut = join(outDir, `${base}.plot.csv`);
    const dayJsonOut = join(outDir, `${base}.daybins10.json`);
    const dayCsvOut = join(outDir, `${base}.daybins10.csv`);
    const wideOut = join(outDir, `${base}.daybins10.wide.csv`);

    writeFileSync(
      jsonOut,
      JSON.stringify(
        {
          fixture: fixturePath,
          alpha: ONSET_MASS_FRACTION_ALPHA,
          onset_days: onset,
          total_mass: totK,
          median_T_days: medianTDays,
          mean_T_days: meanTDays,
          unshifted: { mu: fitUnshifted.mu, sigma: fitUnshifted.sigma, mse: mseU },
          shifted: { mu: fitShifted.mu, sigma: fitShifted.sigma, mse: mseS },
          improvement: { abs_mse: abs, rel_fraction: rel, rel_percent: rel === null ? null : rel * 100 },
          points,
        },
        null,
        2
      ) + '\n'
    );

    writeFileSync(
      csvOut,
      toCsv(points, ['predicted_cdf_unshifted_at_end', 'predicted_cdf_shifted_at_end'])
    );

    writeFileSync(
      dayJsonOut,
      JSON.stringify(
        {
          fixture: fixturePath,
          alpha: ONSET_MASS_FRACTION_ALPHA,
          onset_days: onset,
          total_mass: totK,
          total_mass_daybins10: dayBins10.total,
          median_T_days: medianTDays,
          mean_T_days: meanTDays,
          unshifted: { mu: fitUnshifted.mu, sigma: fitUnshifted.sigma, mse_daybins10: dayUnshifted.mse },
          shifted: { mu: fitShifted.mu, sigma: fitShifted.sigma, mse_daybins10: dayShifted.mse },
          points: dayPoints,
        },
        null,
        2
      ) + '\n'
    );

    writeFileSync(
      dayCsvOut,
      toCsv(dayPoints, [
        'predicted_cdf_unshifted_at_end',
        'predicted_cdf_shifted_at_end',
        'predicted_mass_unshifted_in_bin',
        'predicted_mass_shifted_in_bin',
      ])
    );

    // Wide (one-row) format for Excel comparisons.
    const wide = {
      fixture: fixturePath,
      context: base,
      alpha: ONSET_MASS_FRACTION_ALPHA,
      onset_days: onset,
      median_lag_days: medianTDays,
      mean_lag_days: meanTDays,
      total_mass: totK,
    };
    for (let d = 0; d < 10; d++) {
      const p = dayPoints[d];
      wide[`actual_bin_day_${d}`] = p?.mass ?? 0;
    }
    for (let d = 0; d < 10; d++) {
      const p = dayPoints[d];
      wide[`est_bin_no_shift_day_${d}`] = (p?.predicted_mass_unshifted_in_bin ?? 0) * totK;
      wide[`est_bin_with_shift_day_${d}`] = (p?.predicted_mass_shifted_in_bin ?? 0) * totK;
    }
    writeFileSync(wideOut, wideCsv([wide]));
    wideRows.push({ ...wide, out_wide_csv: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.wide.csv` });

    // By-date wide format: one row per dayFunnels.xValues date.
    // NOTE: Amplitude fixtures do not provide per-date lag histograms. We therefore allocate the
    // aggregate lag histogram across dates in proportion to that date’s step2 conversions.
    // This gives a plot-ready table for Excel while being explicit about what is observed vs allocated.
    if (daySeries.length > 0) {
      const byDateOut = join(outDir, `${base}.daybins10.bydate.csv`);
      const totalKFromDays = daySeries.reduce((s, r) => s + r.step2_k, 0);
      const probs = dayBins10.total > 0 ? dayBins10.masses.map((m) => m / dayBins10.total) : new Array(10).fill(0);
      const predictedProbU = dayPoints.map((p) => p.predicted_mass_unshifted_in_bin ?? 0);
      const predictedProbS = dayPoints.map((p) => p.predicted_mass_shifted_in_bin ?? 0);

      const rows = daySeries.map((r) => {
        const row = {
          fixture: fixturePath,
          context: base,
          date: r.date,
          allocated_from_aggregate_histogram: true,
          alpha: ONSET_MASS_FRACTION_ALPHA,
          onset_days: onset,
          median_lag_days: medianTDays,
          mean_lag_days: meanTDays,
          step2_k: r.step2_k,
          total_step2_k: totalKFromDays,
        };
        for (let d = 0; d < 10; d++) row[`actual_bin_day_${d}`] = probs[d] * r.step2_k;
        for (let d = 0; d < 10; d++) row[`est_bin_no_shift_day_${d}`] = predictedProbU[d] * r.step2_k;
        for (let d = 0; d < 10; d++) row[`est_bin_with_shift_day_${d}`] = predictedProbS[d] * r.step2_k;
        return row;
      });

      writeFileSync(byDateOut, wideCsv(rows));
      for (const r of rows) byDateRows.push({ ...r, out_bydate_csv: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.bydate.csv` });
    }

    summary.push({
      fixture: fixturePath,
      onset_days: onset,
      total_mass: totK,
      mse_unshifted: mseU,
      mse_shifted: mseS,
      abs_mse: abs,
      rel_percent: rel === null ? null : rel * 100,
      out_json: `graph-editor/tmp/onset-fit-quality/${base}.plot.json`,
      out_csv: `graph-editor/tmp/onset-fit-quality/${base}.plot.csv`,
      out_daybins10_json: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.json`,
      out_daybins10_csv: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.csv`,
      out_daybins10_wide_csv: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.wide.csv`,
      out_daybins10_bydate_csv: `graph-editor/tmp/onset-fit-quality/${base}.daybins10.bydate.csv`,
    });
  }

  const summaryOut = join(outDir, 'summary.json');
  writeFileSync(summaryOut, JSON.stringify(summary, null, 2) + '\n');

  const wideSummaryOut = join(outDir, 'summary.daybins10.wide.csv');
  writeFileSync(wideSummaryOut, wideCsv(wideRows));

  const byDateSummaryOut = join(outDir, 'summary.daybins10.bydate.csv');
  writeFileSync(byDateSummaryOut, wideCsv(byDateRows));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote plot data to: ${outDir}`);
}

main();
