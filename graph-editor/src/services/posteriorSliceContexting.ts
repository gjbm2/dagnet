/**
 * Posterior slice contexting (and engorgement) — doc 73b §3.2a.
 *
 * Stage 4(a)/4(b)/4(e) shared helper. Replaces the previous design where
 * the live graph's `_posteriorSlices` stash carried the multi-context
 * library. After Stage 4(b) removes the persistent stash, every site
 * that needs to context an edge to a specific DSL — per-scenario
 * request-graph build, live-edge re-context on `currentDSL` change,
 * share-bundle restore — reads slices from the parameter file via
 * this helper.
 *
 * Two operations are supported, distinguished by `engorgeFitHistory`:
 *
 *   Contexting (in-schema): re-project the matching slice onto the
 *   edge's `p.posterior.*` and `p.latency.posterior.*` for the
 *   scenario's effective DSL.
 *
 *   Engorgement (out-of-schema, request-graph copies only): also
 *   attach `_posteriorSlices` carrying `slices`, `fit_history`,
 *   `fitted_at`, `hdi_level` so `epistemic_bands.py:148` and other
 *   BE consumers that walk the slice library remain functional after
 *   Flow G stash removal.
 *
 * Pure orchestration. All match rules and fallbacks live in
 * `posteriorSliceResolution.ts` and are inherited unchanged.
 */

import type { Graph, ModelVarsEntry, Posterior } from '../types';
import {
  projectProbabilityPosterior,
  projectLatencyPosterior,
  resolveAsatPosterior,
} from './posteriorSliceResolution';
import { parseConstraints } from '../lib/queryDSL';
import { applyPromotion, upsertModelVars } from './modelVarsResolution';
import { sessionLogService } from './sessionLogService';
import { applyPathIdentityFallback } from './pathIdentity';

export type ParameterFileResolver = (paramId: string) => unknown | null | undefined;

export interface ContextEdgesOptions {
  /** When true, attach `_posteriorSlices = {slices, fit_history, fitted_at, hdi_level, ...}`
   *  to each edge's `p` block (and to each conditional `p` block). This is
   *  out-of-schema engorgement and must only be used on request-graph
   *  copies that cross the FE/BE boundary, never on the live graph. */
  engorgeFitHistory?: boolean;
}

/**
 * Drop the bayesian model_vars entry from a `p` block (posterior unification
 * plan §4 Step 5). Used on the "no slice / no fit" paths so that downstream
 * `applyPromotion` falls back to analytic and clears `p.posterior` /
 * `p.latency.posterior` per Step 2.
 */
function dropBayesianModelVar(pBlock: any): void {
  if (!Array.isArray(pBlock.model_vars)) return;
  const filtered = pBlock.model_vars.filter((e: any) => e?.source !== 'bayesian');
  if (filtered.length === 0) {
    delete pBlock.model_vars;
  } else if (filtered.length !== pBlock.model_vars.length) {
    pBlock.model_vars = filtered;
  }
}

/**
 * Reshape a projected probability/latency posterior pair (the graph-edge
 * shapes that `projectProbabilityPosterior` / `projectLatencyPosterior`
 * historically wrote directly onto `p.posterior` / `p.latency.posterior`)
 * into the `model_vars[bayesian]` entry shape required after the posterior
 * unification refactor (plan §3, Step 5).
 *
 * Conventions:
 *   - probability sub-block carries the full Beta shape (window + cohort,
 *     epistemic + predictive flavours) plus mean/stdev moments.
 *   - latency sub-block uses the model_vars naming (`mu`, `sigma`,
 *     `path_*`); promotion (Step 2) renames to mu_mean / sigma_mean
 *     when projecting onto p.latency.posterior.
 *   - quality carries the gate inputs (rhat / ess / divergences /
 *     evidence_grade / gate_passed).
 *   - fit_diagnostics carries everything bayesian-only that previously
 *     lived on p.posterior / p.latency.posterior (HDI, fitted_at,
 *     fingerprint, prior_tier, surprise_z, …).
 */
function buildBayesianModelVarFromSlice(
  probProj: Record<string, any>,
  latProj: Record<string, any> | undefined,
  fittedAt: string,
): ModelVarsEntry {
  const alpha = probProj.alpha;
  const beta = probProj.beta;
  const sum = (alpha ?? 0) + (beta ?? 0);
  const mean = sum > 0 ? alpha / sum : 0;
  const stdev = sum > 0
    ? Math.sqrt((alpha * beta) / (sum * sum * (sum + 1)))
    : 0;

  const probabilityBlock: any = {
    mean,
    stdev,
    alpha,
    beta,
    provenance: probProj.provenance ?? 'bayesian',
  };
  if (probProj.window_n_effective != null) probabilityBlock.n_effective = probProj.window_n_effective;
  if (probProj.alpha_pred != null) {
    probabilityBlock.alpha_pred = probProj.alpha_pred;
    probabilityBlock.beta_pred = probProj.beta_pred;
  }
  if (probProj.cohort_alpha != null) {
    probabilityBlock.cohort_alpha = probProj.cohort_alpha;
    probabilityBlock.cohort_beta = probProj.cohort_beta;
    probabilityBlock.cohort_provenance = probProj.cohort_provenance ?? 'bayesian';
  }
  if (probProj.cohort_n_effective != null) {
    probabilityBlock.cohort_n_effective = probProj.cohort_n_effective;
  }
  if (probProj.cohort_alpha_pred != null) {
    probabilityBlock.cohort_alpha_pred = probProj.cohort_alpha_pred;
    probabilityBlock.cohort_beta_pred = probProj.cohort_beta_pred;
  }

  let latencyBlock: any | undefined;
  // Mirror bayesPatchService: latency block requires the model to have
  // determined all three of μ, σ, onset. No fallbacks; if any is absent
  // the model has not produced a usable latency surface.
  if (latProj
      && latProj.mu_mean != null
      && latProj.sigma_mean != null
      && latProj.onset_delta_days != null) {
    latencyBlock = {
      mu: latProj.mu_mean,
      sigma: latProj.sigma_mean,
      t95: Math.exp(latProj.mu_mean + 1.645 * latProj.sigma_mean) + latProj.onset_delta_days,
      onset_delta_days: latProj.onset_delta_days,
    };
    if (latProj.mu_sd != null) latencyBlock.mu_sd = latProj.mu_sd;
    if (latProj.mu_sd_pred != null) latencyBlock.mu_sd_pred = latProj.mu_sd_pred;
    if (latProj.sigma_sd != null) latencyBlock.sigma_sd = latProj.sigma_sd;
    if (latProj.onset_sd != null) latencyBlock.onset_sd = latProj.onset_sd;
    if (latProj.onset_mu_corr != null) latencyBlock.onset_mu_corr = latProj.onset_mu_corr;
    if (latProj.path_mu_mean != null
        && latProj.path_sigma_mean != null
        && latProj.path_onset_delta_days != null) {
      latencyBlock.path_mu = latProj.path_mu_mean;
      latencyBlock.path_sigma = latProj.path_sigma_mean;
      latencyBlock.path_t95 = Math.exp(latProj.path_mu_mean + 1.645 * latProj.path_sigma_mean) + latProj.path_onset_delta_days;
      latencyBlock.path_onset_delta_days = latProj.path_onset_delta_days;
      if (latProj.path_mu_sd != null) latencyBlock.path_mu_sd = latProj.path_mu_sd;
      if (latProj.path_mu_sd_pred != null) latencyBlock.path_mu_sd_pred = latProj.path_mu_sd_pred;
      if (latProj.path_sigma_sd != null) latencyBlock.path_sigma_sd = latProj.path_sigma_sd;
      if (latProj.path_onset_sd != null) latencyBlock.path_onset_sd = latProj.path_onset_sd;
    }
  }

  const probDiag: any = {};
  if (fittedAt) probDiag.fitted_at = fittedAt;
  if (probProj.fingerprint) probDiag.fingerprint = probProj.fingerprint;
  if (probProj.prior_tier) probDiag.prior_tier = probProj.prior_tier;
  if (probProj.surprise_z != null) probDiag.surprise_z = probProj.surprise_z;
  if (probProj.hdi_lower != null) {
    probDiag.hdi_lower = probProj.hdi_lower;
    probDiag.hdi_upper = probProj.hdi_upper;
    probDiag.hdi_level = probProj.hdi_level ?? 0.9;
  }
  if (probProj.hdi_lower_pred != null) {
    probDiag.hdi_lower_pred = probProj.hdi_lower_pred;
    probDiag.hdi_upper_pred = probProj.hdi_upper_pred;
  }
  if (probProj.cohort_hdi_lower != null) {
    probDiag.cohort_hdi_lower = probProj.cohort_hdi_lower;
    probDiag.cohort_hdi_upper = probProj.cohort_hdi_upper;
  }
  if (probProj.cohort_hdi_lower_pred != null) {
    probDiag.cohort_hdi_lower_pred = probProj.cohort_hdi_lower_pred;
    probDiag.cohort_hdi_upper_pred = probProj.cohort_hdi_upper_pred;
  }
  // LOO-ELPD model adequacy (doc 32) and PPC calibration (doc 38). Mirrors
  // bayesPatchService.applyPatch:435-447 so DSL re-projection produces the
  // same fit_diagnostics shape as a fresh patch and the PromotedModelCard
  // popover keeps its model-adequacy badges between fits.
  // (Forensic audit 30-Apr-26 §8 Drop B1.)
  if (probProj.delta_elpd != null) probDiag.delta_elpd = probProj.delta_elpd;
  if (probProj.pareto_k_max != null) probDiag.pareto_k_max = probProj.pareto_k_max;
  if (probProj.n_loo_obs != null) probDiag.n_loo_obs = probProj.n_loo_obs;
  if (probProj.ppc_coverage_90 != null) probDiag.ppc_coverage_90 = probProj.ppc_coverage_90;
  if (probProj.ppc_n_obs != null) probDiag.ppc_n_obs = probProj.ppc_n_obs;
  if (probProj.ppc_traj_coverage_90 != null) probDiag.ppc_traj_coverage_90 = probProj.ppc_traj_coverage_90;
  if (probProj.ppc_traj_n_obs != null) probDiag.ppc_traj_n_obs = probProj.ppc_traj_n_obs;

  let latDiag: any | undefined;
  if (latProj && latProj.mu_mean != null) {
    latDiag = {};
    if (fittedAt) latDiag.fitted_at = fittedAt;
    if (latProj.fingerprint) latDiag.fingerprint = latProj.fingerprint;
    if (latProj.ess != null) latDiag.ess = latProj.ess;
    if (latProj.rhat != null) latDiag.rhat = latProj.rhat;
    if (latProj.hdi_t95_lower != null) {
      latDiag.hdi_t95_lower = latProj.hdi_t95_lower;
      latDiag.hdi_t95_upper = latProj.hdi_t95_upper;
      latDiag.hdi_level = latProj.hdi_level ?? 0.9;
    }
    if (latProj.path_hdi_t95_lower != null) {
      latDiag.path_hdi_t95_lower = latProj.path_hdi_t95_lower;
      latDiag.path_hdi_t95_upper = latProj.path_hdi_t95_upper;
    }
    // LOO-ELPD and PPC trajectory calibration for the latency fit. Same
    // scalars as on the probability sub-block (one fit emits one LOO/PPC
    // score), but mirrored here so consumers reading the latency popover
    // can render its adequacy row independently. Mirrors
    // bayesPatchService.applyPatch:466-474. (Forensic audit §8 Drop B2.)
    if (latProj.delta_elpd != null) latDiag.delta_elpd = latProj.delta_elpd;
    if (latProj.pareto_k_max != null) latDiag.pareto_k_max = latProj.pareto_k_max;
    if (latProj.n_loo_obs != null) latDiag.n_loo_obs = latProj.n_loo_obs;
    if (latProj.ppc_traj_coverage_90 != null) latDiag.ppc_traj_coverage_90 = latProj.ppc_traj_coverage_90;
    if (latProj.ppc_traj_n_obs != null) latDiag.ppc_traj_n_obs = latProj.ppc_traj_n_obs;
  }

  return {
    source: 'bayesian',
    source_at: fittedAt,
    probability: probabilityBlock,
    ...(latencyBlock ? { latency: latencyBlock } : {}),
    quality: {
      rhat: probProj.rhat ?? 0,
      ess: probProj.ess ?? 0,
      divergences: probProj.divergences ?? 0,
      evidence_grade: probProj.evidence_grade ?? 0,
      gate_passed: liveSliceMeetsQualityGate(
        { ess: probProj.ess, rhat: probProj.rhat, divergences: probProj.divergences },
        latProj ? { ess: latProj.ess, rhat: latProj.rhat } : undefined,
      ),
    },
    fit_diagnostics: {
      probability: probDiag,
      ...(latDiag ? { latency: latDiag } : {}),
    },
  };
}

/**
 * Re-project the bayesian source ledger entry on a single `p` block from a
 * parameter file's `posterior.slices`, given the scenario's effective DSL.
 *
 * Posterior unification plan §4 Step 5: this function used to write
 * `p.posterior` and `p.latency.posterior` directly. Now it writes
 * `model_vars[bayesian]` (full Beta + latency + fit_diagnostics) and lets
 * `applyPromotion` (run by `syncBayesianAndPromote` further down) project
 * to the source-agnostic surfaces.
 *
 * Mutates the `p` block in place. When `posterior.slices` is absent on the
 * parameter file or the active DSL has no matching slice, drops the
 * bayesian entry from `model_vars` so the next promotion falls back to
 * analytic.
 *
 * If `effectiveDsl` includes `asat()`, resolves the historical posterior
 * via `resolveAsatPosterior` first; if no fit exists on or before the
 * asat date, the projection is cleared (strict, no fallback).
 */
export function contextProbabilityBlock(
  pBlock: any,
  parameterFile: any,
  effectiveDsl: string,
  asatDate: string | null,
  options: ContextEdgesOptions,
  paramId?: string,
): void {
  if (!pBlock || typeof pBlock !== 'object') return;

  const fileposterior: Posterior | undefined =
    parameterFile && typeof parameterFile === 'object'
      ? (parameterFile.posterior as Posterior | undefined)
      : undefined;

  if (!fileposterior?.slices) {
    // Parameter file carries no posterior slices — drop the bayesian
    // source ledger entry. The downstream applyPromotion (run by
    // syncBayesianAndPromote) clears p.posterior / p.latency.posterior
    // when no source has a Beta.
    dropBayesianModelVar(pBlock);
    if (options.engorgeFitHistory) {
      pBlock._posteriorSlices = undefined;
    }
    return;
  }

  const activePosterior: Posterior | undefined = asatDate
    ? resolveAsatPosterior(fileposterior, asatDate)
    : fileposterior;

  if (!activePosterior) {
    // asat() in effect, but no fit on or before the asat date — drop
    // strictly per doc 27 §5.2 asat semantics.
    //
    // Defence-in-depth: surface the strict-drop in the session log so
    // a future regression where asat silently wipes a fit (e.g. by
    // wrapPatchIfRaw defaulting fitted_at to NOW) is visible without
    // having to instrument the chart pipeline. The strict-drop itself
    // is by design; the session-log entry is informational only —
    // tells operators why the chart fell back to analytic.
    if (asatDate) {
      const fittedAtSeen = fileposterior.fitted_at || '(none)';
      sessionLogService.warning(
        'data-fetch',
        'BAYES_SLICE_STRICT_DROP_AT_ASAT',
        `Bayesian projection dropped at asat() — fit too recent`,
        `paramId=${paramId ?? '(unknown)'} fitted_at=${fittedAtSeen} asat=${asatDate}`,
      );
    }
    dropBayesianModelVar(pBlock);
    if (options.engorgeFitHistory) {
      pBlock._posteriorSlices = undefined;
    }
    return;
  }

  const probResult = projectProbabilityPosterior(activePosterior, effectiveDsl);
  const latResult = projectLatencyPosterior(activePosterior, effectiveDsl);

  if (probResult) {
    const entry = buildBayesianModelVarFromSlice(
      probResult,
      latResult,
      activePosterior.fitted_at,
    );
    upsertModelVars(pBlock, entry);
  } else {
    // No window slice matched the active DSL — drop the bayesian entry.
    dropBayesianModelVar(pBlock);
  }

  if (options.engorgeFitHistory) {
    pBlock._posteriorSlices = {
      slices: activePosterior.slices,
      fitted_at: activePosterior.fitted_at,
      fingerprint: activePosterior.fingerprint,
      hdi_level: activePosterior.hdi_level,
      prior_tier: activePosterior.prior_tier,
      surprise_z: activePosterior.surprise_z,
      ...(activePosterior.fit_history ? { fit_history: activePosterior.fit_history } : {}),
    };
  }
}

/**
 * Context (and optionally engorge) every edge of a graph against the
 * scenario's effective DSL.
 *
 * For each edge:
 *   - looks up the parameter file via `edge.p.id`
 *   - projects the matching slice onto `p.posterior.*` and
 *     `p.latency.posterior.*`
 *   - mirrors the same operation under each entry of `edge.conditional_p`
 *     (live-graph array form; per 73a §3 rule 7 each entry carries its
 *     own `p` block)
 *   - when `engorgeFitHistory` is set, also attaches `_posteriorSlices`
 *     to each `p` block for BE consumers that walk the slice library
 *
 * Mutates the graph in place. The caller controls whether the graph is
 * the live edge or a request-graph copy; engorgement must only be used
 * on copies.
 */
export function contextGraphForEffectiveDsl(
  graph: any,
  resolveParameterFile: ParameterFileResolver,
  effectiveDsl: string,
  options: ContextEdgesOptions = {},
): void {
  const edges: any[] = Array.isArray(graph?.edges) ? graph.edges : [];
  if (edges.length === 0) return;

  let asatDate: string | null = null;
  try {
    const parsed = parseConstraints(effectiveDsl);
    asatDate = parsed.asat;
  } catch {
    asatDate = null;
  }

  // Posterior unification plan §4 Step 5: contextProbabilityBlock now
  // writes model_vars[bayesian] (or drops it). Promotion is the only
  // writer of p.posterior / p.latency.posterior — run it after the
  // model_vars mutation so the request graph's posterior surfaces
  // reflect the active source. Same data flow as the live-edge wrapper
  // (contextLiveGraphForCurrentDsl), so request and live paths agree
  // structurally.
  const graphPref = (graph as any)?.model_source_preference;

  for (const edge of edges) {
    const baseParamId: string | undefined = edge?.p?.id;
    if (baseParamId) {
      const pf = resolveParameterFile(String(baseParamId));
      contextProbabilityBlock(edge.p, pf, effectiveDsl, asatDate, options, String(baseParamId));
      // Identity fallback before promotion: if the topology guarantees
      // path = edge, fill the bayesian entry's path_* from edge-level so
      // promotion projects them onto the promoted surface. See
      // pathIdentity.ts for the engine-side invariant this mirrors.
      const bayesEntry = Array.isArray(edge?.p?.model_vars)
        ? edge.p.model_vars.find((e: any) => e?.source === 'bayesian')
        : undefined;
      if (bayesEntry?.latency) applyPathIdentityFallback(bayesEntry.latency, graph, edge.id);
      if (edge.p) applyPromotion(edge.p, graphPref);
    }

    const conditionals = Array.isArray(edge?.conditional_p) ? edge.conditional_p : [];
    for (const cond of conditionals) {
      const condParamId: string | undefined = cond?.p?.id;
      if (!condParamId) continue;
      const condPf = resolveParameterFile(String(condParamId));
      contextProbabilityBlock(cond.p, condPf, effectiveDsl, asatDate, options, String(condParamId));
      const condBayesEntry = Array.isArray(cond?.p?.model_vars)
        ? cond.p.model_vars.find((e: any) => e?.source === 'bayesian')
        : undefined;
      if (condBayesEntry?.latency) applyPathIdentityFallback(condBayesEntry.latency, graph, edge.id);
      if (cond.p) applyPromotion(cond.p, graphPref);
    }
  }
}

// 73b §3.1 / 73e Stage 3: gate thresholds for promoting a bayesian
// model_vars entry built from a re-projected posterior slice. Mirrored
// from `bayesPatchService.meetsQualityGate` — the slice library is the
// same artefact at both sites, so the gate must agree. Kept inline
// rather than imported because `bayesPatchService` pulls in heavy
// browser-only context (TabContext, GraphStoreContext) that the
// contexting helper cannot depend on.
const RHAT_GATE_LIVE = 1.05;
const ESS_GATE_LIVE = 100;

function liveSliceMeetsQualityGate(
  prob: { ess?: number; rhat?: number | null; divergences?: number },
  latency?: { ess?: number; rhat?: number | null } | null | undefined,
): boolean {
  if (prob.rhat != null && prob.rhat > RHAT_GATE_LIVE) return false;
  const div = prob.divergences ?? 0;
  if (div > 0 && (prob.ess ?? Infinity) < ESS_GATE_LIVE) return false;
  if (latency) {
    if (latency.rhat != null && latency.rhat > RHAT_GATE_LIVE) return false;
    if (latency.ess != null && latency.ess < ESS_GATE_LIVE) return false;
  }
  return true;
}

/**
 * Run promotion on a `p` block whose `model_vars[bayesian]` has just been
 * (re-)written by `contextProbabilityBlock`.
 *
 * Posterior unification plan §4 Step 5: this function used to derive
 * `model_vars[bayesian]` from a freshly-projected `p.posterior` and then
 * promote. The data flow has reversed — the upstream contexting now
 * writes `model_vars[bayesian]` directly, so this function is just a
 * promotion call. The wrapper is kept for symmetry with the old call
 * sites and so a future evolution (e.g. logging, gate enforcement) has
 * a single seam.
 */
function syncBayesianAndPromote(p: any, graphPref: any): void {
  if (!p || typeof p !== 'object') return;
  applyPromotion(p, graphPref);
}

/**
 * Context the live edge in place. Convenience wrapper around
 * `contextGraphForEffectiveDsl` with `engorgeFitHistory` forced off —
 * the live edge never carries out-of-schema fields per §3.2a.
 *
 * Per 73e Stage 3, this also re-syncs `model_vars[bayesian]` from the
 * newly-projected posterior and re-runs `applyPromotion`, so the
 * promoted surface (`p.forecast.{mean, stdev, source}`) tracks the
 * current DSL. `model_vars[analytic]` is preserved unchanged.
 */
export function contextLiveGraphForCurrentDsl(
  graph: Graph | null | undefined,
  resolveParameterFile: ParameterFileResolver,
  currentDsl: string,
): void {
  if (!graph) return;
  contextGraphForEffectiveDsl(graph, resolveParameterFile, currentDsl, {
    engorgeFitHistory: false,
  });

  const graphPref = (graph as any).model_source_preference;
  const edges: any[] = Array.isArray((graph as any).edges) ? (graph as any).edges : [];
  for (const edge of edges) {
    if (edge?.p) syncBayesianAndPromote(edge.p, graphPref);
    const conditionals = Array.isArray(edge?.conditional_p) ? edge.conditional_p : [];
    for (const cond of conditionals) {
      if (cond?.p) syncBayesianAndPromote(cond.p, graphPref);
    }
  }
}
