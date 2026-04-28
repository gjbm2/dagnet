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

export type ParameterFileResolver = (paramId: string) => unknown | null | undefined;

export interface ContextEdgesOptions {
  /** When true, attach `_posteriorSlices = {slices, fit_history, fitted_at, hdi_level, ...}`
   *  to each edge's `p` block (and to each conditional `p` block). This is
   *  out-of-schema engorgement and must only be used on request-graph
   *  copies that cross the FE/BE boundary, never on the live graph. */
  engorgeFitHistory?: boolean;
}

/**
 * Re-project the in-schema posterior fields of a single `p` block from a
 * parameter file's `posterior.slices`, given the scenario's effective DSL.
 *
 * Mutates the `p` block in place. When `posterior.slices` is absent on the
 * parameter file, clears `p.posterior` and `p.latency.posterior` so a
 * stale projection from a different DSL cannot persist.
 *
 * If `effectiveDsl` includes `asat()`, resolves the historical posterior
 * via `resolveAsatPosterior` first; if no fit exists on or before the
 * asat date, the projection is cleared (strict, no fallback).
 */
function contextProbabilityBlock(
  pBlock: any,
  parameterFile: any,
  effectiveDsl: string,
  asatDate: string | null,
  options: ContextEdgesOptions,
): void {
  if (!pBlock || typeof pBlock !== 'object') return;

  const fileposterior: Posterior | undefined =
    parameterFile && typeof parameterFile === 'object'
      ? (parameterFile.posterior as Posterior | undefined)
      : undefined;

  if (!fileposterior?.slices) {
    // Parameter file carries no posterior — leave any existing edge
    // projection alone (no-op, not a wipe). Engorgement still clears,
    // so a stale stash from an earlier file version doesn't leak onto
    // this request graph.
    if (options.engorgeFitHistory) {
      pBlock._posteriorSlices = undefined;
    }
    return;
  }

  const activePosterior: Posterior | undefined = asatDate
    ? resolveAsatPosterior(fileposterior, asatDate)
    : fileposterior;

  if (!activePosterior) {
    // asat() in effect, but no fit on or before the asat date — clear
    // strictly per doc 27 §5.2 asat semantics.
    pBlock.posterior = undefined;
    if (pBlock.latency) pBlock.latency.posterior = undefined;
    if (options.engorgeFitHistory) {
      pBlock._posteriorSlices = undefined;
    }
    return;
  }

  const probResult = projectProbabilityPosterior(activePosterior, effectiveDsl);
  if (probResult) {
    pBlock.posterior = probResult;
  } else {
    pBlock.posterior = undefined;
  }

  const latResult = projectLatencyPosterior(activePosterior, effectiveDsl);
  if (latResult) {
    if (!pBlock.latency || typeof pBlock.latency !== 'object') {
      pBlock.latency = {};
    }
    pBlock.latency.posterior = latResult;
  } else if (pBlock.latency) {
    pBlock.latency.posterior = undefined;
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

  for (const edge of edges) {
    const baseParamId: string | undefined = edge?.p?.id;
    if (baseParamId) {
      const pf = resolveParameterFile(String(baseParamId));
      contextProbabilityBlock(edge.p, pf, effectiveDsl, asatDate, options);
    }

    const conditionals = Array.isArray(edge?.conditional_p) ? edge.conditional_p : [];
    for (const cond of conditionals) {
      const condParamId: string | undefined = cond?.p?.id;
      if (!condParamId) continue;
      const condPf = resolveParameterFile(String(condParamId));
      contextProbabilityBlock(cond.p, condPf, effectiveDsl, asatDate, options);
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
 * Build a `bayesian` ModelVarsEntry from the in-schema posterior the
 * contexting pass just projected onto a `p` block, upsert it, and then
 * run promotion. When the projection cleared the posterior (no slice
 * matched the new DSL), drop any stale bayesian entry so promotion
 * falls back to analytic instead of carrying a stale fit forward.
 *
 * `applyPromotion` updates only the `bayesian` entry and the narrow
 * promoted surface; an existing `analytic` entry is left untouched
 * (`upsertModelVars` keys on `source`).
 */
function syncBayesianAndPromote(p: any, graphPref: any): void {
  if (!p || typeof p !== 'object') return;
  const post = p.posterior;
  const latPost = p.latency && typeof p.latency === 'object' ? p.latency.posterior : undefined;
  const hasUsablePosterior = !!post
    && Number.isFinite(post.alpha)
    && Number.isFinite(post.beta)
    && (post.alpha + post.beta) > 0;

  if (hasUsablePosterior) {
    const sum = post.alpha + post.beta;
    const probMean = post.alpha / sum;
    const probStdev = Math.sqrt((post.alpha * post.beta) / (sum * sum * (sum + 1)));
    const gatePassed = liveSliceMeetsQualityGate(
      { ess: post.ess, rhat: post.rhat, divergences: post.divergences },
      latPost ? { ess: latPost.ess, rhat: latPost.rhat } : undefined,
    );

    const entry: ModelVarsEntry = {
      source: 'bayesian',
      source_at: post.fitted_at,
      probability: { mean: probMean, stdev: probStdev },
      ...(latPost && Number.isFinite(latPost.mu_mean) ? {
        latency: {
          mu: latPost.mu_mean,
          sigma: latPost.sigma_mean,
          t95: Math.exp(latPost.mu_mean + 1.645 * (latPost.sigma_mean ?? 0)) + (latPost.onset_delta_days ?? latPost.onset_mean ?? 0),
          onset_delta_days: latPost.onset_delta_days ?? latPost.onset_mean ?? 0,
          ...(latPost.mu_sd !== undefined ? { mu_sd: latPost.mu_sd } : {}),
          ...(latPost.sigma_sd !== undefined ? { sigma_sd: latPost.sigma_sd } : {}),
          ...(latPost.onset_sd !== undefined ? { onset_sd: latPost.onset_sd } : {}),
          ...(latPost.onset_mu_corr !== undefined ? { onset_mu_corr: latPost.onset_mu_corr } : {}),
          ...(latPost.path_mu_mean !== undefined ? {
            path_mu: latPost.path_mu_mean,
            path_sigma: latPost.path_sigma_mean,
            path_t95: Math.exp(latPost.path_mu_mean + 1.645 * (latPost.path_sigma_mean ?? 0)) + (latPost.path_onset_delta_days ?? 0),
            path_onset_delta_days: latPost.path_onset_delta_days ?? 0,
            ...(latPost.path_mu_sd !== undefined ? { path_mu_sd: latPost.path_mu_sd } : {}),
            ...(latPost.path_sigma_sd !== undefined ? { path_sigma_sd: latPost.path_sigma_sd } : {}),
            ...(latPost.path_onset_sd !== undefined ? { path_onset_sd: latPost.path_onset_sd } : {}),
          } : {}),
        },
      } : {}),
      quality: {
        rhat: post.rhat ?? 0,
        ess: post.ess ?? 0,
        divergences: post.divergences ?? 0,
        evidence_grade: post.evidence_grade ?? 0,
        gate_passed: gatePassed,
      },
    };
    upsertModelVars(p, entry);
  } else if (Array.isArray(p.model_vars)) {
    const filtered = p.model_vars.filter((e: any) => e?.source !== 'bayesian');
    if (filtered.length === 0) {
      delete p.model_vars;
    } else if (filtered.length !== p.model_vars.length) {
      p.model_vars = filtered;
    }
  }

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
