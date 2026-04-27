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

import type { Graph, Posterior } from '../types';
import {
  projectProbabilityPosterior,
  projectLatencyPosterior,
  resolveAsatPosterior,
} from './posteriorSliceResolution';
import { parseConstraints } from '../lib/queryDSL';

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
    // projection alone (legacy `reprojectPosteriorForDsl` and Flow F
    // both treated "no file posterior" as a no-op rather than a wipe).
    // Engorgement still clears, so a stale stash from an earlier file
    // version doesn't leak onto this request graph.
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
    // strictly (matching the legacy `reprojectPosteriorForDsl` semantics
    // for the asat case in doc 27 §5.2).
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

/**
 * Context the live edge in place. Convenience wrapper around
 * `contextGraphForEffectiveDsl` with `engorgeFitHistory` forced off —
 * the live edge never carries out-of-schema fields per §3.2a.
 *
 * Used by Stage 4(e) to refresh the live graph on `currentDSL` change.
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
}
