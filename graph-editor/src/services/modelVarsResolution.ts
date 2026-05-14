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
 *
 * Doc 73b §6.7 / OP1 graceful-degrade: if a stale `'manual'` survives the
 * load-time migration, treat it as unpinned at runtime so this function never
 * returns a removed enum value.
 */
export function effectivePreference(
  edgePref: ModelSourcePreference | undefined,
  graphPref: GraphModelSourcePreference | undefined,
): ModelSourcePreference {
  const normalise = (v: ModelSourcePreference | string | undefined) =>
    v === 'manual' ? undefined : (v as ModelSourcePreference | undefined);
  return normalise(edgePref) ?? normalise(graphPref) ?? 'best_available';
}

// ── Resolution ──────────────────────────────────────────────────────────────

/**
 * Select which ModelVarsEntry to promote to scalars (doc 15 §3, doc 73b §3.1 / OP3).
 *
 *   bayesian        → bayesian entry if present, else analytic (per OP3 fallback)
 *   analytic        → analytic entry
 *   best_available  → bayesian (if present + gated), else analytic
 *
 * Per doc 73b §6.7 / OP1 graceful-degrade, in-the-wild `'manual'` selector
 * preferences are treated as unpinned at load time (workspaceService
 * `_migrateManualSourceInPlace`) and as `best_available` at runtime if any
 * survive that migration.
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

  const analyticBest = (): ModelVarsEntry | undefined =>
    find('analytic');

  const bestAvailable = (): ModelVarsEntry | undefined =>
    bayesianIfGated() ?? analyticBest();

  switch (preference) {
    case 'bayesian':
      return find('bayesian') ?? analyticBest();
    case 'analytic':
      return find('analytic');
    case 'best_available':
    default:
      return bestAvailable();
  }
}

// ── Scalar promotion ────────────────────────────────────────────────────────

/** Result of promoting a ModelVarsEntry to flat scalars + posterior surfaces. */
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
    mu_sd_pred?: number;
    sigma_sd?: number;
    onset_sd?: number;
    onset_mu_corr?: number;
    path_mu_sd?: number;
    path_mu_sd_pred?: number;
    path_sigma_sd?: number;
    path_onset_sd?: number;
  };
  /**
   * Promoted Beta shape — projection of the resolved entry's
   * `probability` block onto the source-agnostic surface that lands at
   * `p.posterior` (posterior unification plan §3). Absent when the
   * resolved entry has no valid Beta shape (analytic without a moment-
   * match, or a degenerate stub).
   */
  posterior?: {
    distribution: 'beta';
    alpha?: number;
    beta?: number;
    alpha_pred?: number;
    beta_pred?: number;
    cohort_alpha?: number;
    cohort_beta?: number;
    cohort_alpha_pred?: number;
    cohort_beta_pred?: number;
    n_effective?: number;
    cohort_n_effective?: number;
    provenance?: string;
    cohort_provenance?: string;
  };
  /**
   * Promoted lognormal latency posterior — projection of the resolved
   * entry's `latency` block. Absent when the resolved entry has no
   * latency posterior (e.g. analytic). Field-name rename versus the
   * source ledger: `mu → mu_mean`, `sigma → sigma_mean`, `path_* →
   * path_*_mean` (plan §3).
   */
  latency_posterior?: {
    distribution: 'lognormal';
    mu_mean?: number;
    mu_sd?: number;
    mu_sd_pred?: number;
    sigma_mean?: number;
    sigma_sd?: number;
    onset_delta_days?: number;
    onset_sd?: number;
    onset_mu_corr?: number;
    path_mu_mean?: number;
    path_mu_sd?: number;
    path_mu_sd_pred?: number;
    path_sigma_mean?: number;
    path_sigma_sd?: number;
    path_onset_delta_days?: number;
    path_onset_sd?: number;
    provenance?: string;
    path_provenance?: string;
  };
  /** Which source was selected */
  activeSource: ModelVarsEntry['source'];
}

/**
 * Promote a resolved ModelVarsEntry to the flat scalar shape + posterior
 * surfaces consumed by the rest of the system. Returns undefined when entry
 * is undefined.
 */
export function promoteModelVars(
  entry: ModelVarsEntry | undefined,
): PromotionResult | undefined {
  if (!entry) return undefined;

  const prob = entry.probability;
  const probHasBeta =
    prob.alpha !== undefined &&
    Number.isFinite(prob.alpha) && (prob.alpha as number) > 0 &&
    prob.beta !== undefined &&
    Number.isFinite(prob.beta) && (prob.beta as number) > 0;

  const result: PromotionResult = {
    mean: prob.mean,
    stdev: prob.stdev,
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
          mu_sd: entry.latency.mu_sd,
          mu_sd_pred: (entry.latency as any).mu_sd_pred,
          sigma_sd: entry.latency.sigma_sd,
          onset_sd: entry.latency.onset_sd,
          onset_mu_corr: entry.latency.onset_mu_corr,
          path_mu_sd: entry.latency.path_mu_sd,
          path_mu_sd_pred: (entry.latency as any).path_mu_sd_pred,
          path_sigma_sd: entry.latency.path_sigma_sd,
          path_onset_sd: entry.latency.path_onset_sd,
        }
      : undefined,
    activeSource: entry.source,
  };

  // Posterior unification plan §3 — project the resolved entry's Beta
  // shape onto the source-agnostic posterior surface.
  if (probHasBeta) {
    result.posterior = {
      distribution: 'beta',
      alpha: prob.alpha,
      beta: prob.beta,
      alpha_pred: (prob as any).alpha_pred,
      beta_pred: (prob as any).beta_pred,
      cohort_alpha: prob.cohort_alpha,
      cohort_beta: prob.cohort_beta,
      cohort_alpha_pred: (prob as any).cohort_alpha_pred,
      cohort_beta_pred: (prob as any).cohort_beta_pred,
      n_effective: prob.n_effective,
      cohort_n_effective: prob.cohort_n_effective,
      provenance: prob.provenance,
      cohort_provenance: prob.cohort_provenance,
    };
  }

  // Posterior unification plan §3 (latency v1.1, 30-Apr-26) — project the
  // resolved entry's latency block onto p.latency.posterior source-
  // agnostically, mirroring how `p.posterior` is projected from the rate
  // Beta of any source. Field rename from source-ledger to posterior-
  // surface: mu → mu_mean, sigma → sigma_mean, path_mu → path_mu_mean,
  // path_sigma → path_sigma_mean.
  //
  // For bayesian the projected fields are MCMC posterior moments. For
  // analytic they are point estimates with heuristic dispersion SDs from
  // the FE topo dispersion model — semantically a degenerate posterior
  // (Dirac on the point) widened by the heuristic SDs. The "posterior"
  // surface is the promoted *lognormal latency* layer; the active
  // source's view of that layer is what gets projected.
  //
  // Bayesian-only metadata (HDI, ess, rhat, fitted_at, fingerprint, ppc,
  // delta_elpd) does NOT live here — it stays on
  // `model_vars[bayesian].fit_diagnostics` and is read separately by the
  // diagnostic popover.
  const lat = entry.latency;
  const latHasPosterior = lat != null
    && typeof lat.mu === 'number' && Number.isFinite(lat.mu)
    && typeof lat.sigma === 'number' && Number.isFinite(lat.sigma);
  if (latHasPosterior && lat) {
    result.latency_posterior = {
      distribution: 'lognormal',
      mu_mean: lat.mu,
      mu_sd: lat.mu_sd,
      mu_sd_pred: (lat as any).mu_sd_pred,
      sigma_mean: lat.sigma,
      sigma_sd: lat.sigma_sd,
      onset_delta_days: lat.onset_delta_days,
      onset_sd: lat.onset_sd,
      onset_mu_corr: lat.onset_mu_corr,
      path_mu_mean: lat.path_mu,
      path_mu_sd: lat.path_mu_sd,
      path_mu_sd_pred: (lat as any).path_mu_sd_pred,
      path_sigma_mean: lat.path_sigma,
      path_sigma_sd: lat.path_sigma_sd,
      path_onset_delta_days: lat.path_onset_delta_days,
      path_onset_sd: lat.path_onset_sd,
      provenance: prob.provenance,
      path_provenance: prob.cohort_provenance,
    };
  }

  return result;
}

// ── Apply promotion to edge ─────────────────────────────────────────────────

/**
 * Project the active source's view onto the promoted surfaces of `p`.
 *
 * First-principles contract:
 *   1. Selector — pick the active source by edge preference (with graph
 *      default fall-through).
 *   2. ATOMIC projection — every field below is overwritten from the
 *      active source's projection. When the source does not provide a
 *      field, that field is set to `undefined`. There is no stale carry-
 *      over from a previously-active source, ever.
 *   3. COMPLETE projection — every promotion-owned field is written.
 *      Consumers read these surfaces without resolving anything
 *      themselves.
 *   4. Single writer — `applyPromotion` is the only computer of every
 *      field listed below. FE topo writes the source ledger
 *      (`model_vars[*]`); CF and runtime cascades do not touch these
 *      surfaces. Callers must invoke `applyPromotion` after any
 *      `model_vars` mutation.
 *
 * Promotion-owned fields:
 *
 *   On `p`:
 *     - `forecast.mean`, `forecast.stdev`, `forecast.source`
 *     - `posterior` (whole sub-object — promoted Beta surface)
 *
 *   On `p.latency` (when present, or initialised on demand when the
 *   active source carries a latency posterior):
 *     - `mu`, `sigma` (L5 lognormal scalars, sourced from the active
 *       entry's `latency.mu` / `latency.sigma`)
 *     - `path_mu`, `path_sigma`, `path_onset_delta_days`
 *     - `promoted_t95`, `promoted_path_t95`,
 *       `promoted_onset_delta_days`
 *     - `promoted_mu_sd`, `promoted_sigma_sd`, `promoted_onset_sd`,
 *       `promoted_onset_mu_corr`,
 *       `promoted_path_mu_sd`, `promoted_path_sigma_sd`,
 *       `promoted_path_onset_sd`
 *     - `posterior` (whole sub-object — promoted lognormal surface)
 *     - `onset_delta_days` — copied from the promoted value only when
 *       the user has NOT set `onset_delta_days_overridden`. The flag
 *       and the input value itself are user-owned, not promotion-owned.
 *
 * Returns the active source (or undefined if no entry resolved — in
 * which case every promotion-owned field above is set to undefined).
 */
export function applyPromotion(
  p: ProbabilityParam,
  graphPref: GraphModelSourcePreference | undefined,
): ModelVarsEntry['source'] | undefined {
  const pref = effectivePreference(p.model_source_preference, graphPref);
  const entry = resolveActiveModelVars(p.model_vars, pref);
  const result = promoteModelVars(entry);
  const lat = result?.latency;

  // ── Promoted probability surface ────────────────────────────────────
  if (!p.forecast) p.forecast = {};
  p.forecast.mean = result?.mean;
  p.forecast.stdev = result?.stdev;
  p.forecast.source = result?.activeSource;
  (p as any).posterior = result?.posterior;

  // ── Promoted latency surface ────────────────────────────────────────
  // Initialise `p.latency` on demand when the active source carries a
  // latency posterior. Otherwise only write/clear when the host object
  // already exists (an edge with no latency setup never needs a latency
  // object created just to hold undefined fields).
  if (!p.latency && result?.latency_posterior) {
    p.latency = {} as any;
  }
  if (p.latency) {
    p.latency.mu = lat?.mu;
    p.latency.sigma = lat?.sigma;
    p.latency.promoted_t95 = lat?.t95;
    p.latency.promoted_onset_delta_days = lat?.onset_delta_days;
    p.latency.path_mu = lat?.path_mu;
    p.latency.path_sigma = lat?.path_sigma;
    p.latency.promoted_path_t95 = lat?.path_t95;
    p.latency.path_onset_delta_days = lat?.path_onset_delta_days;
    p.latency.promoted_mu_sd = lat?.mu_sd;
    p.latency.promoted_sigma_sd = lat?.sigma_sd;
    p.latency.promoted_onset_sd = lat?.onset_sd;
    p.latency.promoted_onset_mu_corr = lat?.onset_mu_corr;
    p.latency.promoted_path_mu_sd = lat?.path_mu_sd;
    p.latency.promoted_path_sigma_sd = lat?.path_sigma_sd;
    p.latency.promoted_path_onset_sd = lat?.path_onset_sd;
    (p.latency as any).posterior = result?.latency_posterior;

    // `onset_delta_days` is the user-input field. When unlocked, it
    // tracks the promoted onset; when locked, it preserves the user's
    // value. The flag and the locked-input value are user-owned.
    if (p.latency.onset_delta_days_overridden !== true) {
      p.latency.onset_delta_days = lat?.onset_delta_days;
    }
  }

  return result?.activeSource;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Moment-match a Beta(α, β) shape from `(mean, stdev)` per doc 73b §3.9
 * "smoothing convention" alternative. Returns `{}` (no Beta shape) when
 * inputs are invalid for a proper Beta — caller should leave the §3.9
 * fields absent. Doc 73f F16: the Python resolver no longer fabricates a
 * prior when the aggregate Beta is missing; it returns α=β=0 and
 * downstream consumers render midline only (no dispersion bands).
 * §3.8 register entry 2 (the κ=200 fallback) is withdrawn.
 *
 * For a Beta(α, β):
 *   var = α·β / ((α+β)² · (α+β+1))   ≤ mean·(1−mean)
 *   concentration = α + β = mean·(1−mean)/variance − 1
 *
 * Invalid when: stdev not finite or ≤ 0, mean not in (0, 1), or
 * variance ≥ mean·(1−mean) (impossible for Beta).
 */
export function momentMatchAnalyticBeta(
  mean: number,
  stdev: number,
): { alpha?: number; beta?: number; n_effective?: number } {
  if (!Number.isFinite(mean) || !Number.isFinite(stdev)) return {};
  if (mean <= 0 || mean >= 1) return {};
  if (stdev <= 0) return {};
  const variance = stdev * stdev;
  const maxVar = mean * (1 - mean);
  if (variance >= maxVar) return {};
  const concentration = (maxVar / variance) - 1;
  if (!Number.isFinite(concentration) || concentration <= 0) return {};
  const alpha = mean * concentration;
  const beta = (1 - mean) * concentration;
  return { alpha, beta, n_effective: concentration };
}

/**
 * Build the §3.9 analytic-source probability sub-block from
 * `(mean, stdev)` plus an optional `n_effective` override (when the
 * caller has a more reliable source-mass figure than the moment-match
 * yields). Returns `{ mean, stdev }` plus, when valid, the §3.9
 * `{ alpha, beta, n_effective, provenance }` window-family shape.
 *
 * When the caller also provides `stdev_pred` (a Beta-Binomial predictive
 * SD from the Pearson chi-squared overdispersion estimator), the block
 * additionally emits `{ alpha_pred, beta_pred }` from a moment-match
 * against `(mean, stdev_pred)`. This closes the §3.9 deferral
 * ("no `alpha_pred` / `beta_pred` from analytic until an overdispersion
 * model lands") — see [EPISTEMIC_DISPERSION_DESIGN.md §6](../../../docs/current/codebase/EPISTEMIC_DISPERSION_DESIGN.md).
 */
export function buildAnalyticProbabilityBlock(
  mean: number,
  stdev: number,
  opts?: { n_effective?: number; provenance?: string; stdev_pred?: number },
): {
  mean: number;
  stdev: number;
  alpha?: number;
  beta?: number;
  alpha_pred?: number;
  beta_pred?: number;
  n_effective?: number;
  provenance?: string;
} {
  const block: {
    mean: number;
    stdev: number;
    alpha?: number;
    beta?: number;
    alpha_pred?: number;
    beta_pred?: number;
    n_effective?: number;
    provenance?: string;
  } = { mean, stdev };
  const moments = momentMatchAnalyticBeta(mean, stdev);
  if (moments.alpha !== undefined && moments.beta !== undefined) {
    block.alpha = moments.alpha;
    block.beta = moments.beta;
    block.n_effective = (
      opts?.n_effective !== undefined && Number.isFinite(opts.n_effective) && opts.n_effective > 0
        ? opts.n_effective
        : moments.n_effective
    );
    block.provenance = opts?.provenance ?? 'analytic_window_baseline';
  }
  if (
    opts?.stdev_pred !== undefined
    && Number.isFinite(opts.stdev_pred)
    && opts.stdev_pred > 0
  ) {
    const predictive = momentMatchAnalyticBeta(mean, opts.stdev_pred);
    if (predictive.alpha !== undefined && predictive.beta !== undefined) {
      block.alpha_pred = predictive.alpha;
      block.beta_pred = predictive.beta;
    }
  }
  return block;
}

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
