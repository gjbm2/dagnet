/**
 * BayesPosteriorCard — posterior display for edge_info Model tab.
 *
 * Uses CSS flex-wrap for responsive two-column (wide) / stacked (narrow) layout.
 * No grid lines — uses spacing and muted headers like the rest of the app.
 */

import React, { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import type { ProbabilityPosterior, LatencyPosterior } from '../../types';
import { computeQualityTier, qualityTierToColour, qualityTierLabel } from '../../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel, freshnessColour } from '../../utils/freshnessDisplay';

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
}

export function BayesPosteriorCard({ probability, latency, t95, pathT95, theme = 'dark' }: Props) {
  const post = probability;
  const lat = latency;

  const hasEdgeP = post?.alpha != null && post?.beta != null;
  const pa = (post as any)?.path_alpha;
  const pb = (post as any)?.path_beta;
  const hasPathP = pa != null && pb != null;
  const hasEdgeLat = lat?.mu_mean != null;
  const hasPathLat = lat?.path_mu_mean != null;
  const hasPath = hasPathP || hasPathLat;

  if (!hasEdgeP && !hasEdgeLat) {
    return <div style={{ padding: 10, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>No posterior available</div>;
  }

  const edgePMean = hasEdgeP ? post!.alpha / (post!.alpha + post!.beta) : null;
  const edgePSd = hasEdgeP ? Math.sqrt(post!.alpha * post!.beta / ((post!.alpha + post!.beta) ** 2 * (post!.alpha + post!.beta + 1))) : null;
  const pathPMean = hasPathP ? pa / (pa + pb) : null;
  const pathPSd = hasPathP ? Math.sqrt(pa * pb / ((pa + pb) ** 2 * (pa + pb + 1))) : null;

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

  // ── Shared components ──
  const Label = ({ children }: { children: string }) => (
    <span style={{ color: 'var(--text-muted, #999)', fontSize: 10 }}>{children}</span>
  );
  const Value = ({ children }: { children: string }) => (
    <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>{children}</span>
  );
  const Row = ({ label, value }: { label: string; value: string }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, lineHeight: '17px' }}>
      <Label>{label}</Label><Value>{value}</Value>
    </div>
  );
  const SectionLabel = ({ children }: { children: string }) => (
    <div style={{
      fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
      color: 'var(--text-muted, #777)', marginBottom: 2, marginTop: 8,
    }}>{children}</div>
  );

  // ── Build column content ──
  const edgeProbRows = hasEdgeP ? (
    <>
      <Row label="p" value={`${fmtPct(edgePMean)} ± ${fmtPct(edgePSd)}`} />
      {post!.hdi_lower != null && <Row label="HDI" value={`${fmtPct(post!.hdi_lower)} — ${fmtPct(post!.hdi_upper)}`} />}
    </>
  ) : null;

  const pathProbRows = hasPathP ? (
    <>
      <Row label="p" value={`${fmtPct(pathPMean)} ± ${fmtPct(pathPSd)}`} />
      {(post as any)?.path_hdi_lower != null && <Row label="HDI" value={`${fmtPct((post as any).path_hdi_lower)} — ${fmtPct((post as any).path_hdi_upper)}`} />}
    </>
  ) : null;

  const edgeLatRows = hasEdgeLat ? (
    <>
      <Row label="onset" value={`${fmt(lat!.onset_delta_days ?? lat!.onset_mean, 1)}d${lat!.onset_sd != null ? ` ± ${fmt(lat!.onset_sd, 1)}d` : ''}`} />
      {lat!.onset_hdi_lower != null && <Row label="onset HDI" value={`${fmt(lat!.onset_hdi_lower, 1)}d — ${fmt(lat!.onset_hdi_upper, 1)}d`} />}
      <Row label="μ" value={`${fmt(lat!.mu_mean, 3)} ± ${fmt(lat!.mu_sd, 3)}`} />
      <Row label="σ" value={`${fmt(lat!.sigma_mean, 3)} ± ${fmt(lat!.sigma_sd, 3)}`} />
      {lat!.hdi_t95_lower != null && <Row label="t95 HDI" value={`${fmt(lat!.hdi_t95_lower, 1)}d — ${fmt(lat!.hdi_t95_upper, 1)}d`} />}
      {lat!.onset_mu_corr != null && <Row label="onset↔μ" value={fmt(lat!.onset_mu_corr, 3)} />}
    </>
  ) : null;

  const pathLatRows = hasPathLat ? (
    <>
      <Row label="onset" value={`${fmt(lat!.path_onset_delta_days, 1)}d${lat!.path_onset_sd != null ? ` ± ${fmt(lat!.path_onset_sd, 1)}d` : ''}`} />
      {lat!.path_onset_hdi_lower != null && <Row label="onset HDI" value={`${fmt(lat!.path_onset_hdi_lower, 1)}d — ${fmt(lat!.path_onset_hdi_upper, 1)}d`} />}
      <Row label="μ" value={`${fmt(lat!.path_mu_mean, 3)} ± ${fmt(lat!.path_mu_sd, 3)}`} />
      <Row label="σ" value={`${fmt(lat!.path_sigma_mean, 3)} ± ${fmt(lat!.path_sigma_sd, 3)}`} />
      {(lat as any)?.path_hdi_t95_lower != null && <Row label="t95 HDI" value={`${fmt((lat as any).path_hdi_t95_lower, 1)}d — ${fmt((lat as any).path_hdi_t95_upper, 1)}d`} />}
      {(lat as any)?.path_onset_mu_corr != null && <Row label="onset↔μ" value={fmt((lat as any).path_onset_mu_corr, 3)} />}
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
      <BayesModelRateChart
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

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Compute the SD of rate(t) via the covariance-aware delta method. */
function rateSd(
  t: number, p: number, mu: number, sigma: number, onset: number,
  pSd: number, muSd: number, sigmaSd: number, onsetSd: number,
  onsetMuCorr: number,
): number {
  const cdf = shiftedLognormalCdf(t, onset, mu, sigma);
  const age = t - onset;
  if (age > 0 && sigma > 0) {
    const z = (Math.log(age) - mu) / sigma;
    const phi = Math.exp(-0.5 * z * z) / SQRT_2PI;
    const drDp = cdf;
    const drDmu = p * (-phi / sigma);
    const drDsigma = p * (-phi * z / sigma);
    const drDonset = p * (-phi / (sigma * age));
    let v = 0;
    if (pSd > 0) v += drDp ** 2 * pSd ** 2;
    if (muSd > 0) v += drDmu ** 2 * muSd ** 2;
    if (sigmaSd > 0) v += drDsigma ** 2 * sigmaSd ** 2;
    if (onsetSd > 0) v += drDonset ** 2 * onsetSd ** 2;
    if (onsetMuCorr !== 0 && onsetSd > 0 && muSd > 0) {
      v += 2 * drDonset * drDmu * onsetMuCorr * onsetSd * muSd;
    }
    return Math.sqrt(Math.max(v, 0));
  }
  if (pSd > 0 && cdf > 0) return cdf * pSd;
  return 0;
}

function computeBands(
  ages: number[], p: number, mu: number, sigma: number, onset: number,
  pSd: number, muSd: number, sigmaSd: number, onsetSd: number,
  onsetMuCorr: number,
): { u90: number[]; l90: number[]; u99: number[]; l99: number[] } {
  const u90: number[] = []; const l90: number[] = [];
  const u99: number[] = []; const l99: number[] = [];
  for (const t of ages) {
    const rate = p * shiftedLognormalCdf(t, onset, mu, sigma);
    const sd = rateSd(t, p, mu, sigma, onset, pSd, muSd, sigmaSd, onsetSd, onsetMuCorr);
    u90.push(Math.min(1, rate + 1.645 * sd));
    l90.push(Math.max(0, rate - 1.645 * sd));
    u99.push(Math.min(1, rate + 2.576 * sd));
    l99.push(Math.max(0, rate - 2.576 * sd));
  }
  return { u90, l90, u99, l99 };
}

interface ModelRateChartProps {
  edgeP?: number | null; edgeMu?: number | null; edgeSigma?: number | null; edgeOnset?: number | null;
  edgePSd?: number | null; edgeMuSd?: number | null; edgeSigmaSd?: number | null; edgeOnsetSd?: number | null;
  edgeOnsetMuCorr?: number | null; edgeT95?: number | null;
  pathP?: number | null; pathMu?: number | null; pathSigma?: number | null; pathOnset?: number | null;
  pathPSd?: number | null; pathMuSd?: number | null; pathSigmaSd?: number | null; pathOnsetSd?: number | null;
  pathOnsetMuCorr?: number | null; pathT95?: number | null;
}

/** Build a polygon band series (custom renderer) for ECharts. */
function bandPolygon(name: string, ages: number[], upper: number[], lower: number[], fill: string, z: number) {
  const data = ages.map((t, i) => [t, upper[i], lower[i]]);
  return {
    name, type: 'custom' as any, z, silent: true,
    coordinateSystem: 'cartesian2d', encode: { x: 0, y: 1 },
    renderItem: (params: any, api: any) => {
      if (params.dataIndex !== 0) return;
      const pts: number[][] = [];
      for (let i = 0; i < data.length; i++) pts.push(api.coord([data[i][0], data[i][1]]));
      for (let i = data.length - 1; i >= 0; i--) pts.push(api.coord([data[i][0], data[i][2]]));
      return { type: 'polygon', shape: { points: pts, smooth: 0.3 }, style: { fill, stroke: 'none' }, silent: true };
    },
    data,
  };
}

const BayesModelRateChart = React.memo(function BayesModelRateChart(props: ModelRateChartProps) {
  const hasEdge = props.edgeP != null && props.edgeMu != null && props.edgeSigma != null;
  const hasPath = props.pathP != null && props.pathMu != null && props.pathSigma != null;
  if (!hasEdge && !hasPath) return null;

  const option = useMemo(() => {
    const maxDays = Math.ceil(Math.max(props.edgeT95 ?? 0, props.pathT95 ?? 0, 5));
    const steps = Math.min(maxDays, 120);
    const ages = Array.from({ length: steps + 1 }, (_, i) => (i / steps) * maxDays);

    const series: any[] = [];

    // Edge (window)
    if (hasEdge) {
      const ep = props.edgeP!; const emu = props.edgeMu!; const esig = props.edgeSigma!; const eon = props.edgeOnset ?? 0;
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
    }

    // Path (cohort)
    if (hasPath) {
      const pp = props.pathP!; const pmu = props.pathMu!; const psig = props.pathSigma!; const pon = props.pathOnset ?? 0;
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
    }

    return {
      animation: false,
      grid: { left: 30, right: 8, top: 28, bottom: 20 },
      legend: {
        show: true, top: 0, left: 0, itemWidth: 14, itemHeight: 8, itemGap: 8,
        textStyle: { fontSize: 7, color: '#aaa' },
        data: series.filter(s => !s.name.startsWith('_')).map(s => s.name),
      },
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
    hasEdge, hasPath,
  ]);

  return <ReactECharts option={option} style={{ height: 150, marginTop: 6 }} notMerge lazyUpdate />;
});
