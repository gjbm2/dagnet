/**
 * BayesPosteriorCard — posterior display for edge_info Model tab.
 *
 * Wide: two-column (Edge | Path) with whitespace separation.
 * Narrow: stacked single-column.
 * No grid lines — uses spacing and muted headers like the rest of the app.
 */

import React from 'react';
import { useElementSize } from '../../hooks/useElementSize';
import type { ProbabilityPosterior, LatencyPosterior } from '../../types';
import { computeQualityTier, qualityTierToColour, qualityTierLabel } from '../../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel, freshnessColour } from '../../utils/freshnessDisplay';

const WIDE_BREAKPOINT = 340;

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
  theme?: 'light' | 'dark';
}

export function BayesPosteriorCard({ probability, latency, theme = 'dark' }: Props) {
  const { ref, width } = useElementSize<HTMLDivElement>();
  const wide = width >= WIDE_BREAKPOINT;

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
    return <div ref={ref} style={{ padding: 10, color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 }}>No posterior available</div>;
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
      <Row label="μ" value={`${fmt(lat!.mu_mean, 3)} ± ${fmt(lat!.mu_sd, 3)}`} />
      <Row label="σ" value={`${fmt(lat!.sigma_mean, 3)} ± ${fmt(lat!.sigma_sd, 3)}`} />
      {lat!.hdi_t95_lower != null && <Row label="t95" value={`${fmt(lat!.hdi_t95_lower, 1)}d — ${fmt(lat!.hdi_t95_upper, 1)}d`} />}
    </>
  ) : null;

  const pathLatRows = hasPathLat ? (
    <>
      <Row label="onset" value={`${fmt(lat!.path_onset_delta_days, 1)}d${lat!.path_onset_sd != null ? ` ± ${fmt(lat!.path_onset_sd, 1)}d` : ''}`} />
      <Row label="μ" value={`${fmt(lat!.path_mu_mean, 3)} ± ${fmt(lat!.path_mu_sd, 3)}`} />
      <Row label="σ" value={`${fmt(lat!.path_sigma_mean, 3)} ± ${fmt(lat!.path_sigma_sd, 3)}`} />
      {(lat as any)?.path_hdi_t95_lower != null && <Row label="t95" value={`${fmt((lat as any).path_hdi_t95_lower, 1)}d — ${fmt((lat as any).path_hdi_t95_upper, 1)}d`} />}
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

  // ── Wide: two columns ──
  if (wide && hasPath) {
    const colStyle: React.CSSProperties = { flex: 1, minWidth: 0 };
    return (
      <div ref={ref} style={{ padding: '4px 10px 6px' }}>
        {/* Column headers */}
        <div style={{ display: 'flex', gap: 20, marginBottom: 2 }}>
          <div style={{ ...colStyle, fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)' }}>
            Edge (window)
          </div>
          <div style={{ ...colStyle, fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)' }}>
            Path (cohort)
          </div>
        </div>

        {/* Probability */}
        {(edgeProbRows || pathProbRows) && (
          <>
            <SectionLabel>Probability</SectionLabel>
            <div style={{ display: 'flex', gap: 20 }}>
              <div style={colStyle}>{edgeProbRows}</div>
              <div style={colStyle}>{pathProbRows}</div>
            </div>
          </>
        )}

        {/* Latency */}
        {(edgeLatRows || pathLatRows) && (
          <>
            <SectionLabel>Latency</SectionLabel>
            <div style={{ display: 'flex', gap: 20 }}>
              <div style={colStyle}>{edgeLatRows}</div>
              <div style={colStyle}>{pathLatRows}</div>
            </div>
          </>
        )}

        {footer}
      </div>
    );
  }

  // ── Narrow: stacked ──
  return (
    <div ref={ref} style={{ padding: '4px 10px 6px' }}>
      {edgeProbRows && <><SectionLabel>Probability</SectionLabel>{edgeProbRows}</>}
      {pathProbRows && <><SectionLabel>Probability (path)</SectionLabel>{pathProbRows}</>}
      {edgeLatRows && <><SectionLabel>Latency (edge)</SectionLabel>{edgeLatRows}</>}
      {pathLatRows && <><SectionLabel>Latency (path)</SectionLabel>{pathLatRows}</>}
      {footer}
    </div>
  );
}
