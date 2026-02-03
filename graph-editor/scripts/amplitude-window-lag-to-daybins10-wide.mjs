/**
 * Convert an Amplitude Funnels API response into an Excel-friendly wide CSV row:
 * - 10 "actual" day bins (0-1, 1-2, ..., 8-9, 9+ days) derived from stepTransTimeDistribution
 * - 10 estimated bins from an unshifted lognormal fit (no onset)
 * - 10 estimated bins from a shifted lognormal fit (with onset derived from early mass)
 *
 * Column order is intentionally NOT interleaved:
 *   actual_bin_day_0..9, then est_bin_no_shift_day_0..9, then est_bin_with_shift_day_0..9
 *
 * Usage:
 *   node graph-editor/scripts/amplitude-window-lag-to-daybins10-wide.mjs \
 *     --in  param-registry/test/amplitude/<file>.json \
 *     --out graph-editor/tmp/onset-fit-quality/<file>.daybins10.wide.csv \
 *     --funnel_id switch-registered_to_switch-success \
 *     --window_start_uk 1-Nov-25 \
 *     --window_end_uk 30-Nov-25
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { EOL } from 'node:os';

const MS_PER_DAY = 86_400_000;

// Mirror `lagDistributionUtils.ts` behaviour.
const LATENCY_MIN_FIT_CONVERTERS = 30;
const LATENCY_MIN_MEAN_MEDIAN_RATIO = 0.9;
const LATENCY_MAX_MEAN_MEDIAN_RATIO = 3.0;
const LATENCY_DEFAULT_SIGMA = 0.5;

const ONSET_EPSILON_DAYS = 1e-6;
const ONSET_MASS_FRACTION_ALPHA = 0.01;

function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (typeof v !== 'string' || v.startsWith('--')) {
      throw new Error(`Missing value for --${k}`);
    }
    out[k] = v;
    i += 1;
  }
  return out;
}

function clampPositiveDays(valueDays) {
  if (!Number.isFinite(valueDays)) return ONSET_EPSILON_DAYS;
  return valueDays > ONSET_EPSILON_DAYS ? valueDays : ONSET_EPSILON_DAYS;
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

function standardNormalCDF(z) {
  if (!Number.isFinite(z)) return z < 0 ? 0 : 1;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function logNormalCDF(t, mu, sigma) {
  if (t <= 0) return 0;
  if (!Number.isFinite(t)) return 1;
  return standardNormalCDF((Math.log(t) - mu) / sigma);
}

function logNormalCdfShifted(tTDays, mu, sigma, onsetDeltaDays) {
  if (tTDays <= onsetDeltaDays) return 0;
  return logNormalCDF(tTDays - onsetDeltaDays, mu, sigma);
}

function fitLagDistribution(medianLagDays, meanLagDays, totalK) {
  if (!Number.isFinite(medianLagDays)) {
    return {
      mu: 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }

  if (totalK < LATENCY_MIN_FIT_CONVERTERS) {
    return {
      mu: medianLagDays > 0 ? Math.log(medianLagDays) : 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }

  if (medianLagDays <= 0) {
    return {
      mu: 0,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }

  const mu = Math.log(medianLagDays);

  if (meanLagDays === undefined || meanLagDays <= 0) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: true,
      total_k: totalK,
    };
  }

  const ratio = meanLagDays / medianLagDays;
  if (ratio < 1.0) {
    const isCloseToOne = ratio >= LATENCY_MIN_MEAN_MEDIAN_RATIO;
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: isCloseToOne,
      total_k: totalK,
    };
  }

  if (ratio > LATENCY_MAX_MEAN_MEDIAN_RATIO) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }

  const sigma = Math.sqrt(2 * Math.log(ratio));
  if (!Number.isFinite(sigma) || sigma < 0) {
    return {
      mu,
      sigma: LATENCY_DEFAULT_SIGMA,
      empirical_quality_ok: false,
      total_k: totalK,
    };
  }

  return {
    mu,
    sigma,
    empirical_quality_ok: true,
    total_k: totalK,
  };
}

function extractStep2HistogramBinsDays(amplitudeResponseJson) {
  const data0 = (amplitudeResponseJson?.data ?? [])[0];
  const stepBins = data0?.stepTransTimeDistribution?.step_bins ?? [];
  const step2 = stepBins[1]?.bins ?? [];
  return step2.map((b) => ({
    startDays: b.start / MS_PER_DAY,
    endDays: b.end / MS_PER_DAY,
    total: Number(b?.bin_dist?.totals ?? 0),
  }));
}

function deriveOnsetDeltaDaysFromHistogramBins(binsDays, alpha = ONSET_MASS_FRACTION_ALPHA) {
  const total = binsDays.reduce((s, b) => s + (Number.isFinite(b.total) ? b.total : 0), 0);
  if (!(total > 0)) return 0;

  const target = alpha * total;
  let cum = 0;
  for (const b of binsDays) {
    const mass = Number.isFinite(b.total) ? b.total : 0;
    if (!(mass > 0)) continue;
    if (cum + mass >= target) {
      const width = b.endDays - b.startDays;
      if (!(width > 0)) return Math.max(0, b.startDays);
      const inside = (target - cum) / mass;
      const onset = b.startDays + inside * width;
      return Math.max(0, onset);
    }
    cum += mass;
  }
  // If we never hit target due to weird data, fall back to 0.
  return 0;
}

function buildDayBins10FromHistogram(binsDays) {
  const dayBins = Array.from({ length: 10 }, () => 0);

  for (const b of binsDays) {
    const a = b.startDays;
    const c = b.endDays;
    const m = b.total;
    if (!(Number.isFinite(a) && Number.isFinite(c) && Number.isFinite(m))) continue;
    if (!(m > 0)) continue;
    if (!(c > a)) continue;

    for (let i = 0; i < 9; i += 1) {
      const left = i;
      const right = i + 1;
      const overlap = Math.max(0, Math.min(c, right) - Math.max(a, left));
      if (overlap > 0) {
        dayBins[i] += (m * overlap) / (c - a);
      }
    }

    // 9+ bucket
    const overlap9 = Math.max(0, c - Math.max(a, 9));
    if (overlap9 > 0) {
      dayBins[9] += (m * overlap9) / (c - a);
    }
  }

  return dayBins;
}

function predictedDayBins10(totalK, mu, sigma, onsetDeltaDays) {
  const out = Array.from({ length: 10 }, () => 0);
  const cdf = (t) => logNormalCdfShifted(t, mu, sigma, onsetDeltaDays);

  for (let i = 0; i < 9; i += 1) {
    const a = i;
    const b = i + 1;
    out[i] = (cdf(b) - cdf(a)) * totalK;
  }
  out[9] = (1 - cdf(9)) * totalK;
  return out;
}

function csvEscape(value) {
  const s = String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function formatFixed(x, dp) {
  if (!Number.isFinite(x)) return '';
  return x.toFixed(dp);
}

function main() {
  const args = parseArgs(process.argv);
  const inPath = args.in;
  const outPath = args.out;
  const funnelId = args.funnel_id ?? '';
  const windowStartUk = args.window_start_uk ?? '';
  const windowEndUk = args.window_end_uk ?? '';

  if (!inPath || !outPath) {
    throw new Error('Missing required args: --in and --out');
  }

  const raw = JSON.parse(readFileSync(inPath, 'utf8'));
  const binsDays = extractStep2HistogramBinsDays(raw);
  const totalK = binsDays.reduce((s, b) => s + (Number.isFinite(b.total) ? b.total : 0), 0);

  const onsetDeltaDays = deriveOnsetDeltaDaysFromHistogramBins(binsDays, ONSET_MASS_FRACTION_ALPHA);

  const data0 = (raw?.data ?? [])[0] ?? {};
  const medianLagTDays = Number((data0?.medianTransTimes ?? [])[1]) / MS_PER_DAY;
  const meanLagTDays = Number((data0?.avgTransTimes ?? [])[1]) / MS_PER_DAY;

  const actualBins10 = buildDayBins10FromHistogram(binsDays);

  const fitNoShift = fitLagDistribution(medianLagTDays, meanLagTDays, totalK);
  const estNoShiftBins10 = predictedDayBins10(totalK, fitNoShift.mu, fitNoShift.sigma, 0);

  const medianLagXDays = clampPositiveDays(medianLagTDays - onsetDeltaDays);
  const meanLagXDays = clampPositiveDays(meanLagTDays - onsetDeltaDays);
  const fitShift = fitLagDistribution(medianLagXDays, meanLagXDays, totalK);
  const estWithShiftBins10 = predictedDayBins10(totalK, fitShift.mu, fitShift.sigma, onsetDeltaDays);

  const header = [
    'window_start_uk',
    'window_end_uk',
    'funnel_id',
    'onset_days',
    'median_lag_days',
    'mean_lag_days',
    'total_k',
    ...Array.from({ length: 10 }, (_, i) => `actual_bin_day_${i}`),
    ...Array.from({ length: 10 }, (_, i) => `est_bin_no_shift_day_${i}`),
    ...Array.from({ length: 10 }, (_, i) => `est_bin_with_shift_day_${i}`),
  ];

  const row = [
    windowStartUk,
    windowEndUk,
    funnelId,
    formatFixed(onsetDeltaDays, 6),
    formatFixed(medianLagTDays, 6),
    formatFixed(meanLagTDays, 6),
    String(Math.round(totalK)),
    ...actualBins10.map((x) => formatFixed(x, 6)),
    ...estNoShiftBins10.map((x) => formatFixed(x, 6)),
    ...estWithShiftBins10.map((x) => formatFixed(x, 6)),
  ].map(csvEscape);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${header.join(',')}${EOL}${row.join(',')}${EOL}`, 'utf8');
}

main();
