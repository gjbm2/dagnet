/**
 * ModelCard — uniform model_vars source-card renderer.
 *
 * Renders a `ModelVarsEntry` (analytic or bayesian) as: probability + latency
 * params grid (edge + path columns), spark CDF chart, and — for bayesian
 * source only — a quality footer and reset/delete actions bar.
 *
 * Contract: this card reads ONLY from the supplied `entry: ModelVarsEntry`.
 * It does NOT consume `edge.p.posterior`, `edge.p.latency.posterior`,
 * `edge.p.{mean, stdev, latency.t95, latency.promoted_*}`, or any other
 * outside-model_vars surface. The card's job is to display the model
 * source's own view; everything else (live current-answer scalars, DSL-
 * recontexted posterior projections, etc.) is for other widgets.
 */

import React from 'react';
import type { ModelVarsEntry } from '../../types';
import { ModelRateChart } from './BayesPosteriorCard';
import { computeQualityTier, qualityTierToColour, qualityTierLabel } from '../../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel, freshnessColour } from '../../utils/freshnessDisplay';
import GlossaryTooltip from '../GlossaryTooltip';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '–';
  return `${(v * 100).toFixed(1)}%`;
}
function fmt(v: number | null | undefined, dp = 4): string {
  if (v == null) return '–';
  return v.toFixed(dp);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ModelCardProps {
  /** The model_vars entry to display — sole data source. */
  entry: ModelVarsEntry;
  /** Theme for chart rendering */
  theme?: 'light' | 'dark';
  /** Bayesian-specific: reset priors callback */
  onResetPriors?: () => void;
  /** Bayesian-specific: delete history callback */
  onDeleteHistory?: () => void;
  /** Timestamp label (e.g. "Retrieved", "Computed", "Fitted") */
  timestampLabel?: string;
}

// ── Shared sub-components ────────────────────────────────────────────────────

const Label = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: 'var(--text-muted, #999)', fontSize: 10 }}>{children}</span>
);
const Value = ({ children, muted }: { children: string; muted?: boolean }) => (
  <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', ...(muted ? { color: 'var(--text-muted, #999)' } : {}) }}>{children}</span>
);
const Row = ({ label, value, muted, term }: { label: string; value: string; muted?: boolean; term?: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, lineHeight: '17px' }}>
    <Label>{term ? <GlossaryTooltip term={term}>{label}</GlossaryTooltip> : label}</Label>
    <Value muted={muted}>{value}</Value>
  </div>
);
const SectionLabel = ({ children }: { children: string }) => (
  <div style={{
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
    color: 'var(--text-muted, #777)', marginBottom: 2, marginTop: 8,
  }}>{children}</div>
);

// ── Main component ──────────────────────────────────────────────────────────

export function ModelCard({
  entry, theme = 'dark',
  onResetPriors, onDeleteHistory, timestampLabel,
}: ModelCardProps) {
  const lat = entry.latency;
  const isBayesian = entry.source === 'bayesian';
  const probMean = entry.probability.mean;
  const probStdev = entry.probability.stdev;
  const hasProbStdev = typeof probStdev === 'number' && probStdev > 0;

  // Empty-latency case: probability-only display.
  if (!lat) {
    return (
      <div style={{ padding: '4px 10px 6px' }}>
        <SectionLabel>Probability</SectionLabel>
        <Row label="p" term="probability" value={`${fmtPct(probMean)}${hasProbStdev ? ` ± ${fmtPct(probStdev)}` : ''}`} />
        {timestampLabel && entry.source_at && (
          <div style={{ fontSize: 10, color: 'var(--text-muted, #999)', marginTop: 4 }}>
            {timestampLabel}: {entry.source_at}
          </div>
        )}
        {isBayesian && <BayesianFooter entry={entry} theme={theme} onResetPriors={onResetPriors} onDeleteHistory={onDeleteHistory} />}
      </div>
    );
  }

  const hasPath = lat.path_mu != null;
  const hasLatencySds = (lat.mu_sd != null && lat.mu_sd > 0)
    || (lat.sigma_sd != null && lat.sigma_sd > 0)
    || (lat.onset_sd != null && lat.onset_sd > 0);

  // Build edge latency rows
  const edgeLatRows = (
    <>
      <Row label="onset" term="onset" value={`${fmt(lat.onset_delta_days, 1)}d${lat.onset_sd != null && lat.onset_sd > 0 ? ` ± ${fmt(lat.onset_sd, 1)}d` : ''}`}
           muted={!!lat.onset_sd} />
      <Row label="μ" term="mu" value={`${fmt(lat.mu, 3)}${lat.mu_sd != null && lat.mu_sd > 0 ? ` ± ${fmt(lat.mu_sd, 3)}` : ''}`}
           muted={!!lat.mu_sd} />
      <Row label="σ" term="sigma" value={`${fmt(lat.sigma, 3)}${lat.sigma_sd != null && lat.sigma_sd > 0 ? ` ± ${fmt(lat.sigma_sd, 3)}` : ''}`}
           muted={!!lat.sigma_sd} />
      <Row label="t95" term="t95" value={`${fmt(lat.t95, 1)}d`} />
      {lat.onset_mu_corr != null && lat.onset_mu_corr !== 0 && (
        <Row label="onset↔μ" term="onset-mu-corr" value={fmt(lat.onset_mu_corr, 3)} muted />
      )}
    </>
  );

  // Build path latency rows
  const pathLatRows = hasPath ? (
    <>
      <Row label="onset" term="onset" value={`${fmt(lat.path_onset_delta_days, 1)}d${lat.path_onset_sd != null && lat.path_onset_sd > 0 ? ` ± ${fmt(lat.path_onset_sd, 1)}d` : ''}`}
           muted={!!lat.path_onset_sd} />
      <Row label="μ" term="mu" value={`${fmt(lat.path_mu, 3)}${lat.path_mu_sd != null && lat.path_mu_sd > 0 ? ` ± ${fmt(lat.path_mu_sd, 3)}` : ''}`}
           muted={!!lat.path_mu_sd} />
      <Row label="σ" term="sigma" value={`${fmt(lat.path_sigma, 3)}${lat.path_sigma_sd != null && lat.path_sigma_sd > 0 ? ` ± ${fmt(lat.path_sigma_sd, 3)}` : ''}`}
           muted={!!lat.path_sigma_sd} />
      {lat.path_t95 != null && <Row label="t95" term="path-t95" value={`${fmt(lat.path_t95, 1)}d`} />}
    </>
  ) : null;

  return (
    <div style={{ padding: '4px 10px 6px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 20px' }}>
        {/* Edge column */}
        <div style={{ flex: '1 1 150px', minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)', marginBottom: 2 }}>
            Edge (window)
          </div>
          <SectionLabel>Probability</SectionLabel>
          <Row label="p" term="probability" value={`${fmtPct(probMean)}${hasProbStdev ? ` ± ${fmtPct(probStdev)}` : ''}`} />
          <SectionLabel>Latency</SectionLabel>
          {edgeLatRows}
        </div>
        {/* Path column */}
        {hasPath && pathLatRows && (
          <div style={{ flex: '1 1 150px', minWidth: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted, #888)', marginBottom: 2 }}>
              Path (cohort)
            </div>
            <SectionLabel>Latency</SectionLabel>
            {pathLatRows}
          </div>
        )}
      </div>
      {hasLatencySds && !isBayesian && (
        <div style={{ fontSize: 9, color: 'var(--text-muted, #999)', fontStyle: 'italic', marginTop: 4 }}>
          ± values are heuristic estimates est.
        </div>
      )}
      {timestampLabel && entry.source_at && !isBayesian && (
        <div style={{ fontSize: 10, color: 'var(--text-muted, #999)', marginTop: 4 }}>
          {timestampLabel}: {entry.source_at}
        </div>
      )}
      {/* Spark CDF chart — driven entirely from entry.{probability, latency} */}
      <ModelRateChartFromEntry entry={entry} />
      {isBayesian && (
        <BayesianFooter entry={entry} theme={theme} onResetPriors={onResetPriors} onDeleteHistory={onDeleteHistory} />
      )}
    </div>
  );
}

// ── Bayesian footer (quality tier + freshness + reset/delete actions) ──────
//
// Reads exclusively from entry.quality and entry.source_at. No `p.posterior`
// access. computeQualityTier is duck-typed against the `rhat / ess /
// divergences / evidence_grade / provenance` shape — entry.quality has
// rhat/ess/divergences/evidence_grade. provenance is read off
// entry.probability when present. Other diagnostic fields (surprise_z,
// pareto_k_max, delta_elpd) are absent on the model_vars contract; the
// tier degrades gracefully without them.

function BayesianFooter({ entry, theme, onResetPriors, onDeleteHistory }: {
  entry: ModelVarsEntry;
  theme: 'light' | 'dark';
  onResetPriors?: () => void;
  onDeleteHistory?: () => void;
}) {
  const quality = entry.quality;
  // computeQualityTier is permissive — it returns 'no-data' when rhat/ess are missing.
  const tierInput = quality
    ? {
        rhat: quality.rhat,
        ess: quality.ess,
        divergences: quality.divergences,
        evidence_grade: quality.evidence_grade,
        provenance: entry.probability.provenance,
      } as any
    : null;
  const tier = computeQualityTier(tierInput);
  const tierColour = qualityTierToColour(tier.tier, theme);

  const parts: Array<{ text: string; colour?: string }> = [];
  parts.push({ text: qualityTierLabel(tier.tier), colour: tierColour });
  if (quality?.rhat != null) parts.push({ text: `r̂ ${quality.rhat.toFixed(4)}` });
  if (quality?.ess != null) parts.push({ text: `ESS ${Math.round(quality.ess)}` });
  if (quality?.evidence_grade != null) parts.push({ text: `${quality.evidence_grade}/3` });
  if (entry.source_at) {
    const rel = formatRelativeTime(entry.source_at);
    parts.push({ text: rel ?? entry.source_at, colour: freshnessColour(getFreshnessLevel(entry.source_at), theme) });
  }

  return (
    <>
      {parts.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: '2px 10px',
          padding: '8px 0 4px', marginTop: 6,
          fontSize: 10, lineHeight: '15px', color: 'var(--text-muted, #999)',
        }}>
          {parts.map((item, i) => (
            <span key={i} style={item.colour ? { color: item.colour } : undefined}>{item.text}</span>
          ))}
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
    </>
  );
}

// ── Spark chart adapter — maps ModelVarsEntry to ModelRateChart props ──
//
// All values come from entry.{probability, latency}. No external props.
// The chart's x-axis horizon is taken from entry.latency.{t95, path_t95},
// not from any promoted/edge.p.* surface. Bands are derived from the
// entry's own epistemic dispersions.

function ModelRateChartFromEntry({ entry }: { entry: ModelVarsEntry }) {
  const lat = entry.latency;
  if (!lat || lat.mu == null || lat.sigma == null) return null;

  const probStdev = entry.probability.stdev;
  const hasProbStdev = typeof probStdev === 'number' && probStdev > 0;

  return (
    <ModelRateChart
      edgeP={entry.probability.mean}
      edgeMu={lat.mu}
      edgeSigma={lat.sigma}
      edgeOnset={lat.onset_delta_days ?? 0}
      edgePSd={hasProbStdev ? probStdev : null}
      edgeMuSd={lat.mu_sd ?? null}
      edgeSigmaSd={lat.sigma_sd ?? null}
      edgeOnsetSd={lat.onset_sd ?? null}
      edgeOnsetMuCorr={lat.onset_mu_corr ?? null}
      edgeT95={lat.t95}
      pathP={lat.path_mu != null ? entry.probability.mean : null}
      pathMu={lat.path_mu ?? null}
      pathSigma={lat.path_sigma ?? null}
      pathOnset={lat.path_onset_delta_days ?? null}
      pathPSd={lat.path_mu != null && hasProbStdev ? probStdev : null}
      pathMuSd={lat.path_mu_sd ?? null}
      pathSigmaSd={lat.path_sigma_sd ?? null}
      pathOnsetSd={lat.path_onset_sd ?? null}
      pathOnsetMuCorr={null}
      pathT95={lat.path_t95 ?? null}
    />
  );
}
