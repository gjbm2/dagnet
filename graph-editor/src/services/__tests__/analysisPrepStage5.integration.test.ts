/**
 * Stage 5 blind tests — doc 73e §8.3 Stage 5 item 1.
 *
 * Two invariants pinned ahead of the Stage 5 implementation:
 *
 *   (1) Fixed-mode DSL is baked absolute. When a chart recipe is in fixed
 *       mode, its `effective_dsl` MUST flow through preparation unchanged —
 *       it must not be rebased over `currentDSL` with `augmentDSLWithConstraint`.
 *       Custom mode (the default) still combines current + delta.
 *
 *   (2) Scenario-pack extraction stays sparse. After FE topo + CF have run on
 *       an isolated scenario graph (i.e. the graph carries `model_vars`,
 *       `_posteriorSlices`, `_bayes_evidence`, and `_bayes_priors`), the
 *       params `extractDiffParams` produces for replay must NOT capture any
 *       of those re-derivable / request-only fields. Replay re-derives them
 *       from graph + parameter-file state.
 */

import { describe, it, expect } from 'vitest';
import {
  prepareAnalysisComputeInputs,
  type PreparedAnalysisComputeReady,
} from '../analysisComputePreparationService';
import { extractDiffParams } from '../GraphParamExtractor';

function makeBareGraph() {
  return {
    nodes: [
      { uuid: 'n1', id: 'a', entry: { is_start: true } },
      { uuid: 'n2', id: 'b', absorbing: true },
    ],
    edges: [
      {
        uuid: 'e1',
        id: 'e1',
        from: 'n1',
        to: 'n2',
        p: { id: 'edge-1-param', mean: 0.25, type: 'probability' as const },
      },
    ],
    policies: { default_outcome: 'end' as const },
    metadata: { version: '1.0.0' },
  };
}

describe('Stage 5 blind: fixed-mode DSL is baked absolute', () => {
  it('uses scenario.effective_dsl absolute when analysisMode === "fixed" — does not inherit currentDSL clauses', async () => {
    // The recipe carries only a context() clause. In fixed mode, the
    // recipe is the whole DSL — currentDSL's window() must NOT bleed in.
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      analysisMode: 'fixed',
      graph: makeBareGraph() as any,
      analysisType: 'graph_overview',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: 'window(-30d:0)',
      needsSnapshots: false,
      customScenarios: [
        {
          scenario_id: 'fixed-scenario',
          name: 'Fixed',
          colour: '#4caf50',
          visibility_mode: 'f+e',
          effective_dsl: 'context(channel:google)',
        },
      ],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
    } as any);

    expect(prepared.status).toBe('ready');
    const ready = prepared as PreparedAnalysisComputeReady;
    expect(ready.scenarios).toHaveLength(1);
    const dsl = ready.scenarios[0].effective_query_dsl;
    // Fixed mode: the recipe DSL is final. currentDSL's window() does
    // not get rebased over the recipe.
    expect(dsl).toContain('context(channel:google)');
    expect(dsl).not.toContain('window');
  });

  it('still combines current + scenario.effective_dsl when analysisMode is omitted (custom default)', async () => {
    const prepared = await prepareAnalysisComputeInputs({
      mode: 'custom',
      graph: makeBareGraph() as any,
      analysisType: 'graph_overview',
      analyticsDsl: 'from(a).to(b)',
      currentDSL: 'window(-30d:0)',
      needsSnapshots: false,
      customScenarios: [
        {
          scenario_id: 'custom-scenario',
          name: 'Custom',
          colour: '#2196f3',
          visibility_mode: 'f+e',
          effective_dsl: 'context(channel:google)',
        },
      ],
      hiddenScenarioIds: [],
      frozenWhatIfDsl: null,
    } as any);

    expect(prepared.status).toBe('ready');
    const ready = prepared as PreparedAnalysisComputeReady;
    const dsl = ready.scenarios[0].effective_query_dsl;
    // Custom mode: window() from currentDSL is inherited because the
    // recipe's context() clause does not displace it.
    expect(dsl).toContain('window(-30d:0)');
    expect(dsl).toContain('context(channel:google)');
  });
});

describe('Stage 5 blind: scenario packs stay sparse after FE topo + CF', () => {
  it('extractDiffParams drops model_vars, _posteriorSlices, _bayes_evidence, _bayes_priors', () => {
    const baseGraph: any = {
      nodes: [{ uuid: 'A', id: 'A' }, { uuid: 'B', id: 'B' }],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          p: {
            mean: 0.25,
            stdev: 0.03,
            n: 100,
            posterior: { alpha: 1, beta: 3 },
          },
        },
      ],
    };

    // After FE topo + CF + engorgement, the scenario graph carries:
    //   - p.model_vars (analytic + bayesian entries — re-derivable)
    //   - p._posteriorSlices (request-only engorgement payload)
    //   - edge._bayes_evidence / edge._bayes_priors (request-only)
    //   - p.mean updated by CF
    const enrichedGraph: any = {
      nodes: [{ uuid: 'A', id: 'A' }, { uuid: 'B', id: 'B' }],
      edges: [
        {
          uuid: 'e1',
          id: 'e1',
          from: 'A',
          to: 'B',
          // Engorged request-only fields that must not leak into packs.
          _bayes_evidence: { observed_n: 200, observed_k: 60 },
          _bayes_priors: { alpha_pred: 5.5, beta_pred: 17.6 },
          p: {
            mean: 0.27, // CF-updated
            stdev: 0.03,
            n: 200,
            posterior: { alpha: 5, beta: 17 },
            // FE topo Step 2 outputs.
            model_vars: [
              { source: 'analytic', latency: { mu: 1.85, sigma: 0.32 } },
              { source: 'bayesian', latency: { mu_mean: 1.85, mu_sd: 0.05 } },
            ],
            // Engorgement library — request-only.
            _posteriorSlices: {
              fingerprint: 'fp-current',
              slices: { 'window()': { alpha: 5, beta: 17 } },
            },
          },
        },
      ],
    };

    const diff = extractDiffParams(enrichedGraph, baseGraph);
    const edgeDiff = diff.edges?.['e1'];

    // Sparse-replay invariants: re-derivable + request-only fields must not
    // appear in the captured params.
    expect((edgeDiff?.p as any)?.model_vars).toBeUndefined();
    expect((edgeDiff?.p as any)?._posteriorSlices).toBeUndefined();
    expect((edgeDiff as any)?._bayes_evidence).toBeUndefined();
    expect((edgeDiff as any)?._bayes_priors).toBeUndefined();

    // Sanity: the actual scenario-visible diff (n + posterior.alpha)
    // is still captured so replay can rebuild the layered surface.
    expect(edgeDiff?.p?.n).toBe(200);
    expect(edgeDiff?.p?.posterior?.alpha).toBe(5);
  });
});
