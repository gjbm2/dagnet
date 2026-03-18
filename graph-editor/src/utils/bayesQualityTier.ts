/**
 * Bayes Quality Tier — composite quality assessment for edge posteriors.
 *
 * Two-axis signal:
 *   1. Diagnostic health (failure pre-empts everything)
 *   2. Evidential depth (green spectrum when healthy)
 *
 * Pure FE function — no compiler changes needed. Thresholds can be
 * tuned without rerunning fits.
 */

import type { ProbabilityPosterior, LatencyPosterior } from '../types';

export type QualityTierLevel =
  | 'failed'    // Red — convergence failure or serious diagnostic issue
  | 'warning'   // Amber — marginal convergence, divergences, anomaly, or degraded method
  | 'good-0'    // Pale green — cold start (prior-dominated)
  | 'good-1'    // Light green — weak evidence
  | 'good-2'    // Medium green — mature evidence
  | 'good-3'    // Saturated green — full Bayesian, strong evidence
  | 'no-data';  // Grey — no posterior available

export interface QualityTier {
  tier: QualityTierLevel;
  /** Human-readable reason for the tier assignment */
  reason: string;
}

// ── Thresholds ──────────────────────────────────────────────

const RHAT_FAILED = 1.1;
const RHAT_WARNING = 1.01;
const ESS_CRITICAL = 100;
const SURPRISE_Z_THRESHOLD = 2;

const DEGRADED_PROVENANCES = new Set(['pooled-fallback', 'point-estimate']);

// ── Core computation ────────────────────────────────────────

type Posterior = ProbabilityPosterior | LatencyPosterior;

/**
 * Compute the quality tier for a posterior.
 * Returns 'no-data' when posterior is null/undefined.
 */
export function computeQualityTier(posterior: Posterior | null | undefined): QualityTier {
  if (!posterior) {
    return { tier: 'no-data', reason: 'No posterior available' };
  }

  // Guard: if essential fields are missing, treat as no-data
  const rhat = posterior.rhat;
  const ess = posterior.ess;
  if (rhat == null || ess == null) {
    return { tier: 'no-data', reason: 'Posterior present but missing convergence diagnostics' };
  }

  // divergences is on ProbabilityPosterior but not LatencyPosterior
  const divergences = 'divergences' in posterior ? ((posterior as ProbabilityPosterior).divergences ?? 0) : 0;

  // ── FAILED tier (red) ─────────────────────────────────────
  if (rhat > RHAT_FAILED) {
    return { tier: 'failed', reason: `rhat ${rhat.toFixed(3)} exceeds ${RHAT_FAILED} — not converged` };
  }
  if (divergences > 0 && ess < ESS_CRITICAL) {
    return {
      tier: 'failed',
      reason: `${divergences} divergences with ESS ${ess.toFixed(0)} — unreliable`,
    };
  }

  // ── WARNING tier (amber) ──────────────────────────────────
  const warnings: string[] = [];

  if (rhat > RHAT_WARNING) {
    warnings.push(`rhat ${rhat.toFixed(3)} marginal`);
  }
  if (divergences > 0) {
    warnings.push(`${divergences} divergences`);
  }

  // surprise_z only exists on ProbabilityPosterior
  const surpriseZ = 'surprise_z' in posterior ? (posterior as ProbabilityPosterior).surprise_z : null;
  if (surpriseZ != null && Math.abs(surpriseZ) > SURPRISE_Z_THRESHOLD) {
    warnings.push(`surprise z=${surpriseZ.toFixed(1)}`);
  }

  if (posterior.provenance && DEGRADED_PROVENANCES.has(posterior.provenance)) {
    warnings.push(`degraded provenance: ${posterior.provenance}`);
  }

  if (warnings.length > 0) {
    return { tier: 'warning', reason: warnings.join('; ') };
  }

  // ── GOOD tier (green spectrum) ────────────────────────────
  // evidence_grade only exists on ProbabilityPosterior
  const grade = 'evidence_grade' in posterior
    ? (posterior as ProbabilityPosterior).evidence_grade
    : 3; // Latency posteriors that pass diagnostics are treated as fully fitted

  switch (grade) {
    case 0: return { tier: 'good-0', reason: 'Cold start — prior-dominated' };
    case 1: return { tier: 'good-1', reason: 'Weak evidence' };
    case 2: return { tier: 'good-2', reason: 'Mature evidence' };
    case 3:
    default: return { tier: 'good-3', reason: 'Full Bayesian — strong evidence' };
  }
}

// ── Colour mapping ──────────────────────────────────────────

/** Colour palette for quality tiers. */
const TIER_COLOURS: Record<QualityTierLevel, { light: string; dark: string }> = {
  'failed':  { light: '#dc2626', dark: '#ef4444' },   // Red
  'warning': { light: '#d97706', dark: '#f59e0b' },   // Amber
  'good-0':  { light: '#86efac', dark: '#4ade80' },   // Pale green
  'good-1':  { light: '#4ade80', dark: '#34d399' },   // Light green
  'good-2':  { light: '#22c55e', dark: '#22c55e' },   // Medium green
  'good-3':  { light: '#16a34a', dark: '#10b981' },   // Saturated green
  'no-data': { light: '#9ca3af', dark: '#6b7280' },   // Grey
};

/**
 * Map a quality tier to a display colour.
 * @param tier The computed quality tier level
 * @param theme 'light' or 'dark' — defaults to 'dark'
 */
export function qualityTierToColour(tier: QualityTierLevel, theme: 'light' | 'dark' = 'dark'): string {
  return TIER_COLOURS[tier]?.[theme] ?? TIER_COLOURS['no-data'][theme];
}

/** Short human-readable label for a quality tier. */
export function qualityTierLabel(tier: QualityTierLevel): string {
  switch (tier) {
    case 'failed': return 'Failed';
    case 'warning': return 'Warning';
    case 'good-0': return 'Cold start';
    case 'good-1': return 'Weak';
    case 'good-2': return 'Mature';
    case 'good-3': return 'Strong';
    case 'no-data': return 'No data';
  }
}
