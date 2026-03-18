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

import React, { useCallback, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
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

function fmtPct(v: number | undefined | null): string {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}
