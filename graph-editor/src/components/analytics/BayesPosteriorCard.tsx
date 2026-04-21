/**
 * BayesPosteriorCard — posterior display for edge_info Model tab.
 *
 * Uses CSS flex-wrap for responsive two-column (wide) / stacked (narrow) layout.
 * No grid lines — uses spacing and muted headers like the rest of the app.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import type { ProbabilityPosterior, LatencyPosterior } from '../../types';
import { computeQualityTier, qualityTierToColour, qualityTierLabel } from '../../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel, freshnessColour } from '../../utils/freshnessDisplay';
import GlossaryTooltip from '../GlossaryTooltip';

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '–';
  return `${(v * 100).toFixed(1)}%`;
}
function fmt(v: number | null | undefined, dp = 4): string {
  if (v == null) return '–';
  return v.toFixed(dp);
}

interface Props {
  probability?: ProbabilityPosterior | null;
  latency?: LatencyPosterior | null;
  /** Edge-level t95 point estimate (days) — from edge.p.latency.t95 */
  t95?: number | null;
  /** Path-level t95 point estimate (days) — from edge.p.latency.path_t95 */
  pathT95?: number | null;
  theme?: 'light' | 'dark';
  /** Reset priors for next Bayesian run (non-destructive). */
  onResetPriors?: () => void;
  /** Delete all fit history (destructive — requires caller to confirm first). */
  onDeleteHistory?: () => void;
}

export function BayesPosteriorCard({ probability, latency, t95, pathT95, theme = 'dark', onResetPriors, onDeleteHistory }: Props) {
  const post = probability;
  const lat = latency;

  const hasEdgeP = post?.alpha != null && post?.beta != null;
  const pa = (post as any)?.cohort_alpha;
  const pb = (post as any)?.cohort_beta;
  const hasPathP = pa != null && pb != null;
  const hasEdgeLat = lat?.mu_mean != null;
  const hasPathLat = lat?.path_mu_mean != null;
  const hasPath = hasPathP || hasPathLat;

  if (!hasEdgeP && !hasEdgeLat) {
    return <div style={{ padding: 10, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>No posterior available</div>;
  }

  // Doc 49 §A.9: displayed ± and HDI use PREDICTIVE (α_pred/β_pred, kappa-inflated)
  // when available; fall back to epistemic (α/β) when kappa is absent. Mean is
  // the same in both (the Beta ratio α/(α+β) is preserved when κ scales α and β).
  const edgeAlphaD = hasEdgeP ? (post!.alpha_pred ?? post!.alpha) : null;
  const edgeBetaD = hasEdgeP ? (post!.beta_pred ?? post!.beta) : null;
  const edgePMean = hasEdgeP ? post!.alpha / (post!.alpha + post!.beta) : null;
  const edgePSd = (edgeAlphaD != null && edgeBetaD != null)
    ? Math.sqrt(edgeAlphaD * edgeBetaD / ((edgeAlphaD + edgeBetaD) ** 2 * (edgeAlphaD + edgeBetaD + 1)))
    : null;
  const paPred = (post as any)?.cohort_alpha_pred;
  const pbPred = (post as any)?.cohort_beta_pred;
  const pathAlphaD = hasPathP ? (paPred ?? pa) : null;
  const pathBetaD = hasPathP ? (pbPred ?? pb) : null;
  const pathPMean = hasPathP ? pa / (pa + pb) : null;
  const pathPSd = (pathAlphaD != null && pathBetaD != null)
    ? Math.sqrt(pathAlphaD * pathBetaD / ((pathAlphaD + pathBetaD) ** 2 * (pathAlphaD + pathBetaD + 1)))
    : null;

  // ── Convergence footer ──
  const tier = post ? computeQualityTier(post) : null;
  const tierColour = tier ? qualityTierToColour(tier.tier, theme) : undefined;
  const footerParts: Array<{ text: string; colour?: string }> = [];
  if (tier) footerParts.push({ text: qualityTierLabel(tier.tier), colour: tierColour });
  if (post?.rhat != null) footerParts.push({ text: `r̂ ${post.rhat.toFixed(4)}` });
  if (post?.ess != null) footerParts.push({ text: `ESS ${Math.round(post.ess)}` });
  if (post?.evidence_grade != null) footerParts.push({ text: `${post.evidence_grade}/3` });
  if (post?.fitted_at) {
    const rel = formatRelativeTime(post.fitted_at);
    footerParts.push({ text: rel ?? post.fitted_at, colour: freshnessColour(getFreshnessLevel(post.fitted_at), theme) });
  }
  // LOO-ELPD model adequacy (doc 32): raw numbers suppressed from
  // headline footer — they're uninterpretable to business users.
  // Quality tier absorbs LOO signals (warning on ΔELPD<0 or k>0.7).
  // Raw values remain in PosteriorIndicator diagnostic popover.

  // ── Shared components ──
  const Label = ({ children }: { children: React.ReactNode }) => (
    <span style={{ color: 'var(--text-muted, #999)', fontSize: 10 }}>{children}</span>
  );
  const Value = ({ children }: { children: string }) => (
    <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{children}</span>
  );
  const Row = ({ label, value, term }: { label: string; value: string; term?: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, lineHeight: '17px' }}>
      <Label>{term ? <GlossaryTooltip term={term}>{label}</GlossaryTooltip> : label}</Label>
      <Value>{value}</Value>
    </div>
  );
  const SectionLabel = ({ children }: { children: string }) => (
    <div style={{
      fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
      color: 'var(--text-muted, #777)', marginBottom: 2, marginTop: 8,
    }}>{children}</div>
  );

  // ── Build column content ──
  // HDI matches σ: prefer predictive HDI (hdi_*_pred) when kappa is present.
  const edgeHdiLo = post?.hdi_lower_pred ?? post?.hdi_lower;
  const edgeHdiHi = post?.hdi_upper_pred ?? post?.hdi_upper;
  const pathHdiLo = (post as any)?.cohort_hdi_lower_pred ?? (post as any)?.cohort_hdi_lower;
  const pathHdiHi = (post as any)?.cohort_hdi_upper_pred ?? (post as any)?.cohort_hdi_upper;

  const edgeProbRows = hasEdgeP ? (
    <>
      <Row label="p" term="probability" value={`${fmtPct(edgePMean)} ± ${fmtPct(edgePSd)}`} />
      {edgeHdiLo != null && <Row label="HDI" term="hdi" value={`${fmtPct(edgeHdiLo)} — ${fmtPct(edgeHdiHi)}`} />}
    </>
  ) : null;

  const pathProbRows = hasPathP ? (
    <>
      <Row label="p" term="probability" value={`${fmtPct(pathPMean)} ± ${fmtPct(pathPSd)}`} />
      {pathHdiLo != null && <Row label="HDI" term="hdi" value={`${fmtPct(pathHdiLo)} — ${fmtPct(pathHdiHi)}`} />}
    </>
  ) : null;

  // Doc 49 §A.9: sigma_sd and onset_sd are epistemic (no predictive mechanism),
  // while mu_sd and p.stdev are predictive. Mark epistemic ± with *.
  const _epist = '*';
  const _hasEpistFootnote = hasEdgeLat || hasPathLat;

  const edgeLatRows = hasEdgeLat ? (
    <>
      <Row label="onset" term="onset" value={`${fmt(lat!.onset_delta_days ?? lat!.onset_mean, 1)}d${lat!.onset_sd != null ? ` ± ${fmt(lat!.onset_sd, 1)}d${_epist}` : ''}`} />
      {lat!.onset_hdi_lower != null && <Row label="onset HDI" term="hdi" value={`${fmt(lat!.onset_hdi_lower, 1)}d — ${fmt(lat!.onset_hdi_upper, 1)}d`} />}
      <Row label="μ" term="mu" value={`${fmt(lat!.mu_mean, 3)} ± ${fmt(lat!.mu_sd, 3)}`} />
      <Row label="σ" term="sigma" value={`${fmt(lat!.sigma_mean, 3)} ± ${fmt(lat!.sigma_sd, 3)}${_epist}`} />
      {lat!.hdi_t95_lower != null && <Row label="t95 HDI" term="t95-hdi" value={`${fmt(lat!.hdi_t95_lower, 1)}d — ${fmt(lat!.hdi_t95_upper, 1)}d`} />}
      {lat!.onset_mu_corr != null && <Row label="onset↔μ" term="onset-mu-corr" value={fmt(lat!.onset_mu_corr, 3)} />}
    </>
  ) : null;

  const pathLatRows = hasPathLat ? (
    <>
      <Row label="onset" term="onset" value={`${fmt(lat!.path_onset_delta_days, 1)}d${lat!.path_onset_sd != null ? ` ± ${fmt(lat!.path_onset_sd, 1)}d${_epist}` : ''}`} />
      {lat!.path_onset_hdi_lower != null && <Row label="onset HDI" term="hdi" value={`${fmt(lat!.path_onset_hdi_lower, 1)}d — ${fmt(lat!.path_onset_hdi_upper, 1)}d`} />}
      <Row label="μ" term="mu" value={`${fmt(lat!.path_mu_mean, 3)} ± ${fmt(lat!.path_mu_sd, 3)}`} />
      <Row label="σ" term="sigma" value={`${fmt(lat!.path_sigma_mean, 3)} ± ${fmt(lat!.path_sigma_sd, 3)}${_epist}`} />
      {(lat as any)?.path_hdi_t95_lower != null && <Row label="t95 HDI" term="t95-hdi" value={`${fmt((lat as any).path_hdi_t95_lower, 1)}d — ${fmt((lat as any).path_hdi_t95_upper, 1)}d`} />}
      {(lat as any)?.path_onset_mu_corr != null && <Row label="onset↔μ" term="onset-mu-corr" value={fmt((lat as any).path_onset_mu_corr, 3)} />}
    </>
  ) : null;

  const footer = footerParts.length > 0 ? (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
      padding: '8px 0 4px', marginTop: 6,
      fontSize: 10, lineHeight: '15px', color: 'var(--text-muted, #999)',
    }}>
      {footerParts.map((item, i) => (
        <span key={i} style={item.colour ? { color: item.colour } : undefined}>{item.text}</span>
      ))}
    </div>
  ) : null;

  // ── Single responsive layout: flex-wrap gives two columns when wide, stacks when narrow ──
  return (
    <div style={{ padding: '4px 10px 6px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 20px' }}>
        {/* Edge column */}
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)', marginBottom: 2 }}>
            Edge (window)
          </div>
          {edgeProbRows && <><SectionLabel>Probability</SectionLabel>{edgeProbRows}</>}
          {edgeLatRows && <><SectionLabel>Latency</SectionLabel>{edgeLatRows}</>}
        </div>
        {/* Path column */}
        {hasPath && (
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)', marginBottom: 2 }}>
              Path (cohort)
            </div>
            {pathProbRows && <><SectionLabel>Probability</SectionLabel>{pathProbRows}</>}
            {pathLatRows && <><SectionLabel>Latency</SectionLabel>{pathLatRows}</>}
          </div>
        )}
      </div>
      {footer}
      {_hasEpistFootnote && (
        <div style={{
          fontSize: 9, lineHeight: '13px', color: 'var(--text-muted, #888)',
          padding: '2px 0', fontStyle: 'italic',
        }}
        title="This &#177; reflects how precisely the model knows this parameter given the data it has seen. It does not include day-to-day variation (overdispersion). The probability and &#956; lines include observation-level variation."
        >
          * Epistemic — precision of the model&apos;s estimate
        </div>
      )}
      {(onResetPriors || onDeleteHistory) && (
        <div style={{
          display: 'flex', gap: 12, padding: '4px 0 2px',
          fontSize: 10, lineHeight: '15px',
        }}>
          {onResetPriors && (
            <button
              onClick={onResetPriors}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--text-muted, #999)', fontSize: 10, textDecoration: 'underline',
              }}
              title="Reset priors for next Bayesian run (non-destructive)"
            >
              Reset priors
            </button>
          )}
          {onDeleteHistory && (
            <button
              onClick={onDeleteHistory}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                color: 'var(--text-muted, #999)', fontSize: 10, textDecoration: 'underline',
              }}
              title="Delete all fit history (irreversible)"
            >
              Delete history
            </button>
          )}
        </div>
      )}
      <ModelRateChart
        edgeP={edgePMean} edgeMu={lat?.mu_mean} edgeSigma={lat?.sigma_mean} edgeOnset={lat?.onset_delta_days ?? lat?.onset_mean}
        edgePSd={edgePSd} edgeMuSd={lat?.mu_sd} edgeSigmaSd={lat?.sigma_sd} edgeOnsetSd={lat?.onset_sd}
        edgeOnsetMuCorr={lat?.onset_mu_corr} edgeT95={t95}
        pathP={pathPMean} pathMu={lat?.path_mu_mean} pathSigma={lat?.path_sigma_mean} pathOnset={lat?.path_onset_delta_days}
        pathPSd={pathPSd} pathMuSd={lat?.path_mu_sd} pathSigmaSd={lat?.path_sigma_sd} pathOnsetSd={lat?.path_onset_sd}
        pathOnsetMuCorr={(lat as any)?.path_onset_mu_corr} pathT95={pathT95}
      />
    </div>
  );
}

// ── Model rate CDF mini-chart with confidence bands ──────────────────────────

function shiftedLognormalCdf(age: number, onset: number, mu: number, sigma: number): number {
  const t = age - onset;
  if (t <= 0 || sigma <= 0) return 0;
  const z = (Math.log(t) - mu) / (sigma * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

const RATE_EPS = 1e-12;

/**
 * Cholesky decomposition of a 4×4 symmetric positive-semidefinite matrix.
 * Returns lower-triangular L such that L × Lᵀ = A.
 * Falls back to diagonal sqrt if the matrix isn't positive-definite.
 */
function cholesky4(a: number[][]): number[][] {
  const L = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) sum -= L[i][k] * L[j][k];
      if (i === j) {
        if (sum <= 0) sum = a[i][i] > 0 ? a[i][i] * 1e-8 : 1e-16;
        L[i][j] = Math.sqrt(sum);
      } else {
        L[i][j] = L[j][j] > 0 ? sum / L[j][j] : 0;
      }
    }
  }
  return L;
}

/**
 * Compute confidence bands via the unscented transform (sigma points).
 *
 * Uses 2n+1 = 9 deterministic sigma points for θ = [p, mu, sigma, onset].
 * Evaluates rate(t) = p × CDF(t; onset, mu, sigma) at each point,
 * computes weighted mean and variance, then derives bands via normal
 * quantiles.  Handles the onset nonlinearity correctly (no Jacobian),
 * respects the onset-mu correlation, and is trivially fast (9 CDF
 * evaluations per tau step).
 */
function computeBands(
  ages: number[], p: number, mu: number, sigma: number, onset: number,
  pSd: number, muSd: number, sigmaSd: number, onsetSd: number,
  onsetMuCorr: number,
): { u90: number[]; l90: number[]; u99: number[]; l99: number[] } {
  const n = 4; // parameter dimension
  // Tuning: kappa=3-n=−1 is standard for Gaussian; alpha/beta from UKF literature.
  const alpha = 1e-3;
  const beta = 2;
  const kappa = 3 - n;
  const lambda = alpha * alpha * (n + kappa) - n;
  const c = n + lambda;
  const sqrtC = Math.sqrt(c);

  // Weights
  const w0m = lambda / c;
  const w0c = lambda / c + (1 - alpha * alpha + beta);
  const wi = 1 / (2 * c);

  // Build covariance matrix [p, mu, sigma, onset]
  const sds = [pSd, muSd, sigmaSd, onsetSd];
  const cov: number[][] = [
    [sds[0]**2, 0, 0, 0],
    [0, sds[1]**2, 0, 0],
    [0, 0, sds[2]**2, 0],
    [0, 0, 0, sds[3]**2],
  ];
  // onset-mu correlation
  cov[3][1] = cov[1][3] = onsetMuCorr * onsetSd * muSd;

  const L = cholesky4(cov);
  const mean = [p, mu, sigma, onset];

  // Generate 2n+1 = 9 sigma points
  const sigmaPoints: number[][] = [mean.slice()];
  for (let i = 0; i < n; i++) {
    const plus = mean.slice();
    const minus = mean.slice();
    for (let j = 0; j < n; j++) {
      plus[j] += sqrtC * L[j][i];
      minus[j] -= sqrtC * L[j][i];
    }
    // Clip to valid ranges
    plus[0] = Math.max(1e-6, Math.min(1 - 1e-6, plus[0]));   // p ∈ (0,1)
    minus[0] = Math.max(1e-6, Math.min(1 - 1e-6, minus[0]));
    plus[2] = Math.max(0.01, plus[2]);                         // sigma > 0
    minus[2] = Math.max(0.01, minus[2]);
    sigmaPoints.push(plus);
    sigmaPoints.push(minus);
  }

  const weights_m = [w0m, ...Array(2 * n).fill(wi)];
  const weights_c = [w0c, ...Array(2 * n).fill(wi)];

  const u90: number[] = []; const l90: number[] = [];
  const u99: number[] = []; const l99: number[] = [];

  for (const t of ages) {
    // Evaluate rate at each sigma point
    const rates: number[] = [];
    for (const sp of sigmaPoints) {
      const r = Math.max(0, Math.min(1, sp[0] * shiftedLognormalCdf(t, sp[3], sp[1], sp[2])));
      rates.push(r);
    }

    // Weighted mean
    let wmean = 0;
    for (let i = 0; i < rates.length; i++) wmean += weights_m[i] * rates[i];
    wmean = Math.max(0, Math.min(1, wmean));

    // Weighted variance
    let wvar = 0;
    for (let i = 0; i < rates.length; i++) {
      const d = rates[i] - wmean;
      wvar += weights_c[i] * d * d;
    }
    const sd = Math.sqrt(Math.max(wvar, 0));

    if (sd < RATE_EPS || wmean < RATE_EPS) {
      u90.push(wmean); l90.push(wmean); u99.push(wmean); l99.push(wmean);
    } else {
      // Bands in rate space, clamped to [0, 1]
      u90.push(Math.min(1, wmean + 1.645 * sd));
      l90.push(Math.max(0, wmean - 1.645 * sd));
      u99.push(Math.min(1, wmean + 2.576 * sd));
      l99.push(Math.max(0, wmean - 2.576 * sd));
    }
  }
  return { u90, l90, u99, l99 };
}

export interface ModelRateChartProps {
  edgeP?: number | null; edgeMu?: number | null; edgeSigma?: number | null; edgeOnset?: number | null;
  edgePSd?: number | null; edgeMuSd?: number | null; edgeSigmaSd?: number | null; edgeOnsetSd?: number | null;
  edgeOnsetMuCorr?: number | null; edgeT95?: number | null;
  pathP?: number | null; pathMu?: number | null; pathSigma?: number | null; pathOnset?: number | null;
  pathPSd?: number | null; pathMuSd?: number | null; pathSigmaSd?: number | null; pathOnsetSd?: number | null;
  pathOnsetMuCorr?: number | null; pathT95?: number | null;
}

/** Build a polygon band series (custom renderer) for ECharts. */
function bandPolygon(name: string, ages: number[], upper: number[], lower: number[], fill: string, z: number, smooth = 0.3) {
  const data = ages.map((t, i) => [t, upper[i], lower[i]]);
  return {
    name, type: 'custom' as any, z, silent: true,
    coordinateSystem: 'cartesian2d', encode: { x: 0, y: 1 },
    renderItem: (params: any, api: any) => {
      if (params.dataIndex !== 0) return;
      const pts: number[][] = [];
      for (let i = 0; i < data.length; i++) pts.push(api.coord([data[i][0], data[i][1]]));
      for (let i = data.length - 1; i >= 0; i--) pts.push(api.coord([data[i][0], data[i][2]]));
      return { type: 'polygon', shape: { points: pts, smooth }, style: { fill, stroke: 'none' }, silent: true };
    },
    data,
  };
}

/** Source-agnostic CDF spark chart with optional confidence bands.
 *  Exported as ModelRateChart for use by ModelCard and other consumers.
 *  Renders edge (solid) and path (dashed) CDF curves with 90%/99% bands when SDs are provided.
 */
export const ModelRateChart = React.memo(function ModelRateChart(props: ModelRateChartProps) {
  const hasEdge = props.edgeP != null;
  const hasEdgeLat = hasEdge && props.edgeMu != null && props.edgeSigma != null;
  const hasPath = props.pathP != null;
  const hasPathLat = hasPath && props.pathMu != null && props.pathSigma != null;
  if (!hasEdge && !hasPath) return null;

  const option = useMemo(() => {
    const maxDays = Math.ceil(Math.max(props.edgeT95 ?? 0, props.pathT95 ?? 0, 5));
    const steps = Math.min(maxDays, 120);
    const ages = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * maxDays);

    const series: any[] = [];

    // Edge (window)
    if (hasEdge) {
      const ep = props.edgeP!;
      if (hasEdgeLat) {
        const emu = props.edgeMu!; const esig = props.edgeSigma!; const eon = props.edgeOnset ?? 0;
        const bands = computeBands(ages, ep, emu, esig, eon,
          props.edgePSd ?? 0, props.edgeMuSd ?? 0, props.edgeSigmaSd ?? 0, props.edgeOnsetSd ?? 0,
          props.edgeOnsetMuCorr ?? 0);
        series.push(bandPolygon('_e99', ages, bands.u99, bands.l99, 'rgba(96,165,250,0.08)', 0));
        series.push(bandPolygon('_e90', ages, bands.u90, bands.l90, 'rgba(96,165,250,0.15)', 1));
        series.push({
          name: 'Edge (window)', type: 'line', showSymbol: false, smooth: true, z: 3,
          lineStyle: { width: 1.5, color: '#60a5fa' },
          data: ages.map(t => [t, ep * shiftedLognormalCdf(t, eon, emu, esig)]),
        });
      } else {
        // Prob-only: flat line at p with bands from pSd
        const pSd = props.edgePSd ?? 0;
        if (pSd > 0) {
          series.push(bandPolygon('_e99', ages, ages.map(() => Math.min(1, ep + 2.576 * pSd)), ages.map(() => Math.max(0, ep - 2.576 * pSd)), 'rgba(96,165,250,0.08)', 0, 0));
          series.push(bandPolygon('_e90', ages, ages.map(() => Math.min(1, ep + 1.645 * pSd)), ages.map(() => Math.max(0, ep - 1.645 * pSd)), 'rgba(96,165,250,0.15)', 1, 0));
        }
        series.push({
          name: 'Edge (window)', type: 'line', showSymbol: false, smooth: false, z: 3,
          lineStyle: { width: 1.5, color: '#60a5fa' },
          data: ages.map(t => [t, ep]),
        });
      }
    }

    // Path (cohort)
    if (hasPath) {
      const pp = props.pathP!;
      if (hasPathLat) {
        const pmu = props.pathMu!; const psig = props.pathSigma!; const pon = props.pathOnset ?? 0;
        const bands = computeBands(ages, pp, pmu, psig, pon,
          props.pathPSd ?? 0, props.pathMuSd ?? 0, props.pathSigmaSd ?? 0, props.pathOnsetSd ?? 0,
          props.pathOnsetMuCorr ?? 0);
        series.push(bandPolygon('_p99', ages, bands.u99, bands.l99, 'rgba(245,158,11,0.08)', 0));
        series.push(bandPolygon('_p90', ages, bands.u90, bands.l90, 'rgba(245,158,11,0.15)', 1));
        series.push({
          name: 'Path (cohort)', type: 'line', showSymbol: false, smooth: true, z: 3,
          lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' },
          data: ages.map(t => [t, pp * shiftedLognormalCdf(t, pon, pmu, psig)]),
        });
      } else {
        // Prob-only: flat line at p with bands from pSd
        const pSd = props.pathPSd ?? 0;
        if (pSd > 0) {
          series.push(bandPolygon('_p99', ages, ages.map(() => Math.min(1, pp + 2.576 * pSd)), ages.map(() => Math.max(0, pp - 2.576 * pSd)), 'rgba(245,158,11,0.08)', 0, 0));
          series.push(bandPolygon('_p90', ages, ages.map(() => Math.min(1, pp + 1.645 * pSd)), ages.map(() => Math.max(0, pp - 1.645 * pSd)), 'rgba(245,158,11,0.15)', 1, 0));
        }
        series.push({
          name: 'Path (cohort)', type: 'line', showSymbol: false, smooth: false, z: 3,
          lineStyle: { width: 1.5, color: '#f59e0b', type: 'dashed' },
          data: ages.map(t => [t, pp]),
        });
      }
    }

    return {
      animation: false,
      grid: { left: 30, right: 8, top: 6, bottom: 20 },
      legend: { show: false },
      xAxis: {
        type: 'value' as const, min: 0, max: maxDays,
        name: 'days', nameLocation: 'end' as const,
        nameTextStyle: { fontSize: 8, color: '#666', padding: [0, 0, 0, -20] },
        axisLabel: { fontSize: 8, color: '#888' },
        axisLine: { lineStyle: { color: '#444' } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value' as const, min: 0,
        name: 'rate',
        nameTextStyle: { fontSize: 8, color: '#666' },
        axisLabel: { fontSize: 8, color: '#888', formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        axisLine: { lineStyle: { color: '#444' } },
        splitLine: { show: false },
      },
      tooltip: {
        trigger: 'axis' as const,
        backgroundColor: 'rgba(30,30,30,0.9)',
        borderColor: '#444',
        textStyle: { fontSize: 9, color: '#ddd' },
        formatter: (params: any) => {
          if (!Array.isArray(params) || params.length === 0) return '';
          const tau = params[0].value[0].toFixed(1);
          const lines = params
            .filter((p: any) => !p.seriesName.startsWith('_'))
            .map((p: any) => `<span style="color:${p.color}">&#x25cf;</span> ${p.seriesName}: ${(p.value[1] * 100).toFixed(1)}%`);
          return `${tau}d<br/>${lines.join('<br/>')}`;
        },
      },
      series,
    };
  }, [
    props.edgeP, props.edgeMu, props.edgeSigma, props.edgeOnset,
    props.edgePSd, props.edgeMuSd, props.edgeSigmaSd, props.edgeOnsetSd, props.edgeOnsetMuCorr, props.edgeT95,
    props.pathP, props.pathMu, props.pathSigma, props.pathOnset,
    props.pathPSd, props.pathMuSd, props.pathSigmaSd, props.pathOnsetSd, props.pathOnsetMuCorr, props.pathT95,
    hasEdge, hasEdgeLat, hasPath, hasPathLat,
  ]);

  // Measure container with ResizeObserver and feed explicit pixel dimensions to ECharts.
  // echarts-for-react skips its first resize callback (isInitialResize guard), so on F5
  // the sidebar may not be at final width when ECharts inits → chart renders tiny.
  // Driving dimensions from observed container size avoids the race entirely.
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) {
        const h = Math.min(Math.round(w / 1.6), 320);
        setDims(prev => (prev && prev.w === w && prev.h === h) ? prev : { w, h });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const echartsRef = useRef<any>(null);
  // When dims change, tell the existing ECharts instance to resize
  useEffect(() => {
    if (!dims) return;
    const inst = echartsRef.current?.getEchartsInstance?.();
    if (inst) {
      try { inst.resize({ width: dims.w, height: dims.h }); } catch { /* noop */ }
    }
  }, [dims]);

  const hasBands = (hasEdge && (props.edgePSd ?? 0) > 0) || (hasPath && (props.pathPSd ?? 0) > 0);
  return (
    <div style={{ width: '100%', marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 8, color: '#aaa', padding: '0 2px 2px', flexWrap: 'wrap' }}>
        {hasEdge && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '1.5px solid #60a5fa' }} />Edge (window)
          </span>
        )}
        {hasPath && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '1.5px dashed #f59e0b' }} />Path (cohort)
          </span>
        )}
        {hasBands && <span style={{ marginLeft: 'auto', color: '#666', fontSize: 7 }}>shading: 90% / 99% HDI</span>}
      </div>
      <div ref={containerRef} style={{ width: '100%' }}>
      {dims && <ReactECharts ref={echartsRef} option={option} style={{ width: dims.w, height: dims.h }} notMerge lazyUpdate />}
      </div>
    </div>
  );
});
