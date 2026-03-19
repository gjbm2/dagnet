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
import type { ProbabilityPosterior, LatencyPosterior } from '../../types';
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
}

export function PosteriorIndicator({ posterior, retrievedAt, theme = 'dark', badgeOnly = false }: PosteriorIndicatorProps) {
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
          <PosteriorDetails posterior={posterior} retrievedAt={retrievedAt} theme={theme} />
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
}

/** Renders a compact diagnostic summary table. Reusable in popovers and panels. */
export function PosteriorDetails({ posterior, retrievedAt, theme = 'dark' }: PosteriorDetailsProps) {
  const tier = computeQualityTier(posterior);
  const colour = qualityTierToColour(tier.tier, theme);
  const isProbability = 'evidence_grade' in posterior;

  return (
    <table className="posterior-details-table">
      <tbody>
        {/* Quality tier */}
        <tr>
          <td className="posterior-details-label">Quality</td>
          <td className="posterior-details-value" style={{ color: colour }}>
            {qualityTierLabel(tier.tier)}
          </td>
        </tr>
        <tr>
          <td className="posterior-details-label" />
          <td className="posterior-details-reason">{tier.reason}</td>
        </tr>

        {/* HDI bounds */}
        {isProbability && (posterior as ProbabilityPosterior).hdi_lower != null && (
          <tr>
            <td className="posterior-details-label">
              HDI {fmtPct((posterior as ProbabilityPosterior).hdi_level)}
            </td>
            <td className="posterior-details-value">
              {fmtPct((posterior as ProbabilityPosterior).hdi_lower)} — {fmtPct((posterior as ProbabilityPosterior).hdi_upper)}
            </td>
          </tr>
        )}

        {/* Latency HDI */}
        {!isProbability && (posterior as LatencyPosterior).hdi_t95_lower != null && (
          <tr>
            <td className="posterior-details-label">
              t95 HDI {fmtPct((posterior as LatencyPosterior).hdi_level)}
            </td>
            <td className="posterior-details-value">
              {(posterior as LatencyPosterior).hdi_t95_lower?.toFixed(1)}d — {(posterior as LatencyPosterior).hdi_t95_upper?.toFixed(1)}d
            </td>
          </tr>
        )}

        {/* Latency model parameters — edge-level (window) */}
        {!isProbability && (posterior as LatencyPosterior).mu_mean != null && (
          <tr>
            <td className="posterior-details-label">Edge</td>
            <td className="posterior-details-value">
              onset={fmtDays((posterior as LatencyPosterior).onset_delta_days)}{' '}
              μ={fmtNum((posterior as LatencyPosterior).mu_mean)}{' '}
              σ={fmtNum((posterior as LatencyPosterior).sigma_mean)}
            </td>
          </tr>
        )}

        {/* Latency model parameters — path-level (cohort) */}
        {!isProbability && (posterior as LatencyPosterior).path_mu_mean != null && (
          <tr>
            <td className="posterior-details-label">Path</td>
            <td className="posterior-details-value">
              onset={fmtDays((posterior as LatencyPosterior).path_onset_delta_days)}{' '}
              μ={fmtNum((posterior as LatencyPosterior).path_mu_mean)}{' '}
              σ={fmtNum((posterior as LatencyPosterior).path_sigma_mean)}
            </td>
          </tr>
        )}

        {/* Latency CDF sparkline — edge vs path curves */}
        {!isProbability && (posterior as LatencyPosterior).mu_mean != null && (
          <tr>
            <td colSpan={2}>
              <LatencyCdfSparkline posterior={posterior as LatencyPosterior} theme={theme} />
            </td>
          </tr>
        )}

        {/* Evidence grade (probability only) */}
        {isProbability && (posterior as ProbabilityPosterior).evidence_grade != null && (
          <tr>
            <td className="posterior-details-label">Evidence</td>
            <td className="posterior-details-value">{(posterior as ProbabilityPosterior).evidence_grade}/3</td>
          </tr>
        )}

        {/* Convergence */}
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

        {/* Prior tier (probability only) */}
        {isProbability && (posterior as ProbabilityPosterior).prior_tier && (
          <tr>
            <td className="posterior-details-label">Prior</td>
            <td className="posterior-details-value">{(posterior as ProbabilityPosterior).prior_tier!.replace(/_/g, ' ')}</td>
          </tr>
        )}

        {/* Provenance */}
        {posterior.provenance && (
          <tr>
            <td className="posterior-details-label">Provenance</td>
            <td className="posterior-details-value">{posterior.provenance}</td>
          </tr>
        )}

        {/* Freshness */}
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

function LatencyCdfSparkline({ posterior, theme = 'dark' }: { posterior: LatencyPosterior; theme?: 'light' | 'dark' }) {
  const option = useMemo(() => {
    const edgeMu = posterior.mu_mean;
    const edgeSigma = posterior.sigma_mean;
    const edgeOnset = posterior.onset_delta_days ?? 0;
    const pathMu = posterior.path_mu_mean;
    const pathSigma = posterior.path_sigma_mean;
    const pathOnset = posterior.path_onset_delta_days ?? 0;
    const hasPath = pathMu != null && pathSigma != null;

    // Determine x-axis range: enough to show both curves reaching ~95%
    const edgeT95 = Math.exp(edgeMu + 1.645 * edgeSigma) + edgeOnset;
    const pathT95 = hasPath ? Math.exp(pathMu! + 1.645 * pathSigma!) + pathOnset : edgeT95;
    const maxDays = Math.ceil(Math.max(edgeT95, pathT95) * 1.3);
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
  }, [posterior, theme]);

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
