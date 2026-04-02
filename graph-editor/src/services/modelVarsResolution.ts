/**
 * Model variable resolution — doc 15 §3–4.
 *
 * Pure functions for selecting which ModelVarsEntry to promote to the
 * flat scalars that the rest of the system consumes.  No side effects,
 * no imports beyond types.
 */

import type {
  ModelVarsEntry,
  ModelSourcePreference,
  GraphModelSourcePreference,
  ProbabilityParam,
  LatencyConfig,
} from '../types';

// ── Effective preference ────────────────────────────────────────────────────

/**
 * Combine graph-level and edge-level preferences into a single effective value.
 * Doc 15 §3: edge override ?? graph default ?? 'best_available'.
 */
export function effectivePreference(
  edgePref: ModelSourcePreference | undefined,
  graphPref: GraphModelSourcePreference | undefined,
): ModelSourcePreference {
  return edgePref ?? graphPref ?? 'best_available';
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Select which ModelVarsEntry to promote to scalars.
 *
 * Selection logic (doc 15 §3):
 *   manual     → manual entry if present, else fall through to best_available
 *   bayesian   → bayesian entry if present, else analytic
 *   analytic   → analytic entry
 *   best_available → bayesian (if present + gated), else analytic
 *
 * Returns undefined when modelVars is empty/absent or no entry matches.
 */
export function resolveActiveModelVars(
  modelVars: ModelVarsEntry[] | undefined,
  preference: ModelSourcePreference,
): ModelVarsEntry | undefined {
  if (!modelVars || modelVars.length === 0) return undefined;

  const find = (source: ModelVarsEntry['source']) =>
    modelVars.find(e => e.source === source);

  const bayesianIfGated = (): ModelVarsEntry | undefined => {
    const b = find('bayesian');
    return b?.quality?.gate_passed ? b : undefined;
  };

  // During crossover: FE analytic is the trusted default. BE is opt-in.
  // Switch this to prefer analytic_be when parity is confirmed.
  const analyticBest = (): ModelVarsEntry | undefined =>
    find('analytic') ?? find('analytic_be');

  const bestAvailable = (): ModelVarsEntry | undefined =>
    bayesianIfGated() ?? analyticBest();

  switch (preference) {
    case 'manual':
      return find('manual') ?? bestAvailable();
    case 'bayesian':
      return find('bayesian') ?? analyticBest();
    case 'analytic_be':
      return find('analytic_be') ?? find('analytic');
    case 'analytic':
      return find('analytic');
    case 'best_available':
    default:
      return bestAvailable();
  }
}

// ── Scalar promotion ────────────────────────────────────────────────────────

/** Result of promoting a ModelVarsEntry to flat scalars. */
export interface PromotionResult {
  mean: number;
  stdev: number;
  latency?: {
    mu: number;
    sigma: number;
    t95: number;
    onset_delta_days: number;
    path_mu?: number;
    path_sigma?: number;
    path_t95?: number;
    path_onset_delta_days?: number;
    // Heuristic dispersion
    mu_sd?: number;
    sigma_sd?: number;
    onset_sd?: number;
    onset_mu_corr?: number;
    path_mu_sd?: number;
    path_sigma_sd?: number;
    path_onset_sd?: number;
  };
  /** Which source was selected */
  activeSource: ModelVarsEntry['source'];
}

/**
 * Promote a resolved ModelVarsEntry to the flat scalar shape consumed
 * by the rest of the system.  Returns undefined when entry is undefined.
 */
export function promoteModelVars(
  entry: ModelVarsEntry | undefined,
): PromotionResult | undefined {
  if (!entry) return undefined;
  return {
    mean: entry.probability.mean,
    stdev: entry.probability.stdev,
    latency: entry.latency
      ? {
          mu: entry.latency.mu,
          sigma: entry.latency.sigma,
          t95: entry.latency.t95,
          onset_delta_days: entry.latency.onset_delta_days,
          path_mu: entry.latency.path_mu,
          path_sigma: entry.latency.path_sigma,
          path_t95: entry.latency.path_t95,
          path_onset_delta_days: entry.latency.path_onset_delta_days,
        }
      : undefined,
    activeSource: entry.source,
  };
}

// ── Apply promotion to edge ─────────────────────────────────────────────────

/**
 * Write promoted scalars onto an edge's ProbabilityParam and LatencyConfig.
 * Mutates the provided objects in place — intended to be called during the
 * graph update cycle after resolution.
 *
 * Returns the active source (or undefined if nothing was promoted).
 */
export function applyPromotion(
  p: ProbabilityParam,
  graphPref: GraphModelSourcePreference | undefined,
): ModelVarsEntry['source'] | undefined {
  const pref = effectivePreference(p.model_source_preference, graphPref);
  const entry = resolveActiveModelVars(p.model_vars, pref);
  const result = promoteModelVars(entry);
  if (!result) return undefined;

  // p.mean (blend), p.stdev (blend uncertainty), and p.forecast.mean (p∞)
  // are per-query display quantities computed by the topo pass / pipeline.
  // applyPromotion only promotes latency model parameters (mu, sigma, t95, etc.).

  if (result.latency && p.latency) {
    p.latency.mu = result.latency.mu;
    p.latency.sigma = result.latency.sigma;
    // Doc 19: t95 and path_t95 write to promoted_* fields to avoid
    // circular dependency (user-configured t95 is an analytic fit input).
    p.latency.promoted_t95 = result.latency.t95;
    if (result.latency.onset_delta_days !== undefined) p.latency.promoted_onset_delta_days = result.latency.onset_delta_days;
    if (result.latency.path_mu !== undefined) p.latency.path_mu = result.latency.path_mu;
    if (result.latency.path_sigma !== undefined) p.latency.path_sigma = result.latency.path_sigma;
    if (result.latency.path_t95 !== undefined) p.latency.promoted_path_t95 = result.latency.path_t95;
    if (result.latency.path_onset_delta_days !== undefined) p.latency.path_onset_delta_days = result.latency.path_onset_delta_days;
    // Heuristic dispersion — promote SDs alongside point values
    if (result.latency.mu_sd !== undefined) p.latency.promoted_mu_sd = result.latency.mu_sd;
    if (result.latency.sigma_sd !== undefined) p.latency.promoted_sigma_sd = result.latency.sigma_sd;
    if (result.latency.onset_sd !== undefined) p.latency.promoted_onset_sd = result.latency.onset_sd;
    if (result.latency.onset_mu_corr !== undefined) p.latency.promoted_onset_mu_corr = result.latency.onset_mu_corr;
    if (result.latency.path_mu_sd !== undefined) p.latency.promoted_path_mu_sd = result.latency.path_mu_sd;
    if (result.latency.path_sigma_sd !== undefined) p.latency.promoted_path_sigma_sd = result.latency.path_sigma_sd;
    if (result.latency.path_onset_sd !== undefined) p.latency.promoted_path_onset_sd = result.latency.path_onset_sd;
  }

  return result.activeSource;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Upsert a model_vars entry by source, replacing any existing entry
 * with the same source.  Initialises the array when absent.
 */
export function upsertModelVars(p: { model_vars?: ModelVarsEntry[] }, entry: ModelVarsEntry): void {
  if (!p.model_vars) p.model_vars = [];
  const idx = p.model_vars.findIndex(e => e.source === entry.source);
  if (idx >= 0) {
    p.model_vars[idx] = entry;
  } else {
    p.model_vars.push(entry);
  }
}

/**
 * Format a UK date string (d-MMM-yy) from current date.
 */
export function ukDateNow(): string {
  const d = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getDate()}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
}
