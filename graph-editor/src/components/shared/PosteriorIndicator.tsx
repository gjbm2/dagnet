/**
 * PosteriorIndicator — reusable inline badge + diagnostic popover for Bayesian posteriors.
 *
 * Two modes:
 *   - Badge only: compact coloured dot + short label (e.g. "Strong", "Warning")
 *   - Badge + popover: hover/click the badge to see full diagnostics (InfoTable)
 *
 * Works with both ProbabilityPosterior and LatencyPosterior.
 * Generic for any parameter — attach to probability, latency, or cost params.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import ReactECharts from 'echarts-for-react';
import { computeQualityTier, qualityTierToColour, qualityTierLabel } from '../../utils/bayesQualityTier';
import { formatRelativeTime, getFreshnessLevel, freshnessColour, type FreshnessLevel } from '../../utils/freshnessDisplay';
import type { ProbabilityPosterior, LatencyPosterior, ModelSource } from '../../types';
import './posterior-indicator.css';

type Posterior = ProbabilityPosterior | LatencyPosterior;

interface PosteriorIndicatorProps {
  /** The posterior object (probability or latency). Null/undefined renders nothing. */
  posterior?: Posterior | null;
  /** Optional: evidence retrieved_at timestamp for freshness display in popover */
  retrievedAt?: string | number | null;
  /** Theme for colour mapping */
  theme?: 'light' | 'dark';
  /** When true, show only the badge (no popover on hover). Default false. */
  badgeOnly?: boolean;
  /** Active model variable source (doc 15 §14.4) — shown in popover metadata */
  activeSource?: ModelSource | null;
  /** Edge-level t95 point estimate (days) — for sparkline axis extent */
  t95?: number | null;
  /** Path-level t95 point estimate (days) — for sparkline axis extent */
  pathT95?: number | null;
}

export function PosteriorIndicator({ posterior, retrievedAt, theme = 'dark', badgeOnly = false, activeSource, t95, pathT95 }: PosteriorIndicatorProps) {
  if (!posterior) return null;

  const tier = computeQualityTier(posterior);
  const colour = qualityTierToColour(tier.tier, theme);
  const label = qualityTierLabel(tier.tier);

  const [showPopover, setShowPopover] = useState(false);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback(() => {
    if (badgeOnly) return;
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    setShowPopover(true);
  }, [badgeOnly]);

  const handleLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setShowPopover(false), 200);
  }, []);

  // Position popover above the badge using viewport coordinates (portal escapes overflow)
  const popoverPos = showPopover && badgeRef.current
    ? (() => {
        const rect = badgeRef.current!.getBoundingClientRect();
        return { left: rect.left + rect.width / 2, bottom: window.innerHeight - rect.top + 4 };
      })()
    : null;

  return (
    <span
      className="posterior-indicator"
      ref={badgeRef}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {/* Inline badge */}
      <span className="posterior-badge" style={{ color: colour }}>
        <span className="posterior-dot" style={{ background: colour }} />
        {label}
      </span>

      {/* Diagnostic popover — portalled to body to escape overflow containers */}
      {showPopover && popoverPos && ReactDOM.createPortal(
        <div
          className="posterior-popover"
          style={{
            position: 'fixed',
            left: popoverPos.left,
            bottom: popoverPos.bottom,
            transform: 'translateX(-50%)',
          }}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
        >
          <PosteriorDetails posterior={posterior} retrievedAt={retrievedAt} theme={theme} activeSource={activeSource} t95={t95} pathT95={pathT95} />
        </div>,
        document.body,
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────
// PosteriorDetails — the popover content (also usable standalone)
// ────────────────────────────────────────────────────────────

interface PosteriorDetailsProps {
  posterior: Posterior;
  retrievedAt?: string | number | null;
  theme?: 'light' | 'dark';
  activeSource?: ModelSource | null;
  t95?: number | null;
  pathT95?: number | null;
}

/** Renders a compact diagnostic summary table. Reusable in popovers and panels. */
export function PosteriorDetails({ posterior, retrievedAt, theme = 'dark', activeSource, t95, pathT95 }: PosteriorDetailsProps) {
  const tier = computeQualityTier(posterior);
  const colour = qualityTierToColour(tier.tier, theme);
  const isProbability = 'evidence_grade' in posterior;

  if (isProbability) {
    return <ProbabilityPosteriorDetails posterior={posterior as ProbabilityPosterior} tier={tier} colour={colour} retrievedAt={retrievedAt} theme={theme!} activeSource={activeSource} />;
  }
  return <LatencyPosteriorDetails posterior={posterior as LatencyPosterior} tier={tier} colour={colour} retrievedAt={retrievedAt} theme={theme!} activeSource={activeSource} t95={t95} pathT95={pathT95} />;
}

function SectionHeader({ label, theme }: { label: string; theme: 'light' | 'dark' }) {
  return (
    <tr>
      <td colSpan={2} className="posterior-details-section" style={{ color: theme === 'dark' ? '#888' : '#999', fontSize: '9px', textTransform: 'uppercase' as const, letterSpacing: '0.5px', paddingTop: 6 }}>
        {label}
      </td>
    </tr>
  );
}

function ProbabilityPosteriorDetails({ posterior, tier, colour, retrievedAt, theme, activeSource }: {
  posterior: ProbabilityPosterior; tier: ReturnType<typeof computeQualityTier>; colour: string;
  retrievedAt?: string | number | null; theme: 'light' | 'dark'; activeSource?: ModelSource | null;
}) {
  const a = posterior.alpha, b = posterior.beta;
  const pMean = a / (a + b);
  const pSd = Math.sqrt(a * b / ((a + b) ** 2 * (a + b + 1)));

  return (
    <table className="posterior-details-table">
      <tbody>
        {/* ── Estimate ── */}
        <SectionHeader label="Probability" theme={theme} />
        <tr>
          <td className="posterior-details-label">p</td>
          <td className="posterior-details-value">
            {fmtPct(pMean)} ± {fmtPct(pSd)}
          </td>
        </tr>
        {posterior.hdi_lower != null && (
          <tr>
            <td className="posterior-details-label">HDI {fmtPct(posterior.hdi_level)}</td>
            <td className="posterior-details-value">
              {fmtPct(posterior.hdi_lower)} — {fmtPct(posterior.hdi_upper)}
            </td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">Beta</td>
          <td className="posterior-details-value">α={a.toFixed(2)}  β={b.toFixed(2)}</td>
        </tr>

        {/* ── Convergence ── */}
        <SectionHeader label="Convergence" theme={theme} />
        {posterior.rhat != null && (
          <tr>
            <td className="posterior-details-label">rhat</td>
            <td className="posterior-details-value" style={posterior.rhat > 1.1 ? { color: qualityTierToColour('failed', theme) } : undefined}>
              {posterior.rhat.toFixed(4)}
            </td>
          </tr>
        )}
        {posterior.ess != null && (
          <tr>
            <td className="posterior-details-label">ESS</td>
            <td className="posterior-details-value">{Math.round(posterior.ess)}</td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">Quality</td>
          <td className="posterior-details-value" style={{ color: colour }}>
            {qualityTierLabel(tier.tier)}
          </td>
        </tr>
        {posterior.delta_elpd != null && (
          <tr>
            <td className="posterior-details-label">ΔELPD</td>
            <td className="posterior-details-value" style={posterior.delta_elpd < 0 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {posterior.delta_elpd > 0 ? '+' : ''}{posterior.delta_elpd.toFixed(2)}
            </td>
          </tr>
        )}
        {posterior.pareto_k_max != null && (
          <tr>
            <td className="posterior-details-label">Pareto k</td>
            <td className="posterior-details-value" style={posterior.pareto_k_max > 0.7 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {posterior.pareto_k_max.toFixed(3)}
            </td>
          </tr>
        )}
        {'ppc_coverage_90' in posterior && (posterior as any).ppc_coverage_90 != null && (
          <tr>
            <td className="posterior-details-label">PPC cov@90%</td>
            <td className="posterior-details-value" style={(posterior as any).ppc_coverage_90 < 0.82 || (posterior as any).ppc_coverage_90 > 0.97 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {((posterior as any).ppc_coverage_90 * 100).toFixed(0)}% <span style={{ opacity: 0.5 }}>({(posterior as any).ppc_n_obs} obs)</span>
            </td>
          </tr>
        )}
        {posterior.ppc_traj_coverage_90 != null && (
          <tr>
            <td className="posterior-details-label">PPC traj@90%</td>
            <td className="posterior-details-value" style={posterior.ppc_traj_coverage_90 < 0.82 || posterior.ppc_traj_coverage_90 > 0.97 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {(posterior.ppc_traj_coverage_90 * 100).toFixed(0)}% <span style={{ opacity: 0.5 }}>({posterior.ppc_traj_n_obs} obs)</span>
            </td>
          </tr>
        )}

        {/* ── Metadata ── */}
        <SectionHeader label="Metadata" theme={theme} />
        {activeSource && (
          <tr>
            <td className="posterior-details-label">Active source</td>
            <td className="posterior-details-value" style={{ textTransform: 'capitalize' }}>{activeSource}</td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">Provenance</td>
          <td className="posterior-details-value">{posterior.provenance}</td>
        </tr>
        {posterior.evidence_grade != null && (
          <tr>
            <td className="posterior-details-label">Evidence</td>
            <td className="posterior-details-value">{posterior.evidence_grade}/3</td>
          </tr>
        )}
        {posterior.prior_tier && (
          <tr>
            <td className="posterior-details-label">Prior</td>
            <td className="posterior-details-value">{posterior.prior_tier.replace(/_/g, ' ')}</td>
          </tr>
        )}
        {posterior.fitted_at && (
          <tr>
            <td className="posterior-details-label">Fitted</td>
            <td className="posterior-details-value" style={{ color: freshnessColour(getFreshnessLevel(posterior.fitted_at), theme) }}>
              {formatRelativeTime(posterior.fitted_at) ?? posterior.fitted_at}
            </td>
          </tr>
        )}
        {retrievedAt && (
          <tr>
            <td className="posterior-details-label">Data fetched</td>
            <td className="posterior-details-value" style={{ color: freshnessColour(getFreshnessLevel(retrievedAt), theme) }}>
              {formatRelativeTime(retrievedAt) ?? String(retrievedAt)}
            </td>
          </tr>
        )}

        {/* ── Path-level (cohort) probability ── */}
        {(posterior as any).path_alpha != null && (() => {
          const pa = (posterior as any).path_alpha;
          const pb = (posterior as any).path_beta;
          const pathMean = pa / (pa + pb);
          const pathSd = Math.sqrt(pa * pb / ((pa + pb) ** 2 * (pa + pb + 1)));
          return (
            <>
              <SectionHeader label="Path probability (cohort)" theme={theme} />
              <tr>
                <td className="posterior-details-label">p</td>
                <td className="posterior-details-value">
                  {fmtPct(pathMean)} ± {fmtPct(pathSd)}
                </td>
              </tr>
              {(posterior as any).path_hdi_lower != null && (
                <tr>
                  <td className="posterior-details-label">HDI {fmtPct(posterior.hdi_level)}</td>
                  <td className="posterior-details-value">
                    {fmtPct((posterior as any).path_hdi_lower)} — {fmtPct((posterior as any).path_hdi_upper)}
                  </td>
                </tr>
              )}
              <tr>
                <td className="posterior-details-label">Beta</td>
                <td className="posterior-details-value">α={pa.toFixed(2)}  β={pb.toFixed(2)}</td>
              </tr>
              {(posterior as any).path_provenance && (
                <tr>
                  <td className="posterior-details-label">Provenance</td>
                  <td className="posterior-details-value">{(posterior as any).path_provenance}</td>
                </tr>
              )}
            </>
          );
        })()}
      </tbody>
    </table>
  );
}

function LatencyPosteriorDetails({ posterior, tier, colour, retrievedAt, theme, activeSource, t95, pathT95 }: {
  posterior: LatencyPosterior; tier: ReturnType<typeof computeQualityTier>; colour: string;
  retrievedAt?: string | number | null; theme: 'light' | 'dark'; activeSource?: ModelSource | null;
  t95?: number | null; pathT95?: number | null;
}) {
  const hasPath = posterior.path_mu_mean != null;

  return (
    <table className="posterior-details-table">
      <tbody>
        {/* ── Edge-level (window) ── */}
        <SectionHeader label="Edge latency (window)" theme={theme} />
        <tr>
          <td className="posterior-details-label">onset δ</td>
          <td className="posterior-details-value">
            {fmtDays(posterior.onset_mean ?? posterior.onset_delta_days)}
            {posterior.onset_sd != null && <span className="posterior-details-dim"> ± {fmtDays(posterior.onset_sd)}</span>}
          </td>
        </tr>
        {posterior.onset_hdi_lower != null && (
          <tr>
            <td className="posterior-details-label">onset HDI {fmtPct(posterior.hdi_level)}</td>
            <td className="posterior-details-value">{fmtDays(posterior.onset_hdi_lower)} — {fmtDays(posterior.onset_hdi_upper)}</td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">μ</td>
          <td className="posterior-details-value">{fmtNum(posterior.mu_mean)} ± {fmtNum(posterior.mu_sd)}</td>
        </tr>
        <tr>
          <td className="posterior-details-label">σ</td>
          <td className="posterior-details-value">{fmtNum(posterior.sigma_mean)} ± {fmtNum(posterior.sigma_sd)}</td>
        </tr>
        {posterior.onset_mu_corr != null && (
          <tr>
            <td className="posterior-details-label">onset↔μ corr</td>
            <td className="posterior-details-value" style={Math.abs(posterior.onset_mu_corr) > 0.8 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {posterior.onset_mu_corr.toFixed(3)}
            </td>
          </tr>
        )}

        {/* ── Path-level (cohort) ── */}
        {hasPath && (
          <>
            <SectionHeader label="Path latency (cohort)" theme={theme} />
            <tr>
              <td className="posterior-details-label">onset δ</td>
              <td className="posterior-details-value">
                {fmtDays(posterior.path_onset_delta_days)}
                {posterior.path_onset_sd != null && <span className="posterior-details-dim"> ± {fmtDays(posterior.path_onset_sd)}</span>}
              </td>
            </tr>
            {posterior.path_onset_hdi_lower != null && (
              <tr>
                <td className="posterior-details-label">onset HDI {fmtPct(posterior.hdi_level)}</td>
                <td className="posterior-details-value">{fmtDays(posterior.path_onset_hdi_lower)} — {fmtDays(posterior.path_onset_hdi_upper)}</td>
              </tr>
            )}
            <tr>
              <td className="posterior-details-label">μ</td>
              <td className="posterior-details-value">{fmtNum(posterior.path_mu_mean)} ± {fmtNum(posterior.path_mu_sd)}</td>
            </tr>
            <tr>
              <td className="posterior-details-label">σ</td>
              <td className="posterior-details-value">{fmtNum(posterior.path_sigma_mean)} ± {fmtNum(posterior.path_sigma_sd)}</td>
            </tr>
            {posterior.path_provenance && (
              <tr>
                <td className="posterior-details-label">provenance</td>
                <td className="posterior-details-value">{posterior.path_provenance}</td>
              </tr>
            )}
          </>
        )}

        {/* ── t95 HDI ── */}
        {posterior.hdi_t95_lower != null && (
          <tr>
            <td className="posterior-details-label">t95 HDI {fmtPct(posterior.hdi_level)}</td>
            <td className="posterior-details-value">
              {posterior.hdi_t95_lower.toFixed(1)}d — {posterior.hdi_t95_upper.toFixed(1)}d
            </td>
          </tr>
        )}

        {/* ── Sparkline ── */}
        <tr>
          <td colSpan={2}>
            <LatencyCdfSparkline posterior={posterior} theme={theme} t95={t95} pathT95={pathT95} />
          </td>
        </tr>

        {/* ── Convergence ── */}
        <SectionHeader label="Convergence" theme={theme} />
        {posterior.rhat != null && (
          <tr>
            <td className="posterior-details-label">rhat</td>
            <td className="posterior-details-value" style={posterior.rhat > 1.1 ? { color: qualityTierToColour('failed', theme) } : undefined}>
              {posterior.rhat.toFixed(4)}
            </td>
          </tr>
        )}
        {posterior.ess != null && (
          <tr>
            <td className="posterior-details-label">ESS</td>
            <td className="posterior-details-value">{Math.round(posterior.ess)}</td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">Quality</td>
          <td className="posterior-details-value" style={{ color: colour }}>
            {qualityTierLabel(tier.tier)}
          </td>
        </tr>
        {posterior.delta_elpd != null && (
          <tr>
            <td className="posterior-details-label">ΔELPD</td>
            <td className="posterior-details-value" style={posterior.delta_elpd < 0 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {posterior.delta_elpd > 0 ? '+' : ''}{posterior.delta_elpd.toFixed(2)}
            </td>
          </tr>
        )}
        {posterior.pareto_k_max != null && (
          <tr>
            <td className="posterior-details-label">Pareto k</td>
            <td className="posterior-details-value" style={posterior.pareto_k_max > 0.7 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {posterior.pareto_k_max.toFixed(3)}
            </td>
          </tr>
        )}
        {'ppc_coverage_90' in posterior && (posterior as any).ppc_coverage_90 != null && (
          <tr>
            <td className="posterior-details-label">PPC cov@90%</td>
            <td className="posterior-details-value" style={(posterior as any).ppc_coverage_90 < 0.82 || (posterior as any).ppc_coverage_90 > 0.97 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {((posterior as any).ppc_coverage_90 * 100).toFixed(0)}% <span style={{ opacity: 0.5 }}>({(posterior as any).ppc_n_obs} obs)</span>
            </td>
          </tr>
        )}
        {posterior.ppc_traj_coverage_90 != null && (
          <tr>
            <td className="posterior-details-label">PPC traj@90%</td>
            <td className="posterior-details-value" style={posterior.ppc_traj_coverage_90 < 0.82 || posterior.ppc_traj_coverage_90 > 0.97 ? { color: qualityTierToColour('warning', theme) } : undefined}>
              {(posterior.ppc_traj_coverage_90 * 100).toFixed(0)}% <span style={{ opacity: 0.5 }}>({posterior.ppc_traj_n_obs} obs)</span>
            </td>
          </tr>
        )}

        {/* ── Metadata ── */}
        <SectionHeader label="Metadata" theme={theme} />
        {activeSource && (
          <tr>
            <td className="posterior-details-label">Active source</td>
            <td className="posterior-details-value" style={{ textTransform: 'capitalize' }}>{activeSource}</td>
          </tr>
        )}
        <tr>
          <td className="posterior-details-label">Provenance</td>
          <td className="posterior-details-value">{posterior.provenance}</td>
        </tr>
        {posterior.fitted_at && (
          <tr>
            <td className="posterior-details-label">Fitted</td>
            <td className="posterior-details-value" style={{ color: freshnessColour(getFreshnessLevel(posterior.fitted_at), theme) }}>
              {formatRelativeTime(posterior.fitted_at) ?? posterior.fitted_at}
            </td>
          </tr>
        )}
        {retrievedAt && (
          <tr>
            <td className="posterior-details-label">Data fetched</td>
            <td className="posterior-details-value" style={{ color: freshnessColour(getFreshnessLevel(retrievedAt), theme) }}>
              {formatRelativeTime(retrievedAt) ?? String(retrievedAt)}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

// ────────────────────────────────────────────────────────────
// Latency CDF sparkline — compact ECharts showing edge vs path curves
// ────────────────────────────────────────────────────────────

function shiftedLognormalCdf(age: number, onset: number, mu: number, sigma: number): number {
  const t = age - onset;
  if (t <= 0 || sigma <= 0) return 0;
  const z = (Math.log(t) - mu) / (sigma * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

// Approximation of the error function (Abramowitz & Stegun)
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

function LatencyCdfSparkline({ posterior, theme = 'dark', t95, pathT95 }: { posterior: LatencyPosterior; theme?: 'light' | 'dark'; t95?: number | null; pathT95?: number | null }) {
  const option = useMemo(() => {
    const edgeMu = posterior.mu_mean;
    const edgeSigma = posterior.sigma_mean;
    const edgeOnset = posterior.onset_delta_days ?? 0;
    const pathMu = posterior.path_mu_mean;
    const pathSigma = posterior.path_sigma_mean;
    const pathOnset = posterior.path_onset_delta_days ?? 0;
    const hasPath = pathMu != null && pathSigma != null;

    const maxDays = Math.ceil(Math.max(t95 ?? 0, pathT95 ?? 0, 5));
    const steps = Math.min(maxDays, 80);

    const edgeData: [number, number][] = [];
    const pathData: [number, number][] = [];
    for (let d = 0; d <= steps; d++) {
      const tau = (d / steps) * maxDays;
      edgeData.push([tau, shiftedLognormalCdf(tau, edgeOnset, edgeMu, edgeSigma)]);
      if (hasPath) {
        pathData.push([tau, shiftedLognormalCdf(tau, pathOnset, pathMu!, pathSigma!)]);
      }
    }

    const textColour = theme === 'dark' ? '#aaa' : '#666';
    const edgeColour = theme === 'dark' ? '#60a5fa' : '#2563eb';
    const pathColour = theme === 'dark' ? '#f59e0b' : '#d97706';

    return {
      animation: false,
      grid: { left: 30, right: 8, top: 8, bottom: 20 },
      xAxis: {
        type: 'value' as const, min: 0, max: maxDays,
        axisLabel: { fontSize: 9, color: textColour, formatter: '{value}d' },
        axisLine: { lineStyle: { color: textColour } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value' as const, min: 0, max: 1,
        axisLabel: { fontSize: 9, color: textColour, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
        axisLine: { lineStyle: { color: textColour } },
        splitLine: { show: false },
      },
      series: [
        {
          name: 'Edge CDF', type: 'line', showSymbol: false, smooth: true,
          lineStyle: { width: 1.5, color: edgeColour },
          data: edgeData,
        },
        ...(hasPath ? [{
          name: 'Path CDF', type: 'line' as const, showSymbol: false, smooth: true,
          lineStyle: { width: 1.5, color: pathColour, type: 'dashed' as const },
          data: pathData,
        }] : []),
      ],
      tooltip: { show: false },
    };
  }, [posterior, theme, t95, pathT95]);

  return (
    <ReactECharts
      option={option}
      style={{ width: 220, height: 100, marginTop: 4 }}
      notMerge={true}
      lazyUpdate={true}
    />
  );
}

function fmtPct(v: number | undefined | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | undefined | null): string {
  if (v == null) return '—';
  return v.toFixed(3);
}

function fmtDays(v: number | undefined | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}d`;
}
