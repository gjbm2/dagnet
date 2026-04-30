/**
 * Posterior view helpers (posterior unification plan, 29-Apr-26 §4 Step 4).
 *
 * After unification, the bayesian-only metadata that previously lived on
 * `p.posterior` / `p.latency.posterior` has moved to
 * `model_vars[bayesian].fit_diagnostics` and `model_vars[bayesian].quality`.
 * UI surfaces (PosteriorIndicator, bayesQualityTier, popovers) still want a
 * single object that exposes every field they need to render, so this
 * module exports two view shapes plus builders that merge the relevant
 * sources for a given edge `p` block.
 *
 * View shapes are intentionally permissive — every field is optional. The
 * builder returns `null` only when there is nothing useful to display
 * (e.g. neither a promoted Beta surface nor a bayesian source ledger entry
 * exists).
 */

import type { ModelVarsEntry, ProbabilityParam } from '../types';

export interface ProbabilityPosteriorView {
  // From p.posterior (promoted Beta surface, source-agnostic)
  distribution?: string;
  alpha?: number;
  beta?: number;
  alpha_pred?: number;
  beta_pred?: number;
  cohort_alpha?: number;
  cohort_beta?: number;
  cohort_alpha_pred?: number;
  cohort_beta_pred?: number;
  n_effective?: number;
  window_n_effective?: number;
  cohort_n_effective?: number;
  provenance?: string;
  cohort_provenance?: string;

  // From model_vars[bayesian].fit_diagnostics.probability (bayesian-only).
  // Absent when the active source is analytic.
  fitted_at?: string;
  fingerprint?: string;
  prior_tier?: string;
  surprise_z?: number | null;
  hdi_lower?: number;
  hdi_upper?: number;
  hdi_level?: number;
  hdi_lower_pred?: number;
  hdi_upper_pred?: number;
  cohort_hdi_lower?: number;
  cohort_hdi_upper?: number;
  cohort_hdi_lower_pred?: number;
  cohort_hdi_upper_pred?: number;
  delta_elpd?: number | null;
  pareto_k_max?: number | null;
  n_loo_obs?: number | null;
  ppc_coverage_90?: number | null;
  ppc_n_obs?: number | null;
  ppc_traj_coverage_90?: number | null;
  ppc_traj_n_obs?: number | null;

  // From model_vars[bayesian].quality (gate inputs). Absent when source is analytic.
  ess?: number;
  rhat?: number;
  divergences?: number;
  evidence_grade?: number;

  /** Source label — 'bayesian' or 'analytic' or undefined when nothing resolved. */
  source?: ModelVarsEntry['source'];
}

export interface LatencyPosteriorView {
  // From p.latency.posterior (promoted lognormal posterior surface)
  distribution?: string;
  mu_mean?: number;
  mu_sd?: number;
  mu_sd_pred?: number;
  sigma_mean?: number;
  sigma_sd?: number;
  onset_delta_days?: number;
  onset_mean?: number;
  onset_sd?: number;
  onset_mu_corr?: number;
  onset_hdi_lower?: number;
  onset_hdi_upper?: number;
  path_mu_mean?: number;
  path_mu_sd?: number;
  path_mu_sd_pred?: number;
  path_sigma_mean?: number;
  path_sigma_sd?: number;
  path_onset_delta_days?: number;
  path_onset_sd?: number;
  path_onset_mu_corr?: number;
  path_onset_hdi_lower?: number;
  path_onset_hdi_upper?: number;
  provenance?: string;
  path_provenance?: string;

  // From model_vars[bayesian].fit_diagnostics.latency (bayesian-only)
  fitted_at?: string;
  fingerprint?: string;
  ess?: number;
  rhat?: number;
  hdi_t95_lower?: number;
  hdi_t95_upper?: number;
  hdi_level?: number;
  path_hdi_t95_lower?: number;
  path_hdi_t95_upper?: number;
  delta_elpd?: number | null;
  pareto_k_max?: number | null;
  n_loo_obs?: number | null;
  ppc_traj_coverage_90?: number | null;
  ppc_traj_n_obs?: number | null;

  source?: ModelVarsEntry['source'];
}

function findBayesianEntry(p: ProbabilityParam | null | undefined): ModelVarsEntry | undefined {
  if (!p?.model_vars) return undefined;
  return p.model_vars.find((e) => e.source === 'bayesian');
}

/**
 * Merge `p.posterior` (promoted Beta surface) with the bayesian source
 * ledger entry's `fit_diagnostics.probability` and `quality`. Returns null
 * when neither surface carries usable data.
 *
 * Bayesian-only diagnostics are merged unconditionally so consumers that
 * surface bayesian fit health regardless of promotion (forecast-quality
 * bead overlay, useBayesTrigger job reports) keep working. Consumers that
 * should display only the promoted source's view (PromotedModelCard) gate
 * locally on `view.source === 'bayesian'` instead of receiving a
 * pre-filtered view.
 */
export function getProbabilityPosteriorView(
  p: ProbabilityParam | null | undefined,
): ProbabilityPosteriorView | null {
  if (!p) return null;
  const surface: any = (p as any).posterior;
  const bayesEntry = findBayesianEntry(p);
  const probDiag: any = bayesEntry?.fit_diagnostics?.probability;
  const quality: any = bayesEntry?.quality;
  const activeSource = (p.forecast as any)?.source as ModelVarsEntry['source'] | undefined;

  if (!surface && !probDiag && !quality) return null;

  return {
    ...(surface ?? {}),
    ...(probDiag ?? {}),
    ...(quality ?? {}),
    source: activeSource,
  };
}

/**
 * Merge `p.latency.posterior` (promoted lognormal posterior surface) with
 * the bayesian source ledger entry's `fit_diagnostics.latency`.
 *
 * Same merge-unconditionally policy as the probability view above —
 * promotion-gated rendering happens at the consumer.
 */
export function getLatencyPosteriorView(
  p: ProbabilityParam | null | undefined,
): LatencyPosteriorView | null {
  if (!p) return null;
  const surface: any = (p.latency as any)?.posterior;
  const bayesEntry = findBayesianEntry(p);
  const latDiag: any = bayesEntry?.fit_diagnostics?.latency;
  const activeSource = (p.forecast as any)?.source as ModelVarsEntry['source'] | undefined;

  if (!surface && !latDiag) return null;

  return {
    ...(surface ?? {}),
    ...(latDiag ?? {}),
    source: activeSource,
  };
}
