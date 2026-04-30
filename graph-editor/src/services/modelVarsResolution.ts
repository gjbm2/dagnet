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
 * Clear all promoted surfaces on a ProbabilityParam (posterior unification
 * plan §4 Step 2). Used when the resolver has nothing to promote — leaves
 * the surfaces consistent with "no source selected" rather than letting
 * stale projections persist from a prior promotion.
 *
 * `p.forecast.mean` and `p.forecast.stdev` are NOT cleared here when the
 * forecast object exists from a non-promoted writer (the existing
 * comment in applyPromotion warns against overwriting upstream writes
 * with undefined). We only clear the source-label so downstream readers
 * can detect "no active source" and the Beta / latency-posterior
 * projections so they cannot be stale.
 */
function clearPromotedSurfaces(p: ProbabilityParam): void {
  if (p.forecast) {
    (p.forecast as any).source = undefined;
  }
  // Strip the promoted Beta shape — no source means no projection.
  if ((p as any).posterior !== undefined) {
    (p as any).posterior = undefined;
  }
  // Strip the promoted latency posterior.
  if (p.latency && (p.latency as any).posterior !== undefined) {
    (p.latency as any).posterior = undefined;
  }
}

/**
 * Write promoted scalars onto an edge's ProbabilityParam and LatencyConfig,
 * plus the promoted posterior surfaces (`p.posterior` and
 * `p.latency.posterior`) — posterior unification plan §3, Step 2.
 *
 * Mutates the provided objects in place; intended to be called during the
 * graph update cycle after resolution.
 *
 * Invariant: after this call, `p.posterior` and `p.latency.posterior`
 * reflect the active selector exactly. They are never left stale from a
 * prior promotion. When no entry resolves, they are cleared.
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
  if (!result) {
    // Posterior unification plan §4 Step 2(c) — no entry resolved.
    // Clear the promoted surfaces so a previous promotion's projection
    // does not survive across a model_vars mutation that dropped the
    // source.
    clearPromotedSurfaces(p);
    return undefined;
  }

  // Doc 73b §3.2 — narrow promoted probability surface
  // { mean, stdev, source }. applyPromotion is the only computer of these
  // three fields; CF and runtime cascades must not write them. `k` (a
  // runtime-derived population helper) is preserved on the same struct
  // but is written by a different path (FE topo inbound-n propagation)
  // — see §12.2 row S4 for the field-set partition. Skip the mean/stdev
  // writes when the resolved source carries no probability values
  // (e.g. an analytic entry built from a parameter file that omits
  // mean/stdev) so we don't overwrite a forecast value populated
  // upstream by file→graph mapping with `undefined`.
  if (!p.forecast) p.forecast = {};
  if (Number.isFinite(result.mean)) p.forecast.mean = result.mean;
  if (Number.isFinite(result.stdev)) p.forecast.stdev = result.stdev;
  p.forecast.source = result.activeSource;

  // p.mean and p.stdev are L5 current-answer scalars written by the topo
  // pass / CF (§3.3 / §3.3.4). applyPromotion does not touch them.

  if (result.latency && p.latency) {
    p.latency.mu = result.latency.mu;
    p.latency.sigma = result.latency.sigma;
    // Doc 19: t95 and path_t95 write to promoted_* fields to avoid
    // circular dependency (user-configured t95 is an analytic fit input).
    p.latency.promoted_t95 = result.latency.t95;
    if (result.latency.onset_delta_days !== undefined) {
      p.latency.promoted_onset_delta_days = result.latency.onset_delta_days;
      // Copy to input field unless user has locked it (same pattern as
      // UpdateManager.applyBatchLAGValues:2170, fetchDataService:2199).
      if (p.latency.onset_delta_days_overridden !== true) {
        p.latency.onset_delta_days = result.latency.onset_delta_days;
      }
    }
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

  // Posterior unification plan §3, Step 2(a)/(b) — write the promoted Beta
  // surface and the promoted latency posterior surface, OR clear them when
  // the resolved entry has no Beta / no latency posterior. The single-writer
  // invariant is: `p.posterior` and `p.latency.posterior` reflect the active
  // selector after this call.
  if (result.posterior) {
    (p as any).posterior = result.posterior;
  } else if ((p as any).posterior !== undefined) {
    (p as any).posterior = undefined;
  }
  // p.latency.posterior is fully derived from the source ledger — initialise
  // p.latency on demand when the resolved entry carries a latency posterior
  // (matches the pre-refactor direct-write behaviour where the projection
  // helper initialised pBlock.latency = {} before writing). When the resolved
  // entry has no latency posterior, only clear if p.latency already exists.
  if (result.latency_posterior) {
    if (!p.latency) p.latency = {} as any;
    (p.latency as any).posterior = result.latency_posterior;
  } else if (p.latency && (p.latency as any).posterior !== undefined) {
    (p.latency as any).posterior = undefined;
  }

  return result.activeSource;
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
