/**
 * ModelCard — generalised model parameter display for any source.
 *
 * Renders: params grid (edge + path columns), spark CDF chart with optional
 * confidence bands, and conditionally: quality footer, actions bar.
 *
 * Used by all read-only source cards (Bayesian, Analytic FE, Analytic BE).
 * Output/manual card stays separate (editable UX is different).
 *
 * See docs/current/project-bayes/heuristic-dispersion-design.md §8.3 Gap 6.
 */

import React from 'react';
import type { ProbabilityPosterior, LatencyPosterior, ModelVarsEntry } from '../../types';
import { BayesPosteriorCard, ModelRateChart } from './BayesPosteriorCard';
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
  /** The model_vars entry to display */
  entry: ModelVarsEntry;
  /** Bayesian probability posterior (only for source === 'bayesian') */
  probabilityPosterior?: ProbabilityPosterior | null;
  /** Bayesian latency posterior (only for source === 'bayesian') */
  latencyPosterior?: LatencyPosterior | null;
  /** Edge-level t95 (days) */
  t95?: number | null;
  /** Path-level t95 (days) */
  pathT95?: number | null;
  /** Theme for chart rendering */
  theme?: 'light' | 'dark';
  /** Bayesian-specific: reset priors callback */
  onResetPriors?: () => void;
  /** Bayesian-specific: delete history callback */
  onDeleteHistory?: () => void;
  /** Timestamp label (e.g. "Retrieved", "Computed") */
  timestampLabel?: string;
}

// ── Shared sub-components (inline for now — extract to own files when stable) ─

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
  entry, probabilityPosterior, latencyPosterior,
  t95, pathT95, theme = 'dark',
  onResetPriors, onDeleteHistory, timestampLabel,
}: ModelCardProps) {
  const lat = entry.latency;
  const isBayesian = entry.source === 'bayesian';

  // For Bayesian source, delegate to the existing BayesPosteriorCard
  // which handles HDI, quality footer, provenance, actions.
  if (isBayesian && (probabilityPosterior || latencyPosterior)) {
    return (
      <BayesPosteriorCard
        probability={probabilityPosterior}
        latency={latencyPosterior}
        t95={t95}
        pathT95={pathT95}
        theme={theme}
        onResetPriors={onResetPriors}
        onDeleteHistory={onDeleteHistory}
      />
    );
  }

  // Non-Bayesian: render params grid + spark chart from model_vars entry
  if (!lat) {
    return (
      <>
        <SectionLabel>Probability</SectionLabel>
        <Row label="p" term="probability" value={fmtPct(entry.probability.mean)} />
        {entry.probability.stdev > 0 && (
          <Row label="stdev" term="stdev" value={fmt(entry.probability.stdev)} muted />
        )}
        {timestampLabel && entry.source_at && <Row label={timestampLabel} value={entry.source_at} />}
      </>
    );
  }

  const hasPath = lat.path_mu != null;
  const hasSds = (lat.mu_sd != null && lat.mu_sd > 0);
  // Subtle label for heuristic SDs
  const sdSuffix = hasSds ? ' est.' : '';

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
          <Row label="p" term="probability" value={`${fmtPct(entry.probability.mean)}${entry.probability.stdev > 0 ? ` ± ${fmtPct(entry.probability.stdev)}` : ''}`} />
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
      {hasSds && (
        <div style={{ fontSize: 9, color: 'var(--text-muted, #999)', fontStyle: 'italic', marginTop: 4 }}>
          ± values are heuristic estimates{sdSuffix}
        </div>
      )}
      {timestampLabel && entry.source_at && (
        <div style={{ fontSize: 10, color: 'var(--text-muted, #999)', marginTop: 4 }}>
          {timestampLabel}: {entry.source_at}
        </div>
      )}
      {/* Spark CDF chart — reuse the existing BayesModelRateChart which is already source-agnostic */}
      <ModelRateChartFromEntry entry={entry} t95={t95} pathT95={pathT95} />
    </div>
  );
}

// ── Spark chart adapter — maps ModelVarsEntry to ModelRateChart props ──

function ModelRateChartFromEntry({ entry, t95, pathT95 }: { entry: ModelVarsEntry; t95?: number | null; pathT95?: number | null }) {
  const lat = entry.latency;
  if (!lat || lat.mu == null || lat.sigma == null) return null;

  return (
    <ModelRateChart
      edgeP={entry.probability.mean}
      edgeMu={lat.mu}
      edgeSigma={lat.sigma}
      edgeOnset={lat.onset_delta_days ?? 0}
      edgePSd={entry.probability.stdev > 0 ? entry.probability.stdev : null}
      edgeMuSd={lat.mu_sd ?? null}
      edgeSigmaSd={lat.sigma_sd ?? null}
      edgeOnsetSd={lat.onset_sd ?? null}
      edgeOnsetMuCorr={lat.onset_mu_corr ?? null}
      edgeT95={t95 ?? lat.t95}
      pathP={lat.path_mu != null ? entry.probability.mean : null}
      pathMu={lat.path_mu ?? null}
      pathSigma={lat.path_sigma ?? null}
      pathOnset={lat.path_onset_delta_days ?? null}
      pathPSd={lat.path_mu != null && entry.probability.stdev > 0 ? entry.probability.stdev : null}
      pathMuSd={lat.path_mu_sd ?? null}
      pathSigmaSd={lat.path_sigma_sd ?? null}
      pathOnsetSd={lat.path_onset_sd ?? null}
      pathOnsetMuCorr={null}
      pathT95={pathT95 ?? lat.path_t95 ?? null}
    />
  );
}
